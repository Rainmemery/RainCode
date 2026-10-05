/**
 * ToolSchedule → ToolExecution → AggregatingResults 区间执行器（02-module-design §1.2.1 T9–T12）。
 *
 * - 调度：工具解析（unknown_tool）→ zod 校验（invalid_input，不进权限）→ 权限判定
 *   （PermissionPort，deny → permission_denied 结果）；
 * - 执行：已放行调用经 ToolExecutor.runBatch（只读并行 ≤4、写串行，02 §2.2）；
 * - 事件：tool_call.started / completed 持久落 JSONL（06 §3.2 B 组）；progress 为 UI 瞬态
 *   （500ms 节流，06 §3.4），只发布不落盘（与 message.delta 同口径）；
 * - 聚合：每个调用一条 role:"tool" 消息记录（原调用顺序，不留悬挂 tool_call，02 §1.4）；
 *   状态迁移经 onTransition 回调由 turn-loop 执行（保持状态机单点）。
 */
import { ulid } from "@raincode/storage";
import { TOOL_ERROR_CODES, buildToolCallCompletedEvent, buildToolCallProgressEvent, buildToolCallStartedEvent, type CollaborationMode, type ToolErrorCode, type ToolMetadata, type ToolResult } from "@raincode/shared";
import { normalizeForGuard, type AskUserRequest, type BackgroundTaskRegistry, type ToolCallRequest, type ToolProgressEvent } from "@raincode/tools";
import type { HookDispatcher } from "../hooks/dispatcher.js";
import type { PermissionEventSink, PermissionPort, PermissionVerdict, ToolPhaseDeps } from "../ports.js";
import { detectPathEscape, parseLoose, previewOf, unknownToolMetadata } from "./tool-phase-util.js";

export interface PlannedToolCall {
  toolCallId: string;
  toolName: string;
  argsJSON: string;
}

export interface ToolPhaseContext {
  signal: AbortSignal;
  workspaceRoot: string;
  cwd: string;
  sessionKey: string;
  /** 协作模式（权限判定链第 2 级，02 §6.2）。 */
  mode: CollaborationMode;
  /** workspaceHash（project 规则判定域）。 */
  workspaceId: string;
  /** bash runInBackground 等后台能力（与 server tool.background.* 方法共享同一单例）。 */
  background: BackgroundTaskRegistry;
  /** hooks 生命周期 dispatch 单点（T5.1；缺省 = 未装配，PreToolUse/PostToolUse 均跳过）。 */
  hooks?: HookDispatcher;
  /**
   * 聚合记录持久化钩子（appendMessage + history 推入；turn-loop 单写者链）。
   * 缺省不持久化（测试场景）。
   */
  persistRecord?: (record: ToolPhaseResult["records"][number]) => Promise<void>;
}

export interface ToolPhaseResult {
  /** 每个调用的收敛结果（原调用顺序；含被拒/非法）。 */
  results: ToolResult[];
  /** 每个调用的 role:"tool" 消息记录（原调用顺序，与 results 同索引对齐）。 */
  records: Array<{
    id: string;
    role: "tool";
    toolCallId: string;
    content: string;
    isError: boolean;
  }>;
  /** 全部调用被拒/非法（T10 路径）。 */
  allBlocked: boolean;
  /** 执行期间收到取消信号（T12 路径）。 */
  cancelled: boolean;
}

export type ToolPhaseTrigger =
  | "schedule.ready"
  | "schedule.all_blocked"
  | "batch.settled"
  | "turn.cancelled";

export interface ToolPhaseOptions {
  sessionId: string;
  turnId: string;
  deps: ToolPhaseDeps;
  /** 持久事件出口（started/completed/permission.* 先落 JSONL 再发布；turn-loop 单点实现）。 */
  emitPersisted: (
    name: "tool_call.started" | "tool_call.completed" | "permission.requested" | "permission.resolved",
    build: (seq: number, ts: number) => unknown,
  ) => void;
  /** 瞬态事件出口（progress；seq 递增但不落盘，与 message.delta 同口径）。 */
  publishProgress: (build: (seq: number, ts: number) => unknown) => void;
  /** 状态迁移回调（T9/T10/T11/T12；turn-loop 内单点执行 transitionPhase）。 */
  onTransition: (trigger: ToolPhaseTrigger) => void;
  /** 诊断出口。 */
  onDiagnostic?: (message: string, err?: unknown) => void;
  /** progress 节流窗口（06 §3.4：500ms）。 */
  progressThrottleMs?: number;
}

