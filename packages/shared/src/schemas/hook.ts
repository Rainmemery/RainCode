import { z } from "zod";
import { eventBaseSchema } from "./common.js";

/**
 * hooks 域（T5.1，06-api-spec §2.12 / §3 v1.12 additive）：hooks 生命周期 v1。
 *
 * - 配置形态：hooks.json（user = RAINCODE_HOME/hooks.json、project = <workspace>/.raincode/hooks.json），
 *   兼容 Claude Code hooks.json command 子集形态 { hooks: { <Event>: [{ matcher?, hooks: [...] }] } }；
 * - v1 四事件 PreToolUse / PostToolUse / UserPromptSubmit / Stop（PermissionRequest 等 M6+ 候选）；
 * - command 类型：argv 执行（不经 shell），timeoutMs 缺省 60s，async 后台运行（结果不回灌）；
 * - 输出契约：stdout 空 = no-op；JSON 输出 continue/reason/decision(approve|block)/systemMessage/
 *   suppressOutput/additionalContext/hookSpecificOutput.permissionDecision(allow|ask|deny)；
 *   exit code 2 = 显式 block；非 JSON / schema 不符 / 超时 / 其余非零退出 = failed（告警不阻塞主流程）；
 * - 事件：hook.started / hook.completed 为 rpc 事件（桌面/Web 执行投影，EVENT_SCHEMAS 登记）；
 *   hook.invoked / hook.result 为 log-only 审计事件对（dsh 语义：仅落 JSONL 不进 rpc 通道，
 *   stderr 截断落盘）——故不在 EVENT_SCHEMAS 注册（06 §3 v1.12 注记）；
 * - project 来源须 workspace trust 授信（hooks.trust.grant/revoke）且每 dispatch 前重验
 *   （授信绑定配置 digest，撤销/改文件立即失效）。
 */

/** hooks v1 生命周期事件（M6+ 候选：PermissionRequest / SessionStart 等）。 */
export const hookEventSchema = z.enum(["PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop"]);
export type HookEvent = z.infer<typeof hookEventSchema>;

/** 单个 command hook（06 §2.12；argv 执行，timeoutMs 缺省 60s，async 后台运行）。 */
export const hookCommandSchema = z.object({
  type: z.literal("command"),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  /** 进程级超时（ms）；缺省 60000（ZCode 蓝本口径），上限 10 分钟。 */
  timeoutMs: z.number().int().positive().max(600_000).optional(),
  /** true = 后台触发即返（结果不回灌主流程，仅审计）。 */
  async: z.boolean().optional(),
});
export type HookCommand = z.infer<typeof hookCommandSchema>;

/** matcher 组：matcher 为 JS 正则源串（对 PreToolUse/PostToolUse 匹配 toolName，其余事件匹配全部）；缺省全匹配。 */
export const hookMatcherGroupSchema = z.object({
  matcher: z.string().optional(),
  hooks: z.array(hookCommandSchema).min(1),
});
export type HookMatcherGroup = z.infer<typeof hookMatcherGroupSchema>;

/** 事件 → matcher 组列表（组按序执行，先 block 先生效）。 */
export const hooksEventsSchema = z.record(hookEventSchema, z.array(hookMatcherGroupSchema));
export type HooksEvents = z.infer<typeof hooksEventsSchema>;

/**
 * hooks.json 文档（读路径 strip）：user 与 project 双源共用形态（CC 兼容包装层）。
 * 损坏文件按源降级跳过（诊断告警不阻塞会话，同 mcp.json 域空转口径）。
 */
export const hooksFileSchema = z.object({ hooks: hooksEventsSchema.optional() });
export type HooksFile = z.infer<typeof hooksFileSchema>;

/** hooks.json 写路径（strict：未知字段拒绝，04 §5.1 同 config.json 写口径）。 */
export const hooksFileStrictSchema = z
  .object({ hooks: z.record(hookEventSchema, z.array(hookMatcherGroupSchema.strict())).optional() })
  .strict();

/** hook 进程 stdin 输入（06 §2.12 v1 契约：一次一个 JSON 对象）。 */
export const hookInputSchema = z.object({
  event: hookEventSchema,
  sessionId: z.string(),
  turnId: z.string().optional(),
  session_id: z.string().optional(), // CC 兼容别名（snake_case）
  /** PreToolUse/PostToolUse 携带。 */
  toolName: z.string().optional(),
  toolInput: z.unknown().optional(),
  toolResponse: z
    .object({ content: z.string(), isError: z.boolean() })
    .optional(),
  /** UserPromptSubmit 携带。 */
  prompt: z.string().optional(),
  /** Stop 携带：true = 本次收束由 Stop hook 续跑触发（防续跑风暴；v1 无续跑语义，恒 false 保留字段）。 */
  stopHookActive: z.boolean().optional(),
});
export type HookInput = z.infer<typeof hookInputSchema>;

