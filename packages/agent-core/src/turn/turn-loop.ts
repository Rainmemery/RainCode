/**
 * SessionTurnLoop：单会话 Turn 循环（02-module-design §1 / 04-architecture §1.3）。
 *
 * - 单写者：一个循环实例同时只执行一个 turn；运行中 submit 经 CommandInbox 排队；
 * - 状态机：TurnPhase 子集（见 turn/phase.ts），每次合法迁移发 turn.phase_changed（06 §3.2）；
 * - turn 执行：用户输入落库 → 组装上下文（历史常驻内存）→ LlmPort 流式 → delta 50ms 批量节流
 *   发 message.delta（06 §3.4）→ 落库 assistant 行 → message.completed → writeCheckpoint → done；
 * - 持久化口径（05-database §4.2）：message 行与 turn.phase_changed / message.completed / done /
 *   error 事件落 JSONL；message.delta 为 UI 瞬态不落盘；
 * - 取消：T3（接纳段）/ T5+T8（请求与流式段），已产出正文落库不丢（02 §1.4）；
 * - steering（02 §1.2.1 正交通道）：本波留接口——运行中注入 steeringBuffer，顺延到下一次
 *   上下文组装合并（无多轮工具往返时即下一 turn；偏差见交付报告）。
 */
import { LlmAbortedError, LlmError } from "@novacode/llm";
import type { LlmStreamEvent } from "@novacode/llm";
import { ulid } from "@novacode/storage";
import type { CheckpointState } from "@novacode/storage";
import {
  buildDoneEvent,
  buildErrorEvent,
  buildMessageCompletedEvent,
  buildMessageDeltaEvent,
  buildTurnPhaseChangedEvent,
} from "@novacode/shared";
import type { MessageRecord, TokenUsage } from "@novacode/shared";
import { CommandInbox } from "../inbox/command-inbox.js";
import type { LlmPort, SessionEventPublisher, StoragePort } from "../ports.js";
import { assembleChatMessages } from "./context.js";
import { DeltaBatcher } from "./delta-batcher.js";
import { transitionPhase } from "./phase.js";
import type { TurnPhase, TurnTrigger } from "./phase.js";

/** message.delta 批量节流窗口（06 §3.4：≤50ms）。 */
const DEFAULT_DELTA_FLUSH_MS = 50;

export type TurnOutcome =
  | { status: "completed"; usage?: TokenUsage; rounds: number }
  | { status: "cancelled"; at: TurnPhase }
  | { status: "failed"; error: { code: string; message: string } };

export interface TurnInput {
  text: string;
  attachments?: Array<{ path: string; mediaType?: string }>;
}

/** submit 受理结果（06 §2.1 session.send：受理即返，turn 进展全部走事件）。 */
export interface TurnAdmission {
  turnId: string;
  admission: "started" | "queued";
  queuePosition?: number;
  done: Promise<TurnOutcome>;
}

export interface SessionTurnLoopOptions {
  sessionId: string;
  /** 协作模式（checkpoint state 透传；权限判定链属后续波次）。 */
  mode: "normal" | "plan" | "auto-accept";
  /** null = 未配置 Provider（turn 以 LLM_NOT_CONFIGURED 失败收束）。 */
  llm: LlmPort | null;
  storage: StoragePort;
  publish: SessionEventPublisher;
  systemPrompt?: string;
  /** resume 场景的既有历史（内存态重建，server 从 JSONL 重放取得）。 */
  initialHistory?: MessageRecord[];
  /** resume 场景的 rpc 事件 seq 续起点（best-effort，见 server 侧注释）。 */
  initialEventSeq?: number;
  deltaFlushMs?: number;
  /** 诊断出口（server 注入 stderr；默认 console.error）。 */
  onDiagnostic?: (message: string, err?: unknown) => void;
}

interface InboxEntry {
  turnId: string;
  input: TurnInput;
  resolve: (outcome: TurnOutcome) => void;
}

export class SessionTurnLoop {
  private _phase: TurnPhase = "Idle";
  private readonly inbox = new CommandInbox<InboxEntry>();
  private readonly history: MessageRecord[];
  private eventSeq: number;
  private readonly steeringBuffer: string[] = [];
  private running: InboxEntry | null = null;
  private pumping = false;
  private cancelRequested = false;
  private controller: AbortController | null = null;
  private writeTail: Promise<unknown> = Promise.resolve();
  private assistantText = "";

  constructor(private readonly options: SessionTurnLoopOptions) {
    this.history = [...(options.initialHistory ?? [])];
    this.eventSeq = options.initialEventSeq ?? 0;
  }

