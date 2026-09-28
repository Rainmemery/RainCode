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
import { ulid } from "@novacode/storage";
import {
  TOOL_ERROR_CODES,
  buildToolCallCompletedEvent,
  buildToolCallProgressEvent,
  buildToolCallStartedEvent,
} from "@novacode/shared";
import type { ToolErrorCode, ToolMetadata, ToolResult } from "@novacode/shared";
import type { BackgroundTaskRegistry, ToolCallRequest, ToolProgressEvent } from "@novacode/tools";
import type { ToolPhaseDeps } from "../ports.js";

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
  /** bash runInBackground 等后台能力（与 server tool.background.* 方法共享同一单例）。 */
  background: BackgroundTaskRegistry;
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
  /** 持久事件出口（started/completed 先落 JSONL 再发布；turn-loop 单点实现）。 */
  emitPersisted: (
    name: "tool_call.started" | "tool_call.completed",
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

const CONTENT_PREVIEW_MAX_CHARS = 120;

interface ScheduleEntry {
  call: PlannedToolCall;
  toolName: string;
  input: unknown;
  metadata: ToolMetadata;
  /** 非空 = 调度期已被拒/非法（不进执行批次）。 */
  blocked?: ToolResult;
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

    // 权限判定（仅 zod 合法的调用；02 §2.4：入参非法不进权限）
    for (const entry of entries) {
      if (entry.blocked !== undefined) {
        continue;
      }
      let verdict: "allow" | "deny";
      try {
        verdict = await deps.permission.evaluate({
          toolName: entry.toolName,
          input: entry.input,
          metadata: entry.metadata,
        });
      } catch (reason: unknown) {
        this.diag("permission evaluate crashed; deny by fail-safe", reason);
        verdict = "deny";
      }
      if (verdict === "deny") {
        entry.blocked = this.makeBlocked(entry, {
          code: TOOL_ERROR_CODES.PERMISSION_DENIED,
          message: `user denied execution of ${entry.toolName}`,
        });
      }
    }

    // 2) tool_call.started（全部调用，含待审批/被拒，06 §3.2）
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

    // 3) ToolExecution（T9）：只读并行 ≤4、写串行（02 §2.2）
    this.options.onTransition("schedule.ready");
    const progressThrottleMs = this.options.progressThrottleMs ?? 500;
    const requests: ToolCallRequest[] = executable.map((entry) => ({
      toolCallId: entry.call.toolCallId,
      toolName: entry.toolName,
      args: entry.input,
    }));

    try {
      const batchResults = await deps.executor.runBatch(requests, {
        signal: ctx.signal,
        workspaceRoot: ctx.workspaceRoot,
        cwd: ctx.cwd,
        sessionKey: ctx.sessionKey,
        background: ctx.background,
        onToolProgress: (event: ToolProgressEvent & { toolCallId: string }) => {
          this.publishThrottledProgress(event, progressThrottleMs);
        },
        onSettled: (result) => {
          this.emitCompleted(result);
        },
      });
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
    return aggregated;
  }

  // ---------------------------------------------------------------------------

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

function parseLoose(argsJSON: string): unknown {
  try {
    return JSON.parse(argsJSON);
  } catch {
    return argsJSON;
  }
}

function unknownToolMetadata(): ToolMetadata {
  return {
    readOnly: false,
    destructive: false,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  };
}

function previewOf(content: string): string {
  const firstLine = content.split("\n", 1)[0] ?? "";
  return firstLine.length > CONTENT_PREVIEW_MAX_CHARS
    ? `${firstLine.slice(0, CONTENT_PREVIEW_MAX_CHARS)}…`
    : firstLine;
}
