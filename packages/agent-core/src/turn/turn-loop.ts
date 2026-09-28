/**
 * SessionTurnLoop：单会话 Turn 循环（02-module-design §1 / 04-architecture §1.3）。
 * 单写者：一个循环实例同时只执行一个 turn；运行中 submit 经 CommandInbox 排队。
 * 多轮主流程（T1–T15，02 §1.2.1）：用户输入落库 → [组装上下文 → 流式 → 落库 assistant 行
 * → message.completed → 无 tool_call 则 T7 收束；有则 T6 → ToolSchedule（zod + 权限判定）→
 * T9 ToolExecution（并发 ≤4，tool_call.* 事件）→ tool 结果落库（T11/T12）→ T13 回传模型继续]
 * 直至纯文本收束；maxRoundsPerTurn（默认 32）保护。message.delta / tool_call.progress 为
 * UI 瞬态不落盘（05 §4.2）；事件出口见 turn/loop-events.ts。取消：T3 / T5+T8 / T12（聚合
 * 已产生结果，不留悬挂 tool_call）；steering 注入 steeringBuffer 顺延下一轮合并。
 */
import { LlmAbortedError, LlmError } from "@novacode/llm";
import type { LlmStreamEvent } from "@novacode/llm";
import { ulid } from "@novacode/storage";
import type { CheckpointState } from "@novacode/storage";
import type { MessageRecord, TokenUsage } from "@novacode/shared";
import type { BackgroundTaskRegistry } from "@novacode/tools";
import { CommandInbox } from "../inbox/command-inbox.js";
import type { LlmPort, SessionEventPublisher, StoragePort, ToolPhaseDeps } from "../ports.js";
import { assembleChatMessages } from "./context.js";
import { DeltaBatcher } from "./delta-batcher.js";
import { LoopEvents } from "./loop-events.js";
import { transitionPhase } from "./phase.js";
import type { TurnPhase, TurnTrigger } from "./phase.js";
import { buildAssistantRecord, errorMessage, mergeUsage, toLlmFunctionTools } from "./round-helpers.js";
import { ToolPhaseRunner } from "./tool-phase.js";
import type { PlannedToolCall } from "./tool-phase.js";

const DEFAULT_DELTA_FLUSH_MS = 50; // message.delta 批量节流窗口（06 §3.4：≤50ms）
const DEFAULT_MAX_ROUNDS = 32; // turn 内模型↔工具往返轮次上限（02 §1.2.1）

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
  /** 工具系统（本波注入；缺省保持 walking-skeleton 行为：模型发工具调用即失败收束）。 */
  tools?: ToolPhaseDeps & { background: BackgroundTaskRegistry };
  /** 工具执行 ctx 基准（workspace 越界校验 + bash cwd；缺省 process.cwd()）。 */
  workspaceRoot?: string;
  /** turn 内模型轮次上限（02 §1.2.1：默认 32）。 */
  maxRoundsPerTurn?: number;
}

interface InboxEntry {
  turnId: string;
  input: TurnInput;
  resolve: (outcome: TurnOutcome) => void;
}

/** 模型 tool_call 完成形态（@novacode/llm tool_calls.completed 事件的 calls 元素）。 */
type CompletedToolCall = { toolCallId: string; toolName: string; argumentsJSON: string };

/** 单轮收敛：settled = turn 终态；continue = 工具结果已聚合，进入下一轮。 */
type RoundOutcome = { kind: "settled"; result: TurnOutcome } | { kind: "continue"; usage?: TokenUsage };

export class SessionTurnLoop {
  private _phase: TurnPhase = "Idle";
  private readonly inbox = new CommandInbox<InboxEntry>();
  private readonly history: MessageRecord[];
  private readonly events: LoopEvents;
  private readonly steeringBuffer: string[] = [];
  private running: InboxEntry | null = null;
  private pumping = false;
  private cancelRequested = false;
  private controller: AbortController | null = null;
  private assistantText = "";

  constructor(private readonly options: SessionTurnLoopOptions) {
    this.history = [...(options.initialHistory ?? [])];
    this.events = new LoopEvents(
      {
        sessionId: options.sessionId,
        storage: options.storage,
        publish: options.publish,
        ...(options.onDiagnostic !== undefined && { onDiagnostic: options.onDiagnostic }),
      },
      options.initialEventSeq ?? 0,
    );
  }

