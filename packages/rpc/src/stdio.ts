import { StringDecoder } from "node:string_decoder";
import { SYSTEM_ERROR_CODES, rpcFrameSchema } from "@raincode/shared";
import type { MessageDeltaEventPayload, RpcFrame } from "@raincode/shared";
import type { IMessageTransport, Unsubscribe } from "./transport.js";

/**
 * stdio 绑定（04-architecture §4.4 / 06-api-spec §1.3、§3.4）：
 * stdin/stdout 每行一帧 JSONL（\n 分隔）；stdout 只承载协议帧，诊断日志走 stderr。
 *
 * - 畸形行按 06 §1.2 处理：可定位 id 则回 PARSE_ERROR response，否则丢弃 + stderr 告警，不断开；
 * - message.delta 走 50ms 批量窗口（06 §3.4）：同 turn 同 round 同类型合并（text/argsPartial 拼接，
 *   取最新 seq/ts）；其余帧发送前先 flush 窗口（边界事件不乱序于其前的 delta）；
 * - close：flush 待发帧后标记关闭；stdin end 经 onInputEnd 回调通知持有方（transport 保持可写，
 *   在途响应 flush 后由持有方 close，避免丢帧）。
 *
 * 流经构造参数注入（缺省 process.stdin/stdout），供单测以内存流驱动（ADR-08 可调试性：
 * 线上帧形态与人工 cat 调试完全一致）。
 */

const DELTA_BATCH_WINDOW_MS = 50; // 06 §3.4：message.delta 批量窗口上限

/** message.delta 事件的窄化帧形态（RpcFrame 事件臂 payload 为 unknown，此处以 shared schema 收窄）。 */
type DeltaFrame = {
  kind: "event";
  name: "message.delta";
  payload: MessageDeltaEventPayload;
};

/** delta 合并键：同 turn 同 round 同 delta 形态（tool_call 另按 index 分桶）。 */
interface DeltaBucket {
  frame: DeltaFrame;
}

/** 窗口合并（06 §3.4）：text/argsPartial 拼接，seq/ts 取最新，tool_call id/name 以最新非空为准。 */
function mergeDeltaInto(target: DeltaFrame, incoming: DeltaFrame): void {
  const da = target.payload.delta;
  const db = incoming.payload.delta;
  const mergedToolCall =
    da.type === "tool_call" && db.type === "tool_call"
      ? (() => {
          const toolCallId = db.toolCallId ?? da.toolCallId;
          const toolName = db.toolName ?? da.toolName;
          return {
            type: "tool_call" as const,
            index: da.index,
            ...(toolCallId !== undefined && { toolCallId }),
            ...(toolName !== undefined && { toolName }),
            argsPartial: (da.argsPartial ?? "") + (db.argsPartial ?? ""),
          };
        })()
      : null;
  const merged: MessageDeltaEventPayload = {
    ...incoming.payload, // seq/ts 取最新到达
    turnId: target.payload.turnId,
    round: target.payload.round,
    delta:
      mergedToolCall ??
      {
        type: da.type as "text" | "reasoning",
        text: (da as { text: string }).text + (db as { text: string }).text,
      },
  };
  target.payload = merged;
}

export interface StdioTransportOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  /** delta 批量窗口毫秒（缺省 50；测试可缩短）。 */
  deltaWindowMs?: number;
  /** stdin end/error（宿主断开）回调；transport 不自动关闭——在途响应 flush 由持有方决定后调用 close()。 */
  onInputEnd?: () => void;
}

export class StdioTransport implements IMessageTransport {
  readonly kind = "stdio" as const;

  private readonly input: NodeJS.ReadableStream;
  private readonly output: NodeJS.WritableStream;
  private readonly deltaWindowMs: number;
  private readonly listeners = new Set<(frame: RpcFrame) => void>();
  private readonly decoder = new StringDecoder("utf8"); // 多字节字符跨 chunk 安全分帧
  private lineBuffer = "";
  private readonly deltaQueue: DeltaBucket[] = [];
  private deltaTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private outputEnded = false;

