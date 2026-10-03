/**
 * Turn 循环的事件出口与持久化通道（从 SessionTurnLoop 拆出，保持单文件 ≤500 行）。
 *
 * - 持久事件：payload 经 shared 构造函数生成（出口即合法），先落 JSONL 再发布（事实先行）；
 *   写入失败仅告警——事件持久化非关键路径，真源兜底由 message/checkpoint 行承担；
 * - 瞬态事件（message.delta / tool_call.progress）：seq 递增但不落盘（05-database §4.2）；
 * - 全部 JSONL 写入经单写者链串行（SessionStream 并发追加会错序 seq）。
 */
import {
  buildDoneEvent,
  buildErrorEvent,
  buildMessageCompletedEvent,
  buildMessageDeltaEvent,
  buildTurnPhaseChangedEvent,
} from "@raincode/shared";
import type { TokenUsage, TurnPhase } from "@raincode/shared";
import type { StoragePort, SessionEventPublisher } from "../ports.js";
import { parseLooseJson } from "./round-helpers.js";

/** 落 JSONL 的事件名（message 行 / checkpoint 由调用方经 serialWrite 直写）。 */
export type PersistedEventName =
  | "turn.phase_changed"
  | "message.completed"
  | "tool_call.started"
  | "tool_call.completed"
  | "permission.requested"
  | "permission.resolved"
  | "compact.started"
  | "compact.completed"
  | "done"
  | "error";

/** 瞬态事件名（不落盘）。 */
export type TransientEventName = "message.delta" | "tool_call.progress";

export interface LoopEventsOptions {
  sessionId: string;
  storage: StoragePort;
  publish: SessionEventPublisher;
  onDiagnostic?: (message: string, err?: unknown) => void;
}

export class LoopEvents {
  private eventSeq: number;
  private writeTail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly options: LoopEventsOptions,
    initialEventSeq = 0,
  ) {
    this.eventSeq = initialEventSeq;
  }

  /** 已发布的最大 rpc 事件 seq（session.snapshot.lastSeq 数据源）。 */
  get lastEventSeq(): number {
    return this.eventSeq;
  }

  nextSeq(): number {
    this.eventSeq += 1;
    return this.eventSeq;
  }

  /** 全部 JSONL 写入经单写者链串行。 */
  serialWrite<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeTail.then(task, task);
    this.writeTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * 排空单写者链（T4.2 flush-then-close）：resolve 时「调用 flush 前入队」的持久化任务已全部落盘。
   * 契约：生产方停发后调用（turn 终态/已取消）——运行中 turn 会持续入队，flush 不构成静止点。
   * 返回的 promise 永不 reject（链内失败已在各任务出口消化为 diag 告警）。
   */
  flush(): Promise<void> {
    return this.writeTail.then(() => undefined);
  }

  /** 持久事件：先落 JSONL 再发布（事实先行）。 */
  emitPersisted(name: PersistedEventName, build: (seq: number, ts: number) => unknown): void {
    const seq = this.nextSeq();
    const ts = Date.now();
    const payload = build(seq, ts);
    void this.serialWrite(async () => {
      const result = await this.options.storage.appendEvent(this.options.sessionId, name, payload);
      if (!result.accepted) this.diag(`event "${name}" rejected (stale epoch)`);
    }).catch((err: unknown) => this.diag(`failed to persist event "${name}"`, err));
    this.options.publish({ name, payload });
  }

  /** 瞬态事件：只发布不落盘。 */
  publishTransient(name: TransientEventName, build: (seq: number, ts: number) => unknown): void {
    this.options.publish({ name, payload: build(this.nextSeq(), Date.now()) });
  }

  publishDelta(turnId: string, round: number, kind: "text" | "reasoning", text: string): void {
    this.publishTransient("message.delta", (seq, ts) =>
      buildMessageDeltaEvent({
        seq,
        ts,
        sessionId: this.options.sessionId,
        turnId,
        round,
        delta: { type: kind, text },
      }),
    );
  }

  emitTurnPhaseChanged(turnId: string, from: TurnPhase, to: TurnPhase): void {
    this.emitPersisted("turn.phase_changed", (seq, ts) =>
      buildTurnPhaseChangedEvent({ seq, ts, sessionId: this.options.sessionId, turnId, from, to }),
    );
  }

  emitMessageCompleted(
    turnId: string,
    round: number,
    content: string,
    toolCalls: Array<{ toolCallId: string; toolName: string; argumentsJSON: string }> | undefined,
    usage: TokenUsage | undefined,
  ): void {
    const stopReason = toolCalls !== undefined ? ("tool_calls" as const) : ("stop" as const);
    this.emitPersisted("message.completed", (seq, ts) =>
      buildMessageCompletedEvent({
        seq,
        ts,
        sessionId: this.options.sessionId,
        turnId,
        round,
        message: {
          role: "assistant",
          content,
          ...(toolCalls !== undefined && {
            toolCalls: toolCalls.map((call) => ({
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              args: parseLooseJson(call.argumentsJSON),
            })),
          }),
          stopReason,
          ...(usage !== undefined && { usage }),
        },
      }),
    );
  }

  emitDone(
    turnId: string,
    fields: {
      outcome: "completed" | "cancelled" | "failed";
      at?: TurnPhase;
      usage?: TokenUsage;
      rounds?: number;
    },
  ): void {
    this.emitPersisted("done", (seq, ts) =>
      buildDoneEvent({ seq, ts, sessionId: this.options.sessionId, turnId, ...fields }),
    );
  }

  emitError(turnId: string, code: string, message: string): void {
    this.emitPersisted("error", (seq, ts) =>
      buildErrorEvent({
        seq,
        ts,
        sessionId: this.options.sessionId,
        turnId,
        scope: "turn",
        code,
        message,
        recoverable: true,
      }),
    );
  }

  diag(message: string, err?: unknown): void {
    const sink = this.options.onDiagnostic ?? console.error;
    sink(`[raincode/agent-core ${this.options.sessionId}] ${message}`, err ?? "");
  }
}
