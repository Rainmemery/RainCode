import { SYSTEM_ERROR_CODES, rpcFrameSchema } from "@raincode/shared";
import type { RpcFrame } from "@raincode/shared";
import { DeltaWindow } from "./delta-window.js";
import type { DeltaFrame } from "./delta-window.js";
import type { IMessageTransport, Unsubscribe } from "./transport.js";

/**
 * websocket 绑定（T3.8 / 04-architecture §4.4 / 06-api-spec §6.1、§6.3）：
 * 每条 WS 文本消息一帧，帧结构与 stdio 完全一致（「传输无关」的试金石——帧协议与方法表零改动）。
 *
 * - 畸形帧按 06 §1.2 处理：可定位 id 则回 PARSE_ERROR response（server 角色），否则丢弃 + stderr
 *   告警，不断开（帧边界即消息边界，无 JSONL 行概念）；
 * - message.delta 走 50ms 批量窗口（06 §3.4 / §6.3 第 5 条，与 stdio 共用 delta-window.ts）；
 * - 帧方向不在此强制：服务侧由 createServiceBinding（只受理 request）、客户端由 createRpcClient
 *   （只受理 response/event）各自守卫，transport 只做编解码与投递；
 * - 心跳与空闲断开策略属宿主/端层（如 server WebHost 的 ws.ping 探活）——本类只随 socket 生命周期。
 *
 * 双面结构适配（rpc 零依赖：不引入「ws」包，由宿主注入 socket）：node「ws」WebSocket（EventEmitter
 * `on` 事件面，服务端连接与 node 客户端）与浏览器 WebSocket（`addEventListener` 事件面）均满足
 * WsSocketLike；两事件面都提供时 node 面优先。
 */

/** websocket 连接最小结构面（node「ws」WebSocket 与浏览器 WebSocket 的交集投影）。 */
export interface WsSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  /** node「ws」事件面。message 监听器收到 Buffer/ArrayBuffer/数组（文本帧一律转 utf8 字符串）。 */
  on?(event: "open" | "message" | "close" | "error", listener: (...args: unknown[]) => void): unknown;
  /** 浏览器事件面。message 事件的 data 为字符串（文本帧）。 */
  addEventListener?(
    type: "open" | "message" | "close" | "error",
    listener: (ev: { data?: unknown }) => void,
  ): unknown;
}

export interface WebSocketTransportOptions {
  socket: WsSocketLike;
  /** 帧方向角色（06 §1.1）：server = 畸形入帧可回 PARSE_ERROR；client = 一律丢弃 + 告警。缺省 server。 */
  role?: "server" | "client";
  /** delta 批量窗口毫秒（缺省 50；06 §6.3 广域网可经宿主调大）。 */
  deltaWindowMs?: number;
  /** 对端断开回调（宿主据此 detach binding / 端层据此触发重连补偿）。 */
  onSocketClose?: () => void;
}

export class WebSocketTransport implements IMessageTransport {
  readonly kind = "websocket" as const;

  private readonly socket: WsSocketLike;
  private readonly role: "server" | "client";
  private readonly listeners = new Set<(frame: RpcFrame) => void>();
  private readonly deltaWindow: DeltaWindow;
  private closed = false;

