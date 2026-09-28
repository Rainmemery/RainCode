import {
  EVENT_SCHEMAS,
  METHOD_SCHEMAS,
  SYSTEM_ERROR_CODES,
} from "@novacode/shared";
import type { ZodError } from "zod";
import { formatZodIssues } from "./validate.js";
import type { IMessageTransport, RpcFrame, Unsubscribe } from "./transport.js";

/**
 * RpcClient（04-architecture §4.1）：请求-响应模式（id 关联 + 超时）+ 事件订阅模式。
 *
 * 帧处理规则（06-api-spec §1.2）：
 * - 串行不阻塞：等待某个 response 时不停止处理后续帧（事件与 response 共用通道）；
 * - 收到未知 id 的 response 丢弃并告警（多为超时后的迟到应答）；
 * - 端层不校验业务参数（04 §4.3），出口校验仅为开发模式断言（NODE_ENV !== production），生产关闭。
 */

const DEFAULT_TIMEOUT_MS = 10_000; // 06 §2.0：客户端默认超时 10s

/** RPC 调用失败（远端 error 应答、本地超时或传输关闭），携带结构化错误码（06 §4）。 */
export class RpcCallError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "RpcCallError";
    this.code = code;
    this.details = details;
  }
}

export interface RpcClientCallOptions {
  /** 单次调用超时覆盖（06 §2.0：个别方法有专属上限）。 */
  timeoutMs?: number;
}

export interface RpcClient {
  /** 请求-响应：id 关联同步等待；超时或失败 reject RpcCallError。 */
  call<T>(method: string, params?: unknown, opts?: RpcClientCallOptions): Promise<T>;
  /** 事件订阅：按事件名分发；未知事件名整体忽略（06 §7.4）。 */
  onEvent(name: string, listener: (payload: unknown) => void): Unsubscribe;
  /** 停止受理帧并 reject 全部未决请求（不负责 transport.close，由持有方管理生命周期）。 */
  close(): void;
}

export interface RpcClientOptions {
  transport: IMessageTransport;
  /** 默认超时（毫秒），缺省 10s。 */
  defaultTimeoutMs?: number;
  /** 开发模式断言开关；缺省 = process.env.NODE_ENV !== "production"（04 §4.3）。 */
  devAssert?: boolean;
}

interface PendingRequest {
  method: string;
  resolve: (result: unknown) => void;
  reject: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function createRpcClient(options: RpcClientOptions): RpcClient {
  const { transport } = options;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const devAssert = options.devAssert ?? process.env["NODE_ENV"] !== "production";

  let nextSeq = 0;
  let closed = false;
  const pending = new Map<string, PendingRequest>();
  const eventListeners = new Map<string, Set<(payload: unknown) => void>>();

  function warn(...args: unknown[]): void {
    console.error("[novacode/rpc client]", ...args);
  }

  function rejectAllPending(err: RpcCallError): void {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    pending.clear();
  }

  function dispatchEvent(name: string, payload: unknown): void {
    const listeners = eventListeners.get(name);
    if (!listeners || listeners.size === 0) return; // 未知事件名整体忽略（06 §7.4）
    if (devAssert) {
      const schema = EVENT_SCHEMAS[name];
      if (schema) {
        const parsed = schema.safeParse(payload);
        if (!parsed.success) {
          warn(`event payload dev-assert failed for "${name}"`, formatZodIssues(parsed.error));
        }
      }
    }
    for (const listener of [...listeners]) {
      try {
        listener(payload);
      } catch (err) {
        warn(`event listener threw for "${name}"`, err);
      }
    }
  }

  function handleFrame(frame: RpcFrame): void {
    if (closed) return;
    if (frame.kind === "response") {
      const entry = pending.get(frame.id);
      if (!entry) {
        // 迟到应答或协议违例：丢弃并告警（06 §1.2 id 关联规则）
        warn(`dropped response with unknown id "${frame.id}"`);
        return;
      }
      pending.delete(frame.id);
      clearTimeout(entry.timer);
      if (frame.ok) {
        entry.resolve(frame.result);
      } else {
        entry.reject(
          new RpcCallError(
            frame.error?.code ?? SYSTEM_ERROR_CODES.INTERNAL,
            frame.error?.message ?? "unknown rpc error",
            frame.error?.details,
          ),
        );
      }
      return;
    }
    if (frame.kind === "event") {
      dispatchEvent(frame.name, frame.payload);
      return;
    }
    // 帧方向汇总（06 §1.1）：服务端不会向端层发起 request
    warn(`unexpected request frame received on client side: ${frame.method}`);
  }

  const unsubscribeTransport = transport.onFrame(handleFrame);

  async function call<T>(
    method: string,
    params?: unknown,
    opts?: RpcClientCallOptions,
  ): Promise<T> {
    if (closed || transport.isClosed) {
      throw new RpcCallError(
        SYSTEM_ERROR_CODES.TRANSPORT_CLOSED,
        `transport closed (kind=${transport.kind})`,
        { transportKind: transport.kind },
      );
    }
    if (devAssert) {
      // 客户端出口 dev 断言：方法已登记时校验出参结构；未登记则放行（未知容忍，06 §7.2）
      const registered = METHOD_SCHEMAS[method];
      if (registered) {
        const parsed = registered.request.safeParse(params);
        if (!parsed.success) {
          throw new RpcCallError(
            SYSTEM_ERROR_CODES.INVALID_PARAMS,
            `client exit validation failed for "${method}"`,
            { issues: formatZodIssues(parsed.error as ZodError) },
          );
        }
      }
    }
    const id = `req-${String(++nextSeq).padStart(6, "0")}`; // 06 §1.2：<prefix>-<自增序号>
    const timeoutMs = opts?.timeoutMs ?? defaultTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new RpcCallError(
            SYSTEM_ERROR_CODES.TIMEOUT,
            `request timed out after ${timeoutMs}ms`,
            { method, elapsedMs: timeoutMs },
          ),
        );
      }, timeoutMs);
      pending.set(id, {
        method,
        resolve: resolve as (result: unknown) => void,
        reject,
        timer,
      });
      try {
        transport.send({ kind: "request", id, method, params });
      } catch (err) {
        pending.delete(id);
        clearTimeout(timer);
        reject(
          new RpcCallError(
            SYSTEM_ERROR_CODES.TRANSPORT_CLOSED,
            err instanceof Error ? err.message : "failed to send request frame",
          ),
        );
      }
    });
  }

  function onEvent(name: string, listener: (payload: unknown) => void): Unsubscribe {
    let listeners = eventListeners.get(name);
    if (!listeners) {
      listeners = new Set();
      eventListeners.set(name, listeners);
    }
    const target = listeners;
    target.add(listener);
    return () => {
      target.delete(listener);
    };
  }

  function close(): void {
    if (closed) return;
    closed = true;
    unsubscribeTransport();
    rejectAllPending(new RpcCallError(SYSTEM_ERROR_CODES.TRANSPORT_CLOSED, "rpc client closed"));
    eventListeners.clear();
  }

  return { call, onEvent, close };
}
