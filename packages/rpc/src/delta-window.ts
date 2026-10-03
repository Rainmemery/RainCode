import type { MessageDeltaEventPayload, RpcFrame } from "@raincode/shared";

/**
 * message.delta 批量窗口（06 §3.4，T2.8 自 stdio 抽出供 websocket 绑定共用）：
 * 同 turn 同 round 同类型 delta 在窗口内合并（text/argsPartial 拼接、seq/ts 取最新、
 * tool_call id/name 以最新非空为准、tool_call 另按 index 分桶）；其余帧发送前先 flush
 * 窗口（边界事件不乱序于其前的 delta）。emit 为宿主注入的物理发送函数（stdout write /
 * ws.send），本类不感知传输载体。
 */

export const DELTA_BATCH_WINDOW_MS = 50; // 06 §3.4：message.delta 批量窗口上限

/** message.delta 事件的窄化帧形态（RpcFrame 事件臂 payload 为 unknown，此处以 shared schema 收窄）。 */
export type DeltaFrame = {
  kind: "event";
  name: "message.delta";
  payload: MessageDeltaEventPayload;
};

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

export class DeltaWindow {
  private readonly queue: DeltaFrame[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly emit: (frame: RpcFrame) => void,
    private readonly windowMs: number,
  ) {}

  push(frame: DeltaFrame): void {
    const tail = this.queue[this.queue.length - 1];
    if (tail !== undefined && this.mergeable(tail, frame)) {
      mergeDeltaInto(tail, frame);
      return;
    }
    this.queue.push(frame);
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, this.windowMs);
    }
  }

  /** 清空窗口并物理发送（非 delta 帧发送前 / close 前调用，保证边界不乱序）。 */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const pending = this.queue.splice(0, this.queue.length);
    for (const frame of pending) {
      this.emit(frame);
    }
  }

  /** 队尾桶同键可合并（06 §3.4：窗口合并同 turn 同类型 delta）；非同键返回 false。 */
  private mergeable(tail: DeltaFrame, incoming: DeltaFrame): boolean {
    const a = tail.payload;
    const b = incoming.payload;
    const da = a.delta;
    const db = b.delta;
    if (a.turnId !== b.turnId || a.round !== b.round) return false;
    if (da.type !== db.type) return false;
    if (da.type === "tool_call" && db.type === "tool_call" && da.index !== db.index) return false;
    return true;
  }
}