  get phase(): TurnPhase {
    return this._phase;
  }

  /** 已发布的最大 rpc 事件 seq（session.snapshot.lastSeq 数据源）。 */
  get lastEventSeq(): number {
    return this.eventSeq;
  }

  getHistory(): MessageRecord[] {
    return [...this.history];
  }

  /**
   * 接纳一条 turn.new 指令：空闲立即开 turn（started），运行中入队（queued）。
   * done 在 turn settle 完成后 resolve（永不 reject；结果同时经 done 事件推送）。
   */
  submit(input: TurnInput): TurnAdmission {
    const turnId = `turn_${ulid()}`;
    let resolve!: (outcome: TurnOutcome) => void;
    const done = new Promise<TurnOutcome>((resolvePromise) => {
      resolve = resolvePromise;
    });
    const entry: InboxEntry = { turnId, input, resolve };
    const { position } = this.inbox.enqueue(entry);
    const started =
      position === 1 && this.running === null && !this.pumping && this._phase === "Idle";
    if (started) {
      this.pump();
    }
    return {
      turnId,
      admission: started ? "started" : "queued",
      ...(started ? {} : { queuePosition: position }),
      done,
    };
  }

  /**
   * steering 正交通道（02 §1.2.3 turn.steer）：运行中注入 steeringBuffer（injected）；
   * 空闲按 turn.new 处理（started / queued）。
   */
  steer(text: string): "injected" | "started" | "queued" {
    if (this.running !== null || this._phase !== "Idle") {
      this.steeringBuffer.push(text);
      return "injected";
    }
    return this.submit({ text }).admission;
  }

  /** 取消当前 turn（06 §2.1 session.cancel：幂等——无运行中 turn 返回 cancelled:false）。 */
  cancel(_reason?: string): { cancelled: boolean; at?: TurnPhase } {
    if (this.running === null || this._phase === "Idle") {
      return { cancelled: false };
    }
    this.cancelRequested = true;
    this.controller?.abort();
    return { cancelled: true, at: this._phase };
  }