  get phase(): TurnPhase {
    return this._phase;
  }

  /** 已发布的最大 rpc 事件 seq（session.snapshot.lastSeq 数据源）。 */
  get lastEventSeq(): number {
    return this.events.lastEventSeq;
  }

  getHistory(): MessageRecord[] {
    return [...this.history];
  }

  /** 接纳 turn.new：空闲立即开 turn（started），运行中入队（queued）；done 永不 reject。 */
  submit(input: TurnInput): TurnAdmission {
    const turnId = `turn_${ulid()}`;
    let resolve!: (outcome: TurnOutcome) => void;
    const done = new Promise<TurnOutcome>((resolvePromise) => (resolve = resolvePromise));
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

  /** steering 正交通道（02 §1.2.3）：运行中注入 steeringBuffer；空闲按 turn.new 处理。 */
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

  // 泵：单写者循环 -----------------------------------------------------------

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
    this.toPhase("Idle", "command.submitted", entry.turnId); // T1
    const controller = new AbortController();
    this.controller = controller;
    let outcome: TurnOutcome;
    try {
      outcome = await this.executeTurn(entry, controller);
    } catch (reason: unknown) {
      // 基础设施异常收敛 failed 终态，防 inbox 死锁（02 §1.2.3 门在异常路径必须释放）
      this.diag("turn crashed", reason);
      outcome = await this.settleAbnormal(entry, "TURN_INTERNAL", errorMessage(reason));
    } finally {
      this.controller = null;
    }
    entry.resolve(outcome);
  }

  // 多轮 turn：模型请求 ↔ 工具执行（T2 … T13 往返）---------------------------

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
    if (!this.options.llm) {
      return this.settleAbnormal(entry, "LLM_NOT_CONFIGURED", "no LLM client configured for this session");
    }