interface ScheduleEntry {
  call: PlannedToolCall;
  toolName: string;
  input: unknown;
  metadata: ToolMetadata;
  /** 非空 = 调度期已被拒/非法（不进执行批次）。 */
  blocked?: ToolResult;
  /** 越界预检命中（02 §5.4）：非空时进权限判定携带 pathEscape，获批后精确放行该绝对路径。 */
  pathEscape?: { absolutePath: string };
}

export class ToolPhaseRunner {
  private readonly progressWindow = new Map<string, { firstAt: number; lastAt: number }>();

  constructor(private readonly options: ToolPhaseOptions) {}

  async run(calls: PlannedToolCall[], ctx: ToolPhaseContext): Promise<ToolPhaseResult> {
    const { deps } = this.options;
    const batchSize = calls.length;

    // 1) ToolSchedule：解析 → zod 校验 → 权限判定（02 §2.2 数据流）
    const entries: ScheduleEntry[] = calls.map((call) => {
      const tool = deps.registry.get(call.toolName);
      if (tool === undefined) {
        const entry = this.plainEntry(call, unknownToolMetadata());
        entry.blocked = this.makeBlocked(entry, {
          code: TOOL_ERROR_CODES.UNKNOWN,
          message: `unknown tool: ${call.toolName}`,
        });
        return entry;
      }
      let args: unknown;
      try {
        args = JSON.parse(call.argsJSON);
      } catch {
        args = undefined;
      }
      const parsed = tool.parametersSchema.safeParse(args);
      if (!parsed.success) {
        // 附 issues 摘要帮助模型自纠（02 §2.4）
        const issues = parsed.error.issues
          .slice(0, 8)
          .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
          .join("; ");
        const entry = this.plainEntry(call, tool.metadata);
        entry.blocked = this.makeBlocked(entry, {
          code: TOOL_ERROR_CODES.INVALID_INPUT,
          message: `invalid input for ${call.toolName}: ${issues}`,
        });
        return entry;
      }
      return { call, toolName: call.toolName, input: parsed.data, metadata: tool.metadata };
    });

    // 2) tool_call.started（全部调用，含待审批/被拒，06 §3.2；先于 permission.requested，06 §2.13）
    entries.forEach((entry, index) => {
      this.options.emitPersisted("tool_call.started", (seq, ts) =>
        buildToolCallStartedEvent({
          seq,
          ts,
          sessionId: this.options.sessionId,
          turnId: this.options.turnId,
          toolCallId: entry.call.toolCallId,
          toolName: entry.toolName,
          input: entry.input,
          metadata: entry.metadata,
          batchIndex: index,
          batchSize,
        }),
      );
    });

    // 3) PreToolUse hook（T5.1，先于权限判定：hook deny 拦截不进审批闭环）→ 权限判定（仅 zod 合法且未被 hook 拦截的调用）
    //    三态收敛：allow/deny 直接落定；ask → awaitApproval 挂起等待审批闭环（02 §6.2）。
    //    越界预检（02 §5.4）：命中 pathEscape 的调用由 permission 强制 ask，
    //    获批后在执行批次按审批通过的绝对路径精确注入放行钩子。
    const sink = this.permissionSink();
    const approvedEscapes: string[] = [];
    for (const entry of entries) {
      if (entry.blocked !== undefined) {
        continue;
      }
      if (ctx.hooks !== undefined) {
        const hookResult = await ctx.hooks.run({
          event: "PreToolUse",
          sessionId: this.options.sessionId,
          turnId: this.options.turnId,
          toolCallId: entry.call.toolCallId,
          toolName: entry.toolName,
          toolInput: entry.input,
          signal: ctx.signal,
        });
        if (hookResult.blocked) {
          entry.blocked = this.makeBlocked(entry, {
            code: TOOL_ERROR_CODES.HOOK_DENIED,
            message: `blocked by PreToolUse hook: ${hookResult.reason ?? "no reason given"}`,
          });
          continue;
        }
      }
      entry.pathEscape = detectPathEscape(entry.toolName, entry.input, ctx.workspaceRoot);
      let verdict: PermissionVerdict;
      try {
        verdict = await deps.permission.evaluate({
          toolName: entry.toolName,
          input: entry.input,
          metadata: entry.metadata,
          mode: ctx.mode,
          sessionId: this.options.sessionId,
          turnId: this.options.turnId,
          toolCallId: entry.call.toolCallId,
          workspaceRoot: ctx.workspaceRoot,
          workspaceId: ctx.workspaceId,
          ...(entry.pathEscape !== undefined && { pathEscape: entry.pathEscape }),
          events: sink,
        });
      } catch (reason: unknown) {
        this.diag("permission evaluate crashed; deny by fail-safe", reason);
        verdict = { decision: "deny", reason: "permission evaluate crashed" };
      }
      if (verdict.decision === "ask") {
        if (verdict.grantId === undefined) {
          // 实现缺陷防御：ask 必须携带 grantId，缺失按 deny 收敛（fail-safe）
          this.diag("permission verdict ask without grantId; deny by fail-safe");
          verdict = { decision: "deny", reason: "ask verdict without grantId" };
        } else {
          let final: "allow" | "deny" = "deny";
          try {
            final = await this.awaitApprovalWithAbort(deps.permission, verdict.grantId, ctx.signal);
          } catch (reason: unknown) {
            this.diag("approval await crashed; deny by fail-safe", reason);
          }
          verdict = { ...verdict, decision: final };
        }
      }
      if (verdict.decision === "deny") {
        entry.blocked = this.makeBlocked(entry, {
          code: TOOL_ERROR_CODES.PERMISSION_DENIED,
          message: `user denied execution of ${entry.toolName}${
            verdict.reason !== undefined ? `: ${verdict.reason}` : ""
          }`,
        });
      } else if (entry.pathEscape !== undefined) {
        // 越界 ask 获批：仅精确放行审批单中的绝对路径（02 §5.4「审批通过后放行并记录审计」）
        approvedEscapes.push(entry.pathEscape.absolutePath);
      }
    }

    const settledResults = new Map<string, ToolResult>();
    for (const entry of entries) {
      if (entry.blocked !== undefined) {
        settledResults.set(entry.call.toolCallId, entry.blocked);
        this.emitCompleted(entry.blocked); // 被拒/非法立即收敛 completed（06 §3.2）
      }
    }

    // 取消预检：信号已中止 → 全部收敛为 CANCELLED，不进执行（02 §1.4 T12）
    if (ctx.signal.aborted) {
      for (const entry of entries) {
        if (entry.blocked === undefined) {
          entry.blocked = this.makeBlocked(entry, {
            code: TOOL_ERROR_CODES.CANCELLED,
            message: "turn cancelled before execution",
          });
          settledResults.set(entry.call.toolCallId, entry.blocked);
          this.emitCompleted(entry.blocked);
        }
      }
    }

    const executable = entries.filter((entry) => entry.blocked === undefined);
    if (executable.length === 0) {
      this.options.onTransition("schedule.all_blocked"); // T10
      const aggregated = this.aggregate(entries, settledResults, {
        allBlocked: true,
        cancelled: ctx.signal.aborted,
      });
      for (const record of aggregated.records) {
        await ctx.persistRecord?.(record);
      }
      return aggregated;
    }

    // 3) ToolExecution（T9）：只读并行（≤maxConcurrency，缺省 4）、写串行（02 §2.2）
    this.options.onTransition("schedule.ready");
    const progressThrottleMs = this.options.progressThrottleMs ?? 500;
    const requests: ToolCallRequest[] = executable.map((entry) => ({
      toolCallId: entry.call.toolCallId,
      toolName: entry.toolName,
      args: entry.input,
    }));
    // 越界放行钩子（02 §5.4）：仅当本批存在获批越界时注入，且精确匹配审批通过的绝对路径；
    // 其余情况不注入（undefined）→ 处理器 guardPath 越界照旧 throw（fail-safe）。
    const batchCtx = {
      signal: ctx.signal,
      workspaceRoot: ctx.workspaceRoot,
      cwd: ctx.cwd,
      sessionKey: ctx.sessionKey,
      background: ctx.background,
      ...(approvedEscapes.length > 0 && {
        pathPolicy: {
          allowEscaped: (target: string): boolean =>
            approvedEscapes.some((abs) => normalizeForGuard(target) === normalizeForGuard(abs)),
        },
      }),
      // T2.7 P1 ask_user_question 通道：会话归属+审批事件出口注入；deps.askUser 缺省 → 工具 TOOL_UNAVAILABLE
      ...(deps.askUser !== undefined && {
        askUser: (question: AskUserRequest) => deps.askUser!({ sessionId: ctx.sessionKey, workspaceId: ctx.workspaceId,
          question: question.question, ...(question.choices !== undefined && { choices: question.choices }),
          events: this.permissionSink() }),
      }),
      // T4.4 skill 展开通道：会话归属注入，展开单点 SkillRuntime（skills.invoke 同链路）；缺省 → TOOL_UNAVAILABLE
      ...(deps.expandSkill !== undefined && {
        expandSkill: (request: { name: string; arguments?: string }) =>
          deps.expandSkill!({ sessionId: ctx.sessionKey, name: request.name, arguments: request.arguments }),
      }),
      // T5.3 session_search 检索通道：会话归属 + workspace 判定域注入；deps.searchHistory 缺省 → TOOL_UNAVAILABLE
      ...(deps.searchHistory !== undefined && {
        searchHistory: (request: { query: string; limit?: number }) =>
          deps.searchHistory!({ sessionId: ctx.sessionKey, workspaceId: ctx.workspaceId, query: request.query,
            ...(request.limit !== undefined && { limit: request.limit }) }),
      }),
      onToolProgress: (event: ToolProgressEvent & { toolCallId: string }) => {
        this.publishThrottledProgress(event, progressThrottleMs);
      },
      onSettled: (result: ToolResult) => {
        this.emitCompleted(result);
      },
    };

    try {
      const batchResults = await deps.executor.runBatch(requests, batchCtx);
      for (const result of batchResults) {
        settledResults.set(result.toolCallId, result);
      }
    } catch (reason: unknown) {
      // execute 永不抛出（02 §2.4），此为防御性兜底；未收敛调用由 aggregate 补 INTERNAL
      this.diag("tool batch crashed", reason);
    }

    // 4) T11 batch.settled / T12 turn.cancelled → AggregatingResults
    const cancelled = ctx.signal.aborted;
    this.options.onTransition(cancelled ? "turn.cancelled" : "batch.settled");
    const aggregated = this.aggregate(entries, settledResults, {
      allBlocked: false,
      cancelled,
    });
    for (const record of aggregated.records) {
      await ctx.persistRecord?.(record);
    }

    // 5) PostToolUse hook（T5.1）：结果落库后逐实际执行调用触发；v1 非阻塞（block 不回滚已执行事实），
    //    additionalContext 经 dispatcher 缓冲注入下一轮。被拒/非法/取消的调用不触发。
    if (ctx.hooks !== undefined && !cancelled) {
      for (const entry of entries) {
        if (entry.blocked !== undefined) continue;
        const result = settledResults.get(entry.call.toolCallId);
        if (result === undefined) continue;
        await ctx.hooks.run({
          event: "PostToolUse",
          sessionId: this.options.sessionId,
          turnId: this.options.turnId,
          toolCallId: entry.call.toolCallId,
          toolName: entry.toolName,
          toolResponse: { content: result.content, isError: result.isError },
          signal: ctx.signal,
        });
      }
    }
    return aggregated;
  }

