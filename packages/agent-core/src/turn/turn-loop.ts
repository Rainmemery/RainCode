/**
 * SessionTurnLoop：单会话 Turn 循环（02-module-design §1.2 / 04-architecture §1.3）。
 * 单写者：一个循环实例同时只执行一个 turn；运行中 submit 经 CommandInbox 排队。
 * 多轮主流程（T1–T15，02 §1.2.1）：输入落库 → 组装上下文 → 流式 → ToolSchedule（zod+权限判定，
 * ask 态经 ApprovalBroker 挂起收敛）→ T9 ToolExecution → 结果落库 → T13 回传直至纯文本收束；
 * maxRoundsPerTurn（默认 32）保护；非法入参受限重试上限 3（AC-12，06 §4.3 段 7）；delta/progress 为
 * UI 瞬态不落盘（05 §4.2）；取消 T3/T5+T8/T12。
 */
import { LlmAbortedError, LlmError, type LlmStreamEvent } from "@raincode/llm";
import { ulid, type CheckpointState } from "@raincode/storage";
import type { CollaborationMode, MessageRecord, TokenUsage } from "@raincode/shared";
import type { BackgroundTaskRegistry } from "@raincode/tools";
import { estimateContextTokens, createCompactionService } from "../compact/service.js";
import type { CompactionOptions, CompactionService, CompactionTicket } from "../compact/service.js";
import { CommandInbox } from "../inbox/command-inbox.js";
import type { LlmPort, SessionEventPublisher, StoragePort, ToolPhaseDeps, TurnAdmission, TurnInput, TurnOutcome } from "../ports.js";
import { assembleChatMessages } from "./context.js";
import { DeltaBatcher } from "./delta-batcher.js";
import { LoopEvents } from "./loop-events.js";
import { transitionPhase } from "./phase.js";
import type { TurnPhase, TurnTrigger } from "./phase.js";
import { buildAssistantRecord, errorMessage, invalidInputStats, mergeUsage, toLlmFunctionTools } from "./round-helpers.js";
import { TurnSettler } from "./settle.js";
import { ToolPhaseRunner } from "./tool-phase.js";
import type { PlannedToolCall } from "./tool-phase.js";
export type { TurnAdmission, TurnInput, TurnOutcome } from "../ports.js";

const DEFAULT_DELTA_FLUSH_MS = 50; // message.delta 批量节流窗口（06 §3.4：≤50ms）
const DEFAULT_MAX_ROUNDS = 32; // turn 内模型↔工具往返轮次上限（02 §1.2.1）
// AC-12 受限重试上限：单 turn 内工具参数校验失败（TOOL_INVALID_INPUT）次数，达上限强制收束
// （06 §4.3 段 7 TOOL_INPUT_RETRY_EXCEEDED；maxRoundsPerTurn 语义不变，仅收紧自纠循环）
const INVALID_INPUT_RETRY_LIMIT = 3;

interface InboxEntry {
  turnId: string;
  input: TurnInput;
  resolve: (outcome: TurnOutcome) => void;
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
  /** resume 场景的压缩代次起点（文件内最大 epoch；auto-compact epoch 单调合并基准）。 */
  initialEpoch?: number;
  deltaFlushMs?: number;
  /** 诊断出口（server 注入 stderr；默认 console.error）。 */
  onDiagnostic?: (message: string, err?: unknown) => void;
  /** 工具系统（本波注入；缺省保持 walking-skeleton 行为：模型发工具调用即失败收束）。 */
  tools?: ToolPhaseDeps & { background: BackgroundTaskRegistry };
  /** 工具执行 ctx 基准（workspace 越界校验 + bash cwd；缺省 process.cwd()）。 */
  workspaceRoot?: string;
  /** workspaceHash（权限判定链第 4 级 project 规则的判定域；缺省空串=无 project 规则域）。 */
  workspaceId?: string;
  /** turn 内模型轮次上限（02 §1.2.1：默认 32）。 */
  maxRoundsPerTurn?: number;
  /** auto-compact 选项（02 §1.2.5；缺省 = 不启用压缩）。 */
  compaction?: CompactionOptions;
  compactionOnBeforeReplace?: (prefix: MessageRecord[]) => Promise<void>; // 02 §7.2 compact 记忆抽取钩子（透传 CompactionDeps.onBeforeReplace）
}

/** 模型 tool_call 完成形态（@raincode/llm tool_calls.completed 事件的 calls 元素）。 */
type CompletedToolCall = { toolCallId: string; toolName: string; argumentsJSON: string };