  // ---------------------------------------------------------------------------
  // 泵：单写者循环
  // ---------------------------------------------------------------------------

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    void this.pumpLoop().catch((err: unknown) => {
      this.pumping = false;
      this.diag("turn pump crashed", err);
    });
  }

  private async pumpLoop(): Promise<void> {
    for (;;) {
      const entry = this.inbox.dequeue();
      if (!entry) break;
      this.running = entry;
      await this.runTurn(entry);
      this.running = null;
    }
    this.pumping = false;
  }

  private async runTurn(entry: InboxEntry): Promise<void> {
    this.cancelRequested = false;
    this.assistantText = "";
    this.toPhase("Idle", "command.submitted", entry.turnId); // T1
    const controller = new AbortController();
    this.controller = controller;
    let outcome: TurnOutcome;
    try {
      outcome = await this.executeTurn(entry, controller);
    } catch (reason: unknown) {
      // 存储等基础设施异常：收敛到 failed 终态，防 inbox 死锁（02 §1.2.3 门在异常路径必须释放）
      this.diag("turn crashed", reason);
      outcome = await this.settleAbnormal(entry, "TURN_INTERNAL", errorMessage(reason));
    } finally {
      this.controller = null;
    }
    entry.resolve(outcome);
  }

  private async executeTurn(entry: InboxEntry, controller: AbortController): Promise<TurnOutcome> {
    // T2 前的接纳段：用户输入先落盘再发请求（04 §1.3 预算表顺序）
    const userRecord: MessageRecord = {
      id: `msg_${ulid()}`,
      role: "user",
      content: entry.input.text,
      ...(entry.input.attachments !== undefined && entry.input.attachments.length > 0
        ? { attachments: entry.input.attachments }
        : {}),
    };
    await this.serialWrite(() =>
      this.options.storage.appendMessage(this.options.sessionId, userRecord),
    );
    this.history.push(userRecord);

    if (this.cancelRequested) {
      return this.settleCancelledEarly(entry); // T3
    }

    const llm = this.options.llm;
    if (!llm) {
      return this.settleAbnormal(entry, "LLM_NOT_CONFIGURED", "no LLM client configured for this session");
    }

    const requestMessages = assembleChatMessages({
      systemPrompt: this.options.systemPrompt,
      history: this.history,
      steering: this.steeringBuffer,
    });
    this.steeringBuffer.length = 0;
    this.toPhase("ProcessingInput", "context.assembled", entry.turnId); // T2

    const round = 1; // 本波无工具往返（T13 多轮随工具系统波次启用）
    const batcher = new DeltaBatcher(this.options.deltaFlushMs ?? DEFAULT_DELTA_FLUSH_MS, (kind, text) =>
      this.publishDelta(entry.turnId, round, kind, text),
    );
    let finishReason: string | null = null;
    let usage: TokenUsage | undefined;
    let sawToolCallDelta = false;

    const onEvent = (event: LlmStreamEvent): void => {
      switch (event.type) {
        case "stream.opened":
          this.toPhase("ModelRequest", "stream.opened", entry.turnId); // T4
          break;
        case "delta.text":
          this.assistantText += event.text;
          batcher.add("text", event.text);
          break;
        case "delta.reasoning":
          batcher.add("reasoning", event.text);
          break;
        case "delta.tool_call":
          sawToolCallDelta = true;
          this.diag(`tool_call delta ignored (tool system arrives in a later wave): ${event.toolName ?? `#${String(event.index)}`}`);
          break;
        case "finish":
          finishReason = event.finishReason;
          break;
        case "usage":
          usage = event.usage;
          break;
        default:
          break; // role / done：映射表中的透传事件，骨架无需处理
      }
    };

    try {
      await llm.streamChat({
        messages: requestMessages,
        includeUsage: true,
        signal: controller.signal,
        onEvent,
      });
      batcher.flush(); // flush 边界：边界事件不乱序于其前的 delta（06 §3.4）
      if (finishReason === "tool_calls" || sawToolCallDelta) {
        return await this.settleFailed(
          entry,
          "TOOL_CALLS_UNSUPPORTED",
          "model requested tool calls, but the tool system is not part of the walking skeleton",
        );
      }
      return await this.settleCompleted(entry, this.assistantText, usage, round); // T7
    } catch (reason: unknown) {
      batcher.flush();
      if (reason instanceof LlmAbortedError || this.cancelRequested || controller.signal.aborted) {
        return await this.settleAborted(entry); // T5（取消）/ T8
      }
      const code = reason instanceof LlmError ? reason.code : "LLM_UNEXPECTED";
      return await this.settleFailed(entry, code, errorMessage(reason)); // T5 / T5'
    } finally {
      batcher.dispose();
    }
  }

  // ---------------------------------------------------------------------------
  // settle 家族：TurnComplete 段 + T15 回 Idle
  // ---------------------------------------------------------------------------

  private async settleCompleted(
    entry: InboxEntry,
    text: string,
    usage: TokenUsage | undefined,
    round: number,
  ): Promise<TurnOutcome> {
    await this.persistAssistant(text); // 落库 message 行
    this.emitMessageCompleted(entry.turnId, round, text, usage); // message.completed
    this.toPhase("Streaming", "message.completed", entry.turnId); // T7
    await this.writeTurnCheckpoint(usage);
    this.emitDone(entry.turnId, {
      outcome: "completed",
      ...(usage !== undefined && { usage }),
      rounds: round,
    });
    this.toPhase("TurnComplete", "settle.done", entry.turnId); // T15
    return { status: "completed", ...(usage !== undefined && { usage }), rounds: round };
  }

  private settleCancelledEarly(entry: InboxEntry): TurnOutcome {
    this.toPhase("ProcessingInput", "turn.cancelled", entry.turnId); // T3
    this.emitDone(entry.turnId, { outcome: "cancelled", at: "ProcessingInput" });
    this.toPhase("TurnComplete", "settle.done", entry.turnId); // T15
    return { status: "cancelled", at: "ProcessingInput" };
  }

  private async settleAborted(entry: InboxEntry): Promise<TurnOutcome> {
    const at = this._phase; // ModelRequest（请求期取消，T5）| Streaming（流式中断，T8）
    if (at === "Streaming") {
      this.toPhase("Streaming", "turn.cancelled", entry.turnId); // T8
    } else {
      this.toPhase("ModelRequest", "request.failed", entry.turnId); // T5（取消即请求失败）
    }
    if (this.assistantText.length > 0) {
      await this.persistAssistant(this.assistantText); // 部分正文落库不丢（02 §1.4）
    }
    this.emitDone(entry.turnId, { outcome: "cancelled", at });
    this.toPhase("TurnComplete", "settle.done", entry.turnId); // T15
    return { status: "cancelled", at };
  }

  private async settleFailed(entry: InboxEntry, code: string, message: string): Promise<TurnOutcome> {
    const at = this._phase; // ModelRequest | Streaming（T5 / T5'）
    this.toPhase(at, "request.failed", entry.turnId);
    if (this.assistantText.length > 0) {
      await this.persistAssistant(this.assistantText);
    }
    this.emitError(entry.turnId, code, message); // error（scope=turn）
    this.emitDone(entry.turnId, { outcome: "failed", at });
    this.toPhase("TurnComplete", "settle.done", entry.turnId); // T15
    return { status: "failed", error: { code, message } };
  }

  /** 基础设施异常 / 未配置 Provider 的兜底收束：按当前阶段合法迁移到 TurnComplete。 */
  private async settleAbnormal(entry: InboxEntry, code: string, message: string): Promise<TurnOutcome> {
    switch (this._phase) {
      case "ProcessingInput":
        this.toPhase("ProcessingInput", "turn.cancelled", entry.turnId); // T3 收敛
        break;
      case "ModelRequest":
      case "Streaming":
        this.toPhase(this._phase, "request.failed", entry.turnId);
        break;
      default:
        break; // TurnComplete / Idle：已收束或未开始
    }
    if (this._phase === "TurnComplete") {
      this.emitError(entry.turnId, code, message);
      this.emitDone(entry.turnId, { outcome: "failed", at: "TurnComplete" });
      this.toPhase("TurnComplete", "settle.done", entry.turnId);
    }
    return { status: "failed", error: { code, message } };
  }

  // ---------------------------------------------------------------------------
  // 持久化与事件
  // ---------------------------------------------------------------------------

  private async persistAssistant(text: string): Promise<void> {
    const record: MessageRecord = { id: `msg_${ulid()}`, role: "assistant", content: text };
    await this.serialWrite(() =>
      this.options.storage.appendMessage(this.options.sessionId, record),
    );
    this.history.push(record);
  }

  private async writeTurnCheckpoint(usage: TokenUsage | undefined): Promise<void> {
    const state: CheckpointState = {
      mode: this.options.mode,
      todo: [],
      messageCount: this.history.length,
      ...(usage !== undefined && { usage }),
    };
    const result = await this.serialWrite(() =>
      this.options.storage.writeCheckpoint(this.options.sessionId, state),
    );
    if (!result.accepted) {
      this.diag("checkpoint rejected (stale epoch)");
    }
  }

  /** 全部 JSONL 写入经单写者链串行（SessionStream 并发追加会错序 seq）。 */
  private serialWrite<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeTail.then(task, task);
    this.writeTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private toPhase(from: TurnPhase, trigger: TurnTrigger, turnId: string): TurnPhase {
    const to = transitionPhase(from, trigger);
    this._phase = to;
    this.emitPersisted("turn.phase_changed", (seq, ts) =>
      buildTurnPhaseChangedEvent({ seq, ts, sessionId: this.options.sessionId, turnId, from, to }),
    );
    return to;
  }

  private emitMessageCompleted(
    turnId: string,
    round: number,
    content: string,
    usage: TokenUsage | undefined,
  ): void {
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
          stopReason: "stop",
          ...(usage !== undefined && { usage }),
        },
      }),
    );
  }

  private emitDone(
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

  private emitError(turnId: string, code: string, message: string): void {
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

  /**
   * 持久事件出口：payload 经 shared 构造函数生成（出口即合法），先落 JSONL 再发布（事实先行）。
   * 写入失败仅告警——事件持久化非关键路径，真源兜底由 message/checkpoint 行承担。
   */
  private emitPersisted(
    name: "turn.phase_changed" | "message.completed" | "done" | "error",
    build: (seq: number, ts: number) => unknown,
  ): void {
    const seq = this.nextSeq();
    const ts = Date.now();
    const payload = build(seq, ts);
    void this.serialWrite(async () => {
      const result = await this.options.storage.appendEvent(this.options.sessionId, name, payload);
      if (!result.accepted) this.diag(`event "${name}" rejected (stale epoch)`);
    }).catch((err: unknown) => this.diag(`failed to persist event "${name}"`, err));
    this.options.publish({ name, payload });
  }

  private publishDelta(
    turnId: string,
    round: number,
    kind: "text" | "reasoning",
    text: string,
  ): void {
    this.options.publish({
      name: "message.delta",
      payload: buildMessageDeltaEvent({
        seq: this.nextSeq(),
        sessionId: this.options.sessionId,
        turnId,
        round,
        delta: { type: kind, text },
      }),
    });
  }

  private nextSeq(): number {
    this.eventSeq += 1;
    return this.eventSeq;
  }

  private diag(message: string, err?: unknown): void {
    const sink = this.options.onDiagnostic ?? console.error;
    sink(`[novacode/agent-core ${this.options.sessionId}] ${message}`, err ?? "");
  }
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
