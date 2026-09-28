import { SYSTEM_ERROR_CODES, rpcFrameSchema } from "@novacode/shared";
import type { RequestFrame } from "@novacode/shared";
import { RpcCallError } from "./client.js";
import { formatZodIssues, isDevMode } from "./validate.js";
import type { IMessageTransport, RpcFrame, Unsubscribe } from "./transport.js";

/**
 * 服务端绑定（04-architecture §4.1）：方法表（schema + handler）与事件出口。
 *
 * - zod 边界单点校验（04 §4.3）：每个方法的入参 schema 注册在方法表，handler 执行前校验一次；
 *   失败统一返回 INVALID_PARAMS + details.issues（06 §4.1）。
 * - 握手门禁（06 §1.4）：system.ping 成功前，其他方法一律回 VERSION_MISMATCH。
 * - 帧方向（06 §1.1）：服务端只应收到 request；response/event 到达服务端即协议违例，丢弃并告警。
 * - publish 为 fire-and-forget（at-most-once，06 §3.3），发送失败仅 stderr 告警不上抛。
 */

export interface CallContext {
  // 预留：后续波次按需扩展（如 abort signal、会话信息）；walking skeleton 阶段无额外上下文。
}

export interface RpcMethodHandler {
  /** 入口单点校验 schema（真源 @novacode/shared，04 §4.3 / ADR-07）。 */
  schema: import("zod").ZodTypeAny;
  handler: (params: unknown, ctx: CallContext) => Promise<unknown>;
}

export interface RpcServiceBinding {
  readonly transport: IMessageTransport;
  readonly methods: Record<string, RpcMethodHandler>;
  /** session.event.* 出口（04 §4.1）。 */
  publish(event: { name: string; payload: unknown }): void;
  /** 停止受理帧（不影响 transport 生命周期，由持有方负责 close）。 */
  close(): void;
}

export interface CreateServiceBindingOptions {
  /** 方法表（method → {schema, handler}）；可在创建后继续向该记录登记方法。 */
  methods?: Record<string, RpcMethodHandler>;
  /** 握手门禁开关，默认开启（06 §1.4）。 */
  requireHandshake?: boolean;
  /** 开发模式断言开关（帧结构校验）；缺省 = process.env.NODE_ENV !== "production"。 */
  devAssert?: boolean;
}

export function createServiceBinding(
  transport: IMessageTransport,
  options: CreateServiceBindingOptions = {},
): RpcServiceBinding {
  const methods = options.methods ?? {};
  const requireHandshake = options.requireHandshake ?? true;
  const devAssert = isDevMode(options.devAssert);

  let closed = false;
  let handshaken = false;

  function sendResponse(
    id: string,
    ok: boolean,
    result?: unknown,
    error?: { code: string; message: string; details?: unknown },
  ): void {
    if (transport.isClosed) return;
    const frame: RpcFrame = ok
      ? { kind: "response", id, ok: true, result }
      : { kind: "response", id, ok: false, error: error ?? { code: SYSTEM_ERROR_CODES.INTERNAL, message: "internal error" } };
    transport.send(frame);
  }

  async function handleRequest(frame: RequestFrame): Promise<void> {
    if (requireHandshake && !handshaken && frame.method !== "system.ping") {
      sendResponse(frame.id, false, undefined, {
        code: SYSTEM_ERROR_CODES.VERSION_MISMATCH,
        message: "handshake required: the first request must be system.ping",
      });
      return;
    }
    const method = methods[frame.method];
    if (!method) {
      sendResponse(frame.id, false, undefined, {
        code: SYSTEM_ERROR_CODES.METHOD_NOT_FOUND,
        message: `method not registered: ${frame.method}`,
      });
      return;
    }
    // 服务端入口单点校验（04 §4.3）：parse 产生结构副本，与跨进程绑定行为一致（06 §6.2）
    const parsed = method.schema.safeParse(frame.params);
    if (!parsed.success) {
      sendResponse(frame.id, false, undefined, {
        code: SYSTEM_ERROR_CODES.INVALID_PARAMS,
        message: `invalid params for ${frame.method}`,
        details: { issues: formatZodIssues(parsed.error) },
      });
      return;
    }
    try {
      const result = await method.handler(parsed.data, {});
      if (frame.method === "system.ping") handshaken = true;
      sendResponse(frame.id, true, result);
    } catch (err) {
      // 业务错误码传播（06 §4.3）：handler 抛 RpcCallError 时按其 code/message/details 应答，
      // 使 SESSION_NOT_FOUND 等业务码可结构化到达端层；其余异常维持 INTERNAL（最小改动，向后兼容）。
      if (err instanceof RpcCallError) {
        sendResponse(frame.id, false, undefined, { code: err.code, message: err.message, details: err.details });
        return;
      }
      // 响应不携带内部错误细节（04 §5.3：错误信息先过脱敏）；诊断进 stderr
      console.error(`[novacode/rpc binding] handler failed for "${frame.method}"`, err);
      sendResponse(frame.id, false, undefined, {
        code: SYSTEM_ERROR_CODES.INTERNAL,
        message: "internal error",
      });
    }
  }

  function handleFrame(frame: RpcFrame): void {
    if (closed) return;
    if (devAssert) {
      // 帧结构断言（等价 stdio 绑定的 PARSE_ERROR 位置，06 §1.2 畸形帧规则）
      const parsed = rpcFrameSchema.safeParse(frame);
      if (!parsed.success) {
        console.error(
          "[novacode/rpc binding] malformed frame dropped",
          formatZodIssues(parsed.error),
        );
        return;
      }
    }
    if (frame.kind === "request") {
      void handleRequest(frame).catch((err) => {
        console.error("[novacode/rpc binding] failed to handle request frame", err);
      });
      return;
    }
    console.error(`[novacode/rpc binding] unexpected ${frame.kind} frame on server side, dropped`);
  }

  const unsubscribe: Unsubscribe = transport.onFrame(handleFrame);

  return {
    transport,
    methods,
    publish(event: { name: string; payload: unknown }): void {
      if (closed || transport.isClosed) return;
      try {
        transport.send({ kind: "event", name: event.name, payload: event.payload });
      } catch (err) {
        console.error("[novacode/rpc binding] failed to publish event", event.name, err);
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      unsubscribe();
    },
  };
}