/** hookSpecificOutput（CC 兼容子集：additionalContext / permissionDecision + reason）。 */
export const hookSpecificOutputSchema = z.object({
  hookEventName: hookEventSchema.optional(),
  additionalContext: z.string().optional(),
  permissionDecision: z.enum(["allow", "ask", "deny"]).optional(),
  permissionDecisionReason: z.string().optional(),
});
export type HookSpecificOutput = z.infer<typeof hookSpecificOutputSchema>;

/**
 * hook 进程 stdout 输出契约（strict：未知字段视为 schema 不符 → failed，T5.1 验收口径）。
 * block 判定：decision:"block" | continue:false | hookSpecificOutput.permissionDecision:"deny" | exit code 2。
 */
export const hookOutputSchema = z
  .object({
    continue: z.boolean().optional(),
    reason: z.string().optional(),
    decision: z.enum(["approve", "block"]).optional(),
    systemMessage: z.string().optional(),
    suppressOutput: z.boolean().optional(),
    additionalContext: z.string().optional(),
    stopReason: z.string().optional(),
    hookSpecificOutput: hookSpecificOutputSchema.optional(),
  })
  .strict();
export type HookOutput = z.infer<typeof hookOutputSchema>;

// ---------------------------------------------------------------------------
// hook 执行事件（rpc 投影，06 §3 v1.12：桌面/Web hook 执行实时展示；persisted 落 JSONL）
// ---------------------------------------------------------------------------

/** 单次 dispatch 生命周期结果聚合口径（一次 dispatch = 一个事件源匹配组集合的执行）。 */
export const hookOutcomeSchema = z.enum([
  "success", // 全部 hook 正常收敛（含空 stdout no-op）
  "blocked", // 任一 hook 判定 block（PreToolUse 拦截 / UserPromptSubmit 拒绝）
  "failed", // 任一 hook 解析失败/非零退出（告警不阻塞）
  "timed_out", // 任一 hook 超时
  "skipped_untrusted", // project hook 未授信（或授信 digest 失效）——未执行任何进程
]);
export type HookOutcome = z.infer<typeof hookOutcomeSchema>;

export const hookStartedEventPayloadSchema = eventBaseSchema.extend({
  sessionId: z.string(),
  turnId: z.string().optional(),
  /** dispatch 实例 ID（started/completed 配对键）。 */
  invocationId: z.string(),
  phase: hookEventSchema,
  /** 本次实际执行的 hook 标识（<source>:<event>:<ordinal>）。 */
  hookIds: z.array(z.string()),
  async: z.boolean(),
});
export type HookStartedEventPayload = z.infer<typeof hookStartedEventPayloadSchema>;

export const hookCompletedEventPayloadSchema = eventBaseSchema.extend({
  sessionId: z.string(),
  turnId: z.string().optional(),
  invocationId: z.string(),
  phase: hookEventSchema,
  hookIds: z.array(z.string()),
  outcome: hookOutcomeSchema,
  /** blocked=true 时的拒绝理由（hook reason / permissionDecisionReason）。 */
  reason: z.string().optional(),
  /** 聚合 decision（任一 block → block）。 */
  decision: z.enum(["approve", "block"]).optional(),
  /** additionalContext / systemMessage 已注入（UI 提示用布尔，正文经 provenance 进上下文不重复广播）。 */
  contextInjected: z.boolean().optional(),
  durationMs: z.number().int().nonnegative(),
});
export type HookCompletedEventPayload = z.infer<typeof hookCompletedEventPayloadSchema>;

export function buildHookStartedEvent(
  input: Omit<HookStartedEventPayload, "ts"> & { ts?: number },
): HookStartedEventPayload {
  return hookStartedEventPayloadSchema.parse({ ...input, ts: input.ts ?? Date.now() });
}

export function buildHookCompletedEvent(
  input: Omit<HookCompletedEventPayload, "ts"> & { ts?: number },
): HookCompletedEventPayload {
  return hookCompletedEventPayloadSchema.parse({ ...input, ts: input.ts ?? Date.now() });
}

// ---------------------------------------------------------------------------
// 审计事件对（log-only：仅落 JSONL，不进 rpc 通道与 EVENT_SCHEMAS；dsh hook/invoked + hook/result 语义）
// ---------------------------------------------------------------------------