/** 单轮收敛：settled = turn 终态；continue = 工具结果已聚合，进入下一轮（invalidCount/Summary 供 AC-12 累计）。 */
type RoundOutcome =
  | { kind: "settled"; result: TurnOutcome }
  | { kind: "continue"; usage?: TokenUsage; invalidCount: number; invalidSummary: string };

export class SessionTurnLoop {
  private _phase: TurnPhase = "Idle";
  private readonly inbox = new CommandInbox<InboxEntry>();
  private history: MessageRecord[];
  private readonly events: LoopEvents;
  private readonly steeringBuffer: string[] = [];
  private running: InboxEntry | null = null;
  private pumping = false;
  private cancelRequested = false;
  private controller: AbortController | null = null;
  private assistantText = "";
  /** 协作模式（可运行时切换：session.setMode → setMode()，对运行中 turn 的后续判定立即生效）。 */
  private mode: CollaborationMode;
  private readonly settler: TurnSettler;
  /** auto-compact（options.compaction 且配置了 Provider 时启用；null = 不压缩）。 */
  private readonly compaction: CompactionService | null;
  /** 压缩代次（resume 起点 + 每次 accepted checkpoint / 压缩提交后同步）。 */
  private compactionEpoch: number;
  /** 最近一轮真实 promptTokens（usage 事件回传；压缩估算优先数据源）。 */
  private lastPromptTokens = 0;