  // ---------------------------------------------------------------------------

  /** 审批事件出口（permission.requested/resolved 与 tool_call.* 共用同一 seq 分配链）。 */
  private permissionSink(): PermissionEventSink {
    return {
      emit: (name, build) => {
        this.options.emitPersisted(name, build);
      },
    };
  }

  /**
   * ask 收敛点：挂起等待审批应答/超时；turn 取消（T12）时提前以 deny 返回，
   * 由取消预检统一收敛为 CANCELLED（避免审批悬挂阻塞收束）。
   */
  private awaitApprovalWithAbort(
    permission: PermissionPort,
    grantId: string,
    signal: AbortSignal,
  ): Promise<"allow" | "deny"> {
    return new Promise<"allow" | "deny">((resolvePromise) => {
      let settled = false;
      const settle = (value: "allow" | "deny"): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolvePromise(value);
      };
      const onAbort = (): void => settle("deny");
      if (signal.aborted) {
        settle("deny");
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      permission.awaitApproval(grantId).then(
        (value) => settle(value),
        () => settle("deny"),
      );
    });
  }

  private plainEntry(call: PlannedToolCall, metadata: ToolMetadata): ScheduleEntry {
    return { call, toolName: call.toolName, input: parseLoose(call.argsJSON), metadata };
  }