/** hook.invoked（dispatch 即记：含未授信跳过——审计先于执行事实）。 */
export const hookInvokedPayloadSchema = eventBaseSchema.extend({
  sessionId: z.string(),
  turnId: z.string().optional(),
  invocationId: z.string(),
  phase: hookEventSchema,
  /** 计划执行的 hook 明细（含来源与命令；untrustedSkipped>0 时仅含实际放行项）。 */
  hooks: z.array(
    z.object({
      hookId: z.string(),
      source: z.enum(["user", "project"]),
      command: z.string(),
      args: z.array(z.string()).optional(),
      timeoutMs: z.number().int().positive().optional(),
      async: z.boolean(),
    }),
  ),
  /** project hook 因未授信被跳过的数量（>0 即有 hook 未执行）。 */
  untrustedSkipped: z.number().int().nonnegative(),
  /** dispatch 前 workspace trust 校验结果（project 源不存在时缺省）。 */
  trusted: z.boolean().optional(),
});
export type HookInvokedPayload = z.infer<typeof hookInvokedPayloadSchema>;

/** hook.result（per hook：exit code / stderr 截断 ≤500 字符 / 时长；进程未跑无对应条目）。 */
export const hookResultPayloadSchema = eventBaseSchema.extend({
  sessionId: z.string(),
  turnId: z.string().optional(),
  invocationId: z.string(),
  phase: hookEventSchema,
  hookId: z.string(),
  outcome: hookOutcomeSchema,
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative(),
  /** stderr 尾部截断（500 字符硬上限，落盘前完成截断）。 */
  stderr: z.string().max(500),
  /** stdout 原始捕获头部（≤2048 字符；解析失败时人工诊断用）。 */
  stdout: z.string().max(2048),
  reason: z.string().optional(),
});
export type HookResultPayload = z.infer<typeof hookResultPayloadSchema>;

export function buildHookInvokedPayload(
  input: Omit<HookInvokedPayload, "ts"> & { ts?: number },
): HookInvokedPayload {
  return hookInvokedPayloadSchema.parse({ ...input, ts: input.ts ?? Date.now() });
}

export function buildHookResultPayload(
  input: Omit<HookResultPayload, "ts"> & { ts?: number },
): HookResultPayload {
  return hookResultPayloadSchema.parse({ ...input, ts: input.ts ?? Date.now() });
}

// ---------------------------------------------------------------------------
// hooks 域方法（06 §2.12 v1.12：hooks.list / hooks.trust.grant / hooks.trust.revoke）
// ---------------------------------------------------------------------------

/** hooks.list 返回项：单配置源投影（低频控制面，坏文件只产 error 注记不抛）。 */
export const hookSourceInfoSchema = z.object({
  source: z.enum(["user", "project"]),
  path: z.string(),
  /** 文件存在且解析成功；false 时 error 注明原因。 */
  loaded: z.boolean(),
  error: z.string().optional(),
  /** 已登记事件名（键序）。 */
  events: z.array(z.string()),
  /** 已登记 hook 总数（跨 matcher 组）。 */
  hookCount: z.number().int().nonnegative(),
  /** project 专属：当前授信状态（user 恒 true——用户自有配置不设门）。 */
  trusted: z.boolean().optional(),
  /** project 专属：授信绑定的配置 digest（无授信或缺省省略）。 */
  trustedDigest: z.string().optional(),
});
export type HookSourceInfo = z.infer<typeof hookSourceInfoSchema>;

export const hooksListParamsSchema = z.strictObject({
  sessionId: z.string().optional(),
});
export type HooksListParams = z.infer<typeof hooksListParamsSchema>;

export const hooksListResultSchema = z.object({
  items: z.array(hookSourceInfoSchema),
});
export type HooksListResult = z.infer<typeof hooksListResultSchema>;

/** 授信（按会话工作区）：绑定当前 project hooks 配置 digest；改动 hooks.json 后须重新授信。 */
export const hooksTrustGrantParamsSchema = z.strictObject({
  sessionId: z.string().min(1),
});
export type HooksTrustGrantParams = z.infer<typeof hooksTrustGrantParamsSchema>;

export const hooksTrustGrantResultSchema = z.object({
  workspaceId: z.string(),
  digest: z.string(),
  hookCount: z.number().int().nonnegative(),
});
export type HooksTrustGrantResult = z.infer<typeof hooksTrustGrantResultSchema>;

export const hooksTrustRevokeParamsSchema = z.strictObject({
  sessionId: z.string().min(1),
});
export type HooksTrustRevokeParams = z.infer<typeof hooksTrustRevokeParamsSchema>;

export const hooksTrustRevokeResultSchema = z.object({
  workspaceId: z.string(),
  trusted: z.boolean(),
});
export type HooksTrustRevokeResult = z.infer<typeof hooksTrustRevokeResultSchema>;