  constructor(private readonly options: StdioTransportOptions = {}) {
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
    this.deltaWindowMs = options.deltaWindowMs ?? DELTA_BATCH_WINDOW_MS;
    this.input.on("data", (chunk: Buffer | string) => this.onData(chunk));
    this.input.on("end", () => {
      this.dispatchLine(this.decoder.end()); // 半行残尾按畸形处置（06 §1.2 dangling）
      this.options.onInputEnd?.();
    });
    this.input.on("error", (err: Error) => {
      console.error("[raincode/rpc stdio] input stream error", err);
      this.options.onInputEnd?.();
    });
    this.output.on("error", (err: Error) => {
      console.error("[raincode/rpc stdio] output stream error", err);
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  send(frame: RpcFrame): void {
    if (this.closed || this.outputEnded) {
      throw new Error("TRANSPORT_CLOSED: cannot send on a closed stdio transport");
    }
    if (frame.kind === "event" && frame.name === "message.delta") {
      this.enqueueDelta(frame as unknown as DeltaFrame);
      return;
    }
    // 非 delta 帧（含边界事件/response）先 flush 窗口：边界事件不乱序于其前的 delta（06 §3.4）
    this.flushDeltas();
    this.writeFrame(frame);
  }

  onFrame(listener: (frame: RpcFrame) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async close(_reason?: string): Promise<void> {
    this.flushDeltas();
    if (!this.closed) {
      this.closed = true;
      this.lineBuffer = "";
      this.listeners.clear();
    }
    if (!this.outputEnded && typeof (this.output as NodeJS.WriteStream).end === "function") {
      this.outputEnded = true;
      (this.output as NodeJS.WriteStream).end();
    }
  }

  // ---------------------------------------------------------------------------

  private onData(chunk: Buffer | string): void {
    if (this.closed) return;
    this.lineBuffer += this.decoder.write(chunk);
    let idx = this.lineBuffer.indexOf("\n");
    while (idx !== -1) {
      const line = this.lineBuffer.slice(0, idx);
      this.lineBuffer = this.lineBuffer.slice(idx + 1);
      this.dispatchLine(line);
      idx = this.lineBuffer.indexOf("\n");
    }
  }

  private dispatchLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return; // 空行忽略（cat 粘贴尾换行等）
    let frame: unknown;
    try {
      frame = JSON.parse(trimmed);
    } catch {
      this.rejectMalformed(trimmed, "line is not valid JSON");
      return;
    }
    const parsed = rpcFrameSchema.safeParse(frame);
    if (!parsed.success) {
      this.rejectMalformed(trimmed, "frame structure invalid");
      return;
    }
    if (parsed.data.kind !== "request") {
      // 帧方向（06 §1.1）：服务端只应收到 request；response/event 到达即协议违例，丢弃并告警
      console.error(`[raincode/rpc stdio] unexpected ${parsed.data.kind} frame on server side, dropped`);
      return;
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(parsed.data);
      } catch (err) {
        console.error("[raincode/rpc stdio] frame listener threw", err);
      }
    }
  }

  /** 畸形行处置（06 §1.2）：可定位 id 回 PARSE_ERROR response，否则丢弃 + 告警，不断开。 */
  private rejectMalformed(line: string, why: string): void {
    const id = extractFrameId(line);
    if (id === null) {
      console.error(`[raincode/rpc stdio] malformed line dropped (${why}): ${truncateForLog(line)}`);
      return;
    }
    console.error(`[raincode/rpc stdio] malformed frame for id "${id}" (${why})`);
    this.writeFrame({
      kind: "response",
      id,
      ok: false,
      error: { code: SYSTEM_ERROR_CODES.PARSE_ERROR, message: `malformed frame: ${why}` },
    });
  }

  private enqueueDelta(frame: DeltaFrame): void {
    const bucket = this.mergeableBucket(frame);
    if (bucket !== null) {
      mergeDeltaInto(bucket.frame, frame);
      return;
    }
    this.deltaQueue.push({ frame });
    if (this.deltaTimer === null) {
      this.deltaTimer = setTimeout(() => {
        this.deltaTimer = null;
        this.flushDeltas();
      }, this.deltaWindowMs);
    }
  }

  /** 队尾桶同键可合并（06 §3.4：窗口合并同 turn 同类型 delta）；非同键返回 null。 */
  private mergeableBucket(incoming: DeltaFrame): DeltaBucket | null {
    const tail = this.deltaQueue[this.deltaQueue.length - 1];
    if (tail === undefined) return null;
    const a = tail.frame.payload;
    const b = incoming.payload;
    const da = a.delta;
    const db = b.delta;
    if (a.turnId !== b.turnId || a.round !== b.round) return null;
    if (da.type !== db.type) return null;
    if (da.type === "tool_call" && db.type === "tool_call" && da.index !== db.index) return null;
    return tail;
  }

  private flushDeltas(): void {
    if (this.deltaTimer !== null) {
      clearTimeout(this.deltaTimer);
      this.deltaTimer = null;
    }
    const queue = this.deltaQueue.splice(0, this.deltaQueue.length);
    for (const bucket of queue) {
      this.writeFrame(bucket.frame);
    }
  }

  private writeFrame(frame: RpcFrame): void {
    if (this.closed || this.outputEnded) return;
    try {
      (this.output as NodeJS.WriteStream).write(`${JSON.stringify(frame)}\n`);
    } catch (err) {
      console.error("[raincode/rpc stdio] failed to write frame", err);
    }
  }
}

/** 畸形行宽松提取 id（JSON.parse 失败时的兜底定位；仅接受字符串形态 id）。 */
function extractFrameId(line: string): string | null {
  try {
    const obj = JSON.parse(line) as { id?: unknown };
    if (obj !== null && typeof obj === "object" && typeof obj.id === "string") {
      return obj.id;
    }
  } catch {
    // fallthrough to regex
  }
  const match = /"id"\s*:\s*"([^"]+)"/.exec(line);
  return match?.[1] ?? null;
}

function truncateForLog(line: string, max = 200): string {
  return line.length > max ? `${line.slice(0, max)}…` : line;
}