  constructor(private readonly options: SessionTurnLoopOptions) {
    this.mode = options.mode;
    this.history = [...(options.initialHistory ?? [])];
    this.compactionEpoch = options.initialEpoch ?? 0;
    this.events = new LoopEvents(
      { sessionId: options.sessionId, storage: options.storage, publish: options.publish,
        ...(options.onDiagnostic !== undefined && { onDiagnostic: options.onDiagnostic }) },
      options.initialEventSeq ?? 0,
    );
    this.settler = new TurnSettler(
      { phase: () => this._phase,
        toPhase: (from, trigger, turnId) => this.toPhase(from, trigger, turnId),
        assistantText: () => this.assistantText, persistPartialText: () => this.persistPartialText() },
      this.events,
    );
    this.compaction =
      options.compaction !== undefined && options.llm !== null
        ? createCompactionService(
            this,
            {
              sessionId: options.sessionId,
              llm: options.llm,
              storage: options.storage,
              ...(options.systemPrompt !== undefined && { systemPrompt: options.systemPrompt }),
              ...(options.compactionOnBeforeReplace !== undefined && { onBeforeReplace: options.compactionOnBeforeReplace }),
              events: this.events,
            },
            options.compaction,
          )
        : null;
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

  /** steering 正交通道（02 §1.2.3）：运行中注入 steeringBuffer（汇入当前 turn 下轮上下文）；空闲按 turn.new 处理。 */
  steer(text: string): { result: "injected" | "started" | "queued"; turnId?: string } {
    if (this.running !== null || this._phase !== "Idle") {
      this.steeringBuffer.push(text);
      return { result: "injected", turnId: this.running?.turnId };
    }
    const admission = this.submit({ text });
    return { result: admission.admission, turnId: admission.turnId };
  }

  /** 协作模式运行时切换（06 §2.1 session.setMode：对运行中 turn 的后续判定立即生效）。 */
  setMode(mode: CollaborationMode): void {
    this.mode = mode;
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
      outcome = await this.settler.abnormal(entry.turnId, "TURN_INTERNAL", errorMessage(reason));
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
    await this.serialWrite(() => this.options.storage.appendMessage(this.options.sessionId, userRecord));
    this.history.push(userRecord);

    if (this.cancelRequested) {
      return this.settler.cancelledEarly(entry.turnId); // T3
    }
    if (!this.options.llm) {
      return this.settler.abnormal(entry.turnId, "LLM_NOT_CONFIGURED", "no LLM client configured for this session");
    }

    let usageTotal: TokenUsage | undefined;
    let invalidInputCount = 0; // AC-12：非法入参失败跨轮累计（turn 生命周期内；上限 INVALID_INPUT_RETRY_LIMIT）
    const maxRounds = this.options.maxRoundsPerTurn ?? DEFAULT_MAX_ROUNDS;
    this.compaction?.maybeTrigger(estimateContextTokens(this.history, this.lastPromptTokens)); // 组装上下文前
    for (let round = 1; round <= maxRounds; round += 1) {
      const outcome = await this.runModelRound(entry, controller, round, usageTotal);
      if (outcome.kind === "settled") {
        return outcome.result;
      }
      usageTotal = mergeUsage(usageTotal, outcome.usage);
      invalidInputCount += outcome.invalidCount;
      if (invalidInputCount >= INVALID_INPUT_RETRY_LIMIT) {
        // AC-12 收束：受限重试超限 → failed（对齐 TURN_MAX_ROUNDS_EXCEEDED 的异常收敛形态）
        return this.settler.abnormal(
          entry.turnId,
          "TOOL_INPUT_RETRY_EXCEEDED",
          `工具参数校验失败次数超过受限重试上限（${String(INVALID_INPUT_RETRY_LIMIT)}），强制收束；最近失败: ${outcome.invalidSummary}`,
        );
      }
      if (round === maxRounds) {
        break; // 轮次耗尽：超限异常收敛（02 §1.2.1 补充约束）
      }
      this.compaction?.maybeTrigger(estimateContextTokens(this.history, this.lastPromptTokens)); // T13 聚合后触发点
    }
    const reason = `tool rounds exceeded maxRoundsPerTurn=${String(maxRounds)}`;
    return this.settler.abnormal(entry.turnId, "TURN_MAX_ROUNDS_EXCEEDED", reason);
  }

  private async runModelRound(
    entry: InboxEntry,
    controller: AbortController,
    round: number,
    usageSoFar: TokenUsage | undefined,
  ): Promise<RoundOutcome> {
    const llm = this.options.llm;
    if (llm === null) {
      const result = await this.settler.abnormal(entry.turnId, "LLM_NOT_CONFIGURED", "no LLM client configured");
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
          this.lastPromptTokens = event.usage.inputTokens;
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
        return { kind: "settled", result: await this.settler.aborted(entry.turnId) }; // T5（取消）/ T8
      }
      const code = reason instanceof LlmError ? reason.code : "LLM_UNEXPECTED";
      return { kind: "settled", result: await this.settler.failed(entry.turnId, code, errorMessage(reason)) };
    } finally {
      batcher.dispose();
    }

    // 落库 assistant 行（含 tool_call 块；02 §1.2.1 T6 前置）
    const calls = state.calls;
    const record = buildAssistantRecord(this.assistantText, calls);
    await this.serialWrite(() => this.options.storage.appendMessage(this.options.sessionId, record));
    this.history.push(record);

    if (calls === null || calls.length === 0) {
      // T7：纯文本 stop 收束（usage 为 turn 级累计）
      const totalUsage = mergeUsage(usageSoFar, roundUsage);
      this.events.emitMessageCompleted(entry.turnId, round, this.assistantText, undefined, roundUsage);
      this.toPhase("Streaming", "message.completed.stop", entry.turnId);
      await this.writeTurnCheckpoint(totalUsage);
      this.events.emitDone(entry.turnId, { outcome: "completed", ...(totalUsage !== undefined && { usage: totalUsage }), rounds: round });
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
      const result = await this.settler.failed(
        entry.turnId,
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
        mode: this.mode,
        workspaceId: this.options.workspaceId ?? "",
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

    // T13：AggregatingResults --followup.required--> ModelRequest（下一轮）；AC-12 非法入参统计随轮上交
    const invalidStats = invalidInputStats(phaseResult.results);
    this.toPhase("AggregatingResults", "followup.required", entry.turnId);
    return { kind: "continue", usage: roundUsage, ...invalidStats };
  }

  // auto-compact：手动入口（06 §2.1 session.compact）+ CompactionHost 实现（compact/service.ts）
  compact(): CompactionTicket | null {
    return this.compaction?.compactNow() ?? null;
  }

  replaceWith(prefix: MessageRecord[], count: number): void {
    this.history = [...prefix, ...this.history.slice(count)];
  }

  historyLength(): number {
    return this.history.length;
  }

  currentEpoch(): number {
    return this.compactionEpoch;
  }

  updateEpoch(epoch: number): void {
    this.compactionEpoch = epoch;
  }

  checkpointBase(): Pick<CheckpointState, "mode" | "todo"> {
    return { mode: this.mode, todo: [] };
  }

  private async writeTurnCheckpoint(usage: TokenUsage | undefined): Promise<void> {
    const state: CheckpointState = {
      mode: this.mode,
      todo: [],
      messageCount: this.history.length,
      ...(usage !== undefined && { usage }),
    };
    const result = await this.serialWrite(() => this.options.storage.writeCheckpoint(this.options.sessionId, state));
    if (result.accepted) {
      this.compactionEpoch = result.epoch; // 压缩代次与文件内流保持同步（epoch 单调合并基准）
    } else {
      this.diag("checkpoint rejected (stale epoch)");
    }
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