  private makeBlocked(
    entry: ScheduleEntry,
    error: { code: ToolErrorCode; message: string },
  ): ToolResult {
    return {
      toolCallId: entry.call.toolCallId,
      toolName: entry.toolName,
      content: `${error.code}: ${error.message}`,
      error: { code: error.code, message: error.message },
      isError: true,
      truncated: false,
      durationMs: 0,
    };
  }

  private emitCompleted(result: ToolResult): void {
    this.options.emitPersisted("tool_call.completed", (seq, ts) =>
      buildToolCallCompletedEvent({
        seq,
        ts,
        sessionId: this.options.sessionId,
        toolCallId: result.toolCallId,
        isError: result.isError,
        ...(result.error !== undefined && {
          error: { code: result.error.code, message: result.error.message },
        }),
        contentPreview: previewOf(result.content),
        truncated: result.truncated,
        durationMs: result.durationMs,
      }),
    );
  }

  private publishThrottledProgress(
    event: ToolProgressEvent & { toolCallId: string },
    throttleMs: number,
  ): void {
    const now = Date.now();
    const window = this.progressWindow.get(event.toolCallId);
    if (window !== undefined && now - window.lastAt < throttleMs) {
      return;
    }
    const firstAt = window?.firstAt ?? now;
    this.progressWindow.set(event.toolCallId, { firstAt, lastAt: now });
    this.options.publishProgress((seq, ts) =>
      buildToolCallProgressEvent({
        seq,
        ts,
        sessionId: this.options.sessionId,
        toolCallId: event.toolCallId,
        stream: event.stream,
        text: event.text,
        elapsedMs: now - firstAt,
      }),
    );
  }

  private aggregate(
    entries: ScheduleEntry[],
    settledResults: Map<string, ToolResult>,
    flags: { allBlocked: boolean; cancelled: boolean },
  ): ToolPhaseResult {
    const results: ToolResult[] = [];
    const records: ToolPhaseResult["records"] = [];
    for (const entry of entries) {
      const result =
        settledResults.get(entry.call.toolCallId) ??
        this.makeBlocked(entry, {
          code: TOOL_ERROR_CODES.INTERNAL,
          message: "no result settled for tool call",
        });
      results.push(result);
      records.push({
        id: `msg_${ulid()}`,
        role: "tool",
        toolCallId: entry.call.toolCallId,
        content: result.content,
        isError: result.isError,
      });
    }
    return { results, records, allBlocked: flags.allBlocked, cancelled: flags.cancelled };
  }

  private diag(message: string, err?: unknown): void {
    this.options.onDiagnostic?.(message, err);
  }
}