    let usageTotal: TokenUsage | undefined;
    const maxRounds = this.options.maxRoundsPerTurn ?? DEFAULT_MAX_ROUNDS;
    for (let round = 1; round <= maxRounds; round += 1) {
      const outcome = await this.runModelRound(entry, controller, round, usageTotal);
      if (outcome.kind === "settled") {
        return outcome.result;
      }
      usageTotal = mergeUsage(usageTotal, outcome.usage);
      if (round === maxRounds) {
        break; // 轮次耗尽：超限异常收敛（02 §1.2.1 补充约束）
      }
    }
    const reason = `tool rounds exceeded maxRoundsPerTurn=${String(maxRounds)}`;
    return this.settleAbnormal(entry, "TURN_MAX_ROUNDS_EXCEEDED", reason);
  }

  private async runModelRound(
    entry: InboxEntry,
    controller: AbortController,
    round: number,
    usageSoFar: TokenUsage | undefined,
  ): Promise<RoundOutcome> {
    const llm = this.options.llm;
    if (llm === null) {
      const result = await this.settleAbnormal(entry, "LLM_NOT_CONFIGURED", "no LLM client configured");
      return { kind: "settled", result };
    }
    const requestMessages = assembleChatMessages({
      systemPrompt: this.options.systemPrompt,
      history: this.history,
      steering: this.steeringBuffer,
    });
    this.steeringBuffer.length = 0;
    if (round === 1) {
      this.toPhase("ProcessingInput", "context.assembled", entry.turnId); // T2（后续轮由 T13 直达）
    }

    const batcher = new DeltaBatcher(this.options.deltaFlushMs ?? DEFAULT_DELTA_FLUSH_MS, (kind, text) =>
      this.events.publishDelta(entry.turnId, round, kind, text),
    );
    this.assistantText = "";
    let roundUsage: TokenUsage | undefined;
    const state: { calls: CompletedToolCall[] | null } = { calls: null }; // 闭包累积（规避 TS 收窄推断）

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
        case "tool_calls.completed":
          state.calls = event.calls;
          break;
        case "usage":
          roundUsage = event.usage;
          break;
        default:
          break; // role / finish / done / delta.tool_call（片段已聚合）：透传
      }
    };

    try {
      const tools = this.options.tools;
      const toolsPayload = tools !== undefined ? toLlmFunctionTools(tools.registry) : undefined;
      await llm.streamChat({
        messages: requestMessages,
        ...(toolsPayload !== undefined && { tools: toolsPayload }),
        includeUsage: true,
        signal: controller.signal,
        onEvent,
      });
      batcher.flush(); // flush 边界：边界事件不乱序于其前的 delta（06 §3.4）
    } catch (reason: unknown) {
      batcher.flush();
      if (reason instanceof LlmAbortedError || this.cancelRequested || controller.signal.aborted) {
        return { kind: "settled", result: await this.settleAborted(entry) }; // T5（取消）/ T8
      }
      const code = reason instanceof LlmError ? reason.code : "LLM_UNEXPECTED";
      return { kind: "settled", result: await this.settleFailed(entry, code, errorMessage(reason)) };
    } finally {
      batcher.dispose();
    }

    // 落库 assistant 行（含 tool_call 块；02 §1.2.1 T6 前置）
    const calls = state.calls;
    const record = buildAssistantRecord(this.assistantText, calls);
    await this.serialWrite(() =>
      this.options.storage.appendMessage(this.options.sessionId, record),
    );
    this.history.push(record);

    if (calls === null || calls.length === 0) {
      // T7：纯文本 stop 收束（usage 为 turn 级累计）
      const totalUsage = mergeUsage(usageSoFar, roundUsage);
      this.events.emitMessageCompleted(entry.turnId, round, this.assistantText, undefined, roundUsage);
      this.toPhase("Streaming", "message.completed.stop", entry.turnId);
      await this.writeTurnCheckpoint(totalUsage);
      this.events.emitDone(entry.turnId, {
        outcome: "completed",
        ...(totalUsage !== undefined && { usage: totalUsage }),
        rounds: round,
      });
      this.toPhase("TurnComplete", "settle.done", entry.turnId); // T15
      return {
        kind: "settled",
        result: {
          status: "completed",
          ...(totalUsage !== undefined && { usage: totalUsage }),
          rounds: round,
        },
      };
    }

    // message.completed（含 toolCalls）→ T6：Streaming --message.completed(tool_calls)--> ToolSchedule
    this.events.emitMessageCompleted(entry.turnId, round, this.assistantText, calls, roundUsage);
    this.toPhase("Streaming", "message.completed.tool_calls", entry.turnId);
    const tools = this.options.tools;
    if (tools === undefined) {
      const result = await this.settleFailed(
        entry,
        "TOOL_CALLS_UNSUPPORTED",
        "model requested tool calls, but no tool system is configured for this session",
      );
      return { kind: "settled", result };
    }

    // ToolSchedule → ToolExecution → AggregatingResults（T9/T10/T11/T12 在 runner 内回调迁移）
    const runner = new ToolPhaseRunner({
      sessionId: this.options.sessionId,
      turnId: entry.turnId,
      deps: tools,
      emitPersisted: (name, build) => this.events.emitPersisted(name, build),
      publishProgress: (build) => this.events.publishTransient("tool_call.progress", build),
      onTransition: (trigger) => this.toPhase(this._phase, trigger, entry.turnId),
      onDiagnostic: (message, err) => this.diag(message, err),
    });
    const workspaceRoot = this.options.workspaceRoot ?? process.cwd();
    const phaseResult = await runner.run(
      calls.map(
        (call): PlannedToolCall => ({
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          argsJSON: call.argumentsJSON,
        }),
      ),
      {
        signal: controller.signal,
        workspaceRoot,
        cwd: workspaceRoot,
        sessionKey: this.options.sessionId,
        background: tools.background,
        persistRecord: async (toolRecord) => {
          await this.serialWrite(() =>
            this.options.storage.appendMessage(this.options.sessionId, toolRecord),
          );
          this.history.push(toolRecord);
        },
      },
    );

    if (this.cancelRequested || phaseResult.cancelled) {
      // T12 已聚合（记录已落库，不留悬挂 tool_call）→ T14 收束
      this.toPhase("AggregatingResults", "followup.not_required", entry.turnId);
      this.events.emitDone(entry.turnId, { outcome: "cancelled", at: "AggregatingResults" });
      this.toPhase("TurnComplete", "settle.done", entry.turnId); // T15
      return { kind: "settled", result: { status: "cancelled", at: "AggregatingResults" } };
    }

    // T13：AggregatingResults --followup.required--> ModelRequest（下一轮）
    this.toPhase("AggregatingResults", "followup.required", entry.turnId);
    return { kind: "continue", usage: roundUsage };
  }

  // settle 家族：TurnComplete 段 + T15 回 Idle --------------------------------

  private settleCancelledEarly(entry: InboxEntry): TurnOutcome {
    this.toPhase("ProcessingInput", "turn.cancelled", entry.turnId); // T3
    this.events.emitDone(entry.turnId, { outcome: "cancelled", at: "ProcessingInput" });
    this.toPhase("TurnComplete", "settle.done", entry.turnId); // T15
    return { status: "cancelled", at: "ProcessingInput" };
  }

  private async settleAborted(entry: InboxEntry): Promise<TurnOutcome> {
    const at = this._phase; // ModelRequest（请求期取消，T5）| Streaming（流式中断，T8）
    this.toPhase(at, at === "Streaming" ? "turn.cancelled" : "request.failed", entry.turnId); // T8 / T5
    if (this.assistantText.length > 0) {
      await this.persistPartialText(); // 部分正文落库不丢（02 §1.4）
    }
    this.events.emitDone(entry.turnId, { outcome: "cancelled", at });
    this.toPhase("TurnComplete", "settle.done", entry.turnId); // T15
    return { status: "cancelled", at };
  }

  private async settleFailed(entry: InboxEntry, code: string, message: string): Promise<TurnOutcome> {
    const at = this._phase; // ModelRequest | Streaming（T5 / T5'）
    this.toPhase(at, "request.failed", entry.turnId);
    if (this.assistantText.length > 0) {
      await this.persistPartialText();
    }
    this.events.emitError(entry.turnId, code, message); // error（scope=turn）
    this.events.emitDone(entry.turnId, { outcome: "failed", at });
    this.toPhase("TurnComplete", "settle.done", entry.turnId); // T15
    return { status: "failed", error: { code, message } };
  }

  /** 基础设施异常 / 未配置 Provider / 轮次超限的兜底收束：经合法迁移收敛到 TurnComplete。 */
  private async settleAbnormal(entry: InboxEntry, code: string, message: string): Promise<TurnOutcome> {
    if (this._phase === "ToolSchedule") {
      this.toPhase("ToolSchedule", "schedule.all_blocked", entry.turnId);
    }
    if (this._phase === "ToolExecution") {
      this.toPhase("ToolExecution", "batch.settled", entry.turnId);
    }
    if (this._phase === "AggregatingResults") {
      this.toPhase("AggregatingResults", "followup.not_required", entry.turnId); // T14 异常收敛
    }
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
      this.events.emitError(entry.turnId, code, message);
      this.events.emitDone(entry.turnId, { outcome: "failed", at: "TurnComplete" });
      this.toPhase("TurnComplete", "settle.done", entry.turnId); // T15
    }
    return { status: "failed", error: { code, message } };
  }

  // 持久化与事件（出口实现见 turn/loop-events.ts）-----------------------------

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
    if (!result.accepted) this.diag("checkpoint rejected (stale epoch)");
  }

  private persistPartialText(): Promise<unknown> {
    const record: MessageRecord = { id: `msg_${ulid()}`, role: "assistant", content: this.assistantText };
    return this.serialWrite(() => this.options.storage.appendMessage(this.options.sessionId, record));
  }

  private toPhase(from: TurnPhase, trigger: TurnTrigger, turnId: string): TurnPhase {
    const to = transitionPhase(from, trigger);
    this._phase = to;
    this.events.emitTurnPhaseChanged(turnId, from, to);
    return to;
  }

  private serialWrite<T>(task: () => Promise<T>): Promise<T> {
    return this.events.serialWrite(task);
  }

  private diag(message: string, err?: unknown): void {
    this.events.diag(message, err);
  }
}
