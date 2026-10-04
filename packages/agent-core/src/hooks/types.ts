/**
 * hooks 端口与内部结果类型（T5.1，agent-core 侧）。
 *
 * HooksPort 是 server（HooksRuntime）注入的窄端口：配置装载 + project trust 每 dispatch 前重验
 * + 进程编排都在实现侧；agent-core 只负责生命周期接线、事件投影与上下文回灌。
 * 引擎内部结果（HookRunResult）与端口结果（HookDispatchResult）分离：前者 per hook 进程事实，
 * 后者 per dispatch 聚合决策——audit hook/result 消费前者、hook.completed 消费后者。
 */
import type { HookEvent } from "@raincode/shared";

/** 单 hook 进程执行结果（runner 收敛口径；引擎永不抛）。 */
export interface HookRunResult {
  hookId: string;
  event: HookEvent;
  outcome: "success" | "blocked" | "failed" | "timed_out";
  exitCode: number | null;
  durationMs: number;
  /** 原始捕获（audit 落盘前另行截断）。 */
  stderr: string;
  stdout: string;
  reason?: string;
  decision?: "approve" | "block";
  additionalContext?: string;
  systemMessage?: string;
  suppressOutput?: boolean;
}

/** dispatch 请求（生命周期接线点的现场投影；字段按事件可选）。 */
export interface HookDispatchRequest {
  event: HookEvent;
  sessionId: string;
  turnId: string;
  toolCallId?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResponse?: { content: string; isError: boolean };
  prompt?: string;
  /** Stop 携带（字段直通 wire 契约；v1 恒 false——续跑语义属 M6+）。 */
  stopHookActive?: boolean;
  /** turn 取消联动（abort 时实现侧应终止 hook 进程，防取消被 hook 超时拖住）。 */
  signal?: AbortSignal;
  /**
   * async hook 完成后的补记回调（实现侧注入 dispatcher.emitRunAudit 绑定；仅补审计不回灌主流程）。
   * 缺省时 async hook 结果静默丢弃（诊断兜底）。
   */
  onAsyncResult?: (run: HookRunResult) => void;
}

/** 单 hook 的 dispatch 视图（audit hook.invoked 的明细来源；实现侧产出）。 */
export interface HookPlanEntry {
  hookId: string;
  source: "user" | "project";
  command: string;
  args?: string[];
  timeoutMs?: number;
  async: boolean;
}

/** dispatch 结果（聚合决策 + per-hook 事实；实现侧永不抛）。 */
export interface HookDispatchResult {
  /** 任一 hook 判定 block（或 exit 2）。 */
  blocked: boolean;
  reason?: string;
  /** 聚合 additionalContext（多 hook 按执行序拼接）。 */
  additionalContext?: string;
  systemMessage?: string;
  suppressOutput: boolean;
  /** 本次实际执行的 hook 标识（provenance 溯源数据源）。 */
  hookIds: string[];
  /** 计划明细（audit hook.invoked 数据源；空 = 未配置任何 hook）。 */
  plan: HookPlanEntry[];
  /** project hook 因未授信被跳过的数量。 */
  untrustedSkipped: number;
  /** per-hook 进程事实（audit hook.result 逐条落盘；async hook 完成后补记）。 */
  runs: HookRunResult[];
}

/** hooks 端口（server HooksRuntime 实现；agent-core 生命周期接线消费）。 */
export interface HooksPort {
  dispatch(request: HookDispatchRequest): Promise<HookDispatchResult>;
}

/** hook 注入上下文的溯源条目（provenance：hookPhase + hookIds，T5.1 验收口径）。 */
export interface HookContextEntry {
  phase: HookEvent;
  hookIds: string[];
  text: string;
}
