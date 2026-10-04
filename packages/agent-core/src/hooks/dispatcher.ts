/**
 * HookDispatcher：hooks 生命周期 dispatch 的 agent-core 单点（T5.1）。
 *
 * 职责边界：server（HooksRuntime）提供 HooksPort（配置/trust/进程编排）；本层负责——
 * - 事件投影：hook.started / hook.completed（persisted rpc 事件，先落 JSONL 再发布）；
 * - 审计对：hook.invoked（dispatch 即记，含未授信跳过计数）+ hook.result（per hook 进程事实，
 *   stderr 截断 ≤500 字符落盘）——log-only，不进 rpc 通道（dsh 审计语义）；
 * - additionalContext 回灌：provenance 条目（hookPhase + hookIds）入会话级缓冲，下一轮
 *   assembleChatMessages 排空注入（turn-loop 单点）。
 * 引擎永不抛出：port 缺省（未装配）→ 空 result no-op；port 拒绝 → failed 收敛。
 * 热路径护栏：plan 为空（未配置 hook）时零事件零审计（NFR-2 工具链路不受影响）。
 */
import { buildHookCompletedEvent, buildHookStartedEvent } from "@raincode/shared";
import type {
  HookContextEntry,
  HookDispatchRequest,
  HookDispatchResult,
  HookRunResult,
  HooksPort,
} from "./types.js";

/** 空 dispatch（port 缺省/未配置 hook 的统一 no-op 形态）。 */
export const emptyHookDispatchResult: HookDispatchResult = {
  blocked: false,
  suppressOutput: false,
  hookIds: [],
  plan: [],
  untrustedSkipped: 0,
  runs: [],
};

export interface HookDispatcherDeps {
  /** null = hooks 域未装配（全部 no-op）。 */
  port: HooksPort | null;
  sessionId: string;
  /** persisted rpc 事件出口（LoopEvents.emitPersisted；turn-loop 单写者链）。 */
  emitPersisted: (name: "hook.started" | "hook.completed", build: (seq: number, ts: number) => unknown) => void;
  /** log-only 审计出口（LoopEvents.emitAudit：落 JSONL 不发布）。 */
  emitAudit: (name: "hook.invoked" | "hook.result", build: (seq: number, ts: number) => unknown) => void;
  onDiagnostic?: (message: string, err?: unknown) => void;
}

/** audit stderr 截断上限（T5.1 验收口径：stderr 截断落盘 ≤500 字符）。 */
const AUDIT_STDERR_MAX_CHARS = 500;

export class HookDispatcher {
  /** 会话级 additionalContext 缓冲（provenance 条目；下一轮上下文组装时排空）。 */
  private readonly contextBuffer: HookContextEntry[] = [];

  constructor(private readonly deps: HookDispatcherDeps) {}

  /**
   * 生命周期 dispatch：started → invoked(audit) → port → result(audit per hook) → completed。
   * 返回聚合决策；plan 为空（未配置 hook）零副作用直接返回。
   */
  async run(request: HookDispatchRequest): Promise<HookDispatchResult> {
    if (this.deps.port === null) return emptyHookDispatchResult;
    const invocationId = `hook_${request.turnId}_${Date.now().toString(36)}_${
      Math.random().toString(36).slice(2, 8)
    }`;
    const phase = request.event;
    let result: HookDispatchResult;
    try {
      result = await this.deps.port.dispatch({
        ...request,
        // async hook 完成补记（invocationId 先于 dispatch 生成，异步审计与同步审计同键配对）
        onAsyncResult: (run) => this.emitRunAudit(invocationId, request, run),
      });
    } catch (reason: unknown) {
      this.diag("hooks dispatch crashed; treated as no-op", reason);
      return emptyHookDispatchResult;
    }
    if (result.plan.length === 0 && result.untrustedSkipped === 0) {
      return emptyHookDispatchResult; // 无 hook 配置：零事件零审计（热路径护栏）
    }

    this.deps.emitPersisted("hook.started", (seq, ts) =>
      buildHookStartedEvent({
        seq, ts, sessionId: request.sessionId, turnId: request.turnId, invocationId,
        phase, hookIds: result.hookIds, async: result.plan.some((entry) => entry.async),
      }),
    );
    this.deps.emitAudit("hook.invoked", (seq, ts) => ({
      seq, ts, sessionId: request.sessionId, turnId: request.turnId, invocationId,
      phase, hooks: result.plan, untrustedSkipped: result.untrustedSkipped,
    }));

    for (const run of result.runs) {
      this.emitRunAudit(invocationId, request, run);
    }

    this.deps.emitPersisted("hook.completed", (seq, ts) =>
      buildHookCompletedEvent({
        seq, ts, sessionId: request.sessionId, turnId: request.turnId, invocationId,
        phase, hookIds: result.hookIds,
        outcome: result.untrustedSkipped > 0 && result.runs.length === 0
          ? "skipped_untrusted"
          : aggregateOutcome(result.runs),
        ...(result.reason !== undefined && { reason: result.reason }),
        ...(result.blocked && { decision: "block" as const }),
        ...(result.additionalContext !== undefined && { contextInjected: true }),
        durationMs: result.runs.reduce((total, run) => total + run.durationMs, 0),
      }),
    );

    if (result.additionalContext !== undefined && result.additionalContext.length > 0) {
      this.contextBuffer.push({
        phase,
        hookIds: result.hookIds.length > 0 ? result.hookIds : ["<untrusted-skipped>"],
        text: result.additionalContext,
      });
    }
    return result;
  }

  /** async hook 完成后的补记（实现侧回调；只补审计不回灌主流程）。 */
  emitRunAudit(invocationId: string, request: HookDispatchRequest, run: HookRunResult): void {
    this.deps.emitAudit("hook.result", (seq, ts) => ({
      seq, ts, sessionId: request.sessionId, turnId: request.turnId, invocationId,
      phase: request.event, hookId: run.hookId, outcome: run.outcome,
      exitCode: run.exitCode, durationMs: run.durationMs,
      stderr: truncate(run.stderr, AUDIT_STDERR_MAX_CHARS),
      stdout: run.stdout.slice(0, 2048),
      ...(run.reason !== undefined && { reason: run.reason }),
    }));
  }

  /** 排空 additionalContext 缓冲（下一轮上下文组装单点；provenance 由消费方标注）。 */
  drainContext(): HookContextEntry[] {
    if (this.contextBuffer.length === 0) return [];
    return this.contextBuffer.splice(0, this.contextBuffer.length);
  }

  private diag(message: string, err?: unknown): void {
    this.deps.onDiagnostic?.(message, err);
  }
}

/** 聚合口径：任一 blocked > 任一 timed_out > 任一 failed > success。 */
function aggregateOutcome(runs: readonly HookRunResult[]): "success" | "blocked" | "failed" | "timed_out" {
  if (runs.some((run) => run.outcome === "blocked")) return "blocked";
  if (runs.some((run) => run.outcome === "timed_out")) return "timed_out";
  if (runs.some((run) => run.outcome === "failed")) return "failed";
  return "success";
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(text.length - max)}` : text;
}