  constructor(options: WebSocketTransportOptions) {
    this.socket = options.socket;
    this.role = options.role ?? "server";
    this.deltaWindow = new DeltaWindow((frame) => this.writeFrame(frame), options.deltaWindowMs ?? 50);
    this.attach(options.onSocketClose);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  send(frame: RpcFrame): void {
    if (this.closed) {
      throw new Error("TRANSPORT_CLOSED: cannot send on a closed websocket transport");
    }
    if (frame.kind === "event" && frame.name === "message.delta") {
      this.deltaWindow.push(frame as unknown as DeltaFrame);
      return;
    }
    // 非 delta 帧（含边界事件/response）先 flush 窗口：边界事件不乱序于其前的 delta（06 §3.4）
    this.deltaWindow.flush();
    this.writeFrame(frame);
  }

  onFrame(listener: (frame: RpcFrame) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 优雅关闭：flush 待发帧后请求对端关闭（WS close 握手由 socket 承担）。 */
  async close(_reason?: string): Promise<void> {
    this.deltaWindow.flush();
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    try {
      this.socket.close(1000, "rpc transport closed");
    } catch (err) {
      console.error("[raincode/rpc websocket] failed to close socket", err);
    }
  }

  // ---------------------------------------------------------------------------

  /** socket 事件挂接（一次性；不主动退订——连接终结时 socket 同步收敛，且 closed 守卫使处理器幂等）。 */
  private attach(onSocketClose?: () => void): void {
    const handleMessage = (data: unknown): void => {
      if (this.closed) return;
      const text = toText(data);
      if (text !== null) this.dispatchMessage(text);
    };
    const handleClose = (): void => {
      if (this.closed) return;
      this.closed = true;
      this.listeners.clear();
      onSocketClose?.();
    };
    const handleError = (err: unknown): void => {
      console.error("[raincode/rpc websocket] socket error", err);
    };
    if (typeof this.socket.on === "function") {
      this.socket.on("message", handleMessage);
      this.socket.on("close", handleClose);
      this.socket.on("error", handleError);
    } else if (typeof this.socket.addEventListener === "function") {
      this.socket.addEventListener("message", (ev) => handleMessage(ev.data));
      this.socket.addEventListener("close", handleClose);
      this.socket.addEventListener("error", handleError);
    } else {
      throw new Error("websocket socket exposes neither on() nor addEventListener()");
    }
  }

  private dispatchMessage(message: string): void {
    const trimmed = message.trim();
    if (trimmed.length === 0) return; // 空帧忽略
    let frame: unknown;
    try {
      frame = JSON.parse(trimmed);
    } catch {
      this.rejectMalformed(trimmed, "message is not valid JSON");
      return;
    }
    const parsed = rpcFrameSchema.safeParse(frame);
    if (!parsed.success) {
      this.rejectMalformed(trimmed, "frame structure invalid");
      return;
    }
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(parsed.data);
      } catch (err) {
        console.error("[raincode/rpc websocket] frame listener threw", err);
      }
    }
  }

  /** 畸形帧处置（06 §1.2）：server 角色可定位 id 回 PARSE_ERROR；client 角色一律丢弃 + 告警。 */
  private rejectMalformed(message: string, why: string): void {
    if (this.role === "client") {
      console.error(`[raincode/rpc websocket] malformed frame dropped (${why}): ${truncateForLog(message)}`);
      return;
    }
    const id = extractFrameId(message);
    if (id === null) {
      console.error(`[raincode/rpc websocket] malformed message dropped (${why}): ${truncateForLog(message)}`);
      return;
    }
    console.error(`[raincode/rpc websocket] malformed frame for id "${id}" (${why})`);
    this.writeFrame({
      kind: "response",
      id,
      ok: false,
      error: { code: SYSTEM_ERROR_CODES.PARSE_ERROR, message: `malformed frame: ${why}` },
    });
  }

  private writeFrame(frame: RpcFrame): void {
    if (this.closed) return;
    try {
      this.socket.send(JSON.stringify(frame));
    } catch (err) {
      console.error("[raincode/rpc websocket] failed to send frame", err);
    }
  }
}

/** node「ws」message 载荷（Buffer/ArrayBuffer/数组）→ utf8 字符串；浏览器事件面为字符串直通。 */
function toText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (Array.isArray(data)) {
    return data.map((part) => toText(part) ?? "").join("");
  }
  if (data instanceof Uint8Array) {
    return new TextDecoder("utf8").decode(data);
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder("utf8").decode(new Uint8Array(data));
  }
  return null;
}

/** 畸形帧宽松提取 id（JSON.parse 失败时的兜底定位；仅接受字符串形态 id）。 */
function extractFrameId(message: string): string | null {
  try {
    const obj = JSON.parse(message) as { id?: unknown };
    if (obj !== null && typeof obj === "object" && typeof obj.id === "string") {
      return obj.id;
    }
  } catch {
    // fallthrough to regex
  }
  const match = /"id"\s*:\s*"([^"]+)"/.exec(message);
  return match?.[1] ?? null;
}

function truncateForLog(message: string, max = 200): string {
  return message.length > max ? `${message.slice(0, max)}…` : message;
}
