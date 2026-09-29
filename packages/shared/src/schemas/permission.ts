import { z } from "zod";
import {
  collaborationModeSchema,
  eventBaseSchema,
  pageParamsSchema,
  permissionRequestedPayloadSchema,
  ruleBehaviorSchema,
} from "./common.js";
// 复用结构（common.ts 单点定义）：MatchedBy 判定命中来源、RuleBehavior 规则行为
export { matchedBySchema, ruleBehaviorSchema } from "./common.js";
import { matchedBySchema } from "./common.js";

/**
 * permission 域（06-api-spec §2.2 / §3.2 B 组 / §4.3 段 2；02-module-design §6）。
 * 只放 schema、纯类型、常量与事件构造函数，禁止业务行为（04 §2.4 铁律 2）。
 *
 * 偏差注记（交付报告申报）：任务交付要求错误码使用 PC_* 前缀（06 §4.3 段 2 原文为 PERM_*），
 * 且要求 grantId 复用报错（06 §2.0 幂等约定为返回 alreadyResolved）——按任务实现。
 */

// ---------------------------------------------------------------------------
// 错误码常量（任务交付：PC_* 前缀）
// ---------------------------------------------------------------------------

export const PC_ERROR_CODES = {
  /** grantId 不存在（06 §4.3 PERM_GRANT_NOT_FOUND 的 PC_* 实现）。 */
  GRANT_NOT_FOUND: "PC_GRANT_NOT_FOUND",
  /** grantId 单消费：首个 respond 生效，重复 respond 报错（任务交付要求）。 */
  GRANT_CONSUMED: "PC_GRANT_CONSUMED",
  /** 规则非法（如非 bash 工具配 pattern；06 §4.3 PERM_RULE_INVALID）。 */
  RULE_INVALID: "PC_RULE_INVALID",
  /** 规则 id 不存在（06 §4.3 PERM_RULE_NOT_FOUND）。 */
  RULE_NOT_FOUND: "PC_RULE_NOT_FOUND",
} as const;
export type PcErrorCode = (typeof PC_ERROR_CODES)[keyof typeof PC_ERROR_CODES];

// ---------------------------------------------------------------------------
// 核心结构（02 §6.3 PermissionRule / PermissionDecisionRecord）
// ---------------------------------------------------------------------------

export const permissionDecisionSchema = z.enum(["allow", "ask", "deny"]);
export type PermissionDecision = z.infer<typeof permissionDecisionSchema>;

export const ruleScopeSchema = z.enum(["session", "project", "global"]);
export type RuleScope = z.infer<typeof ruleScopeSchema>;

/** 匹配语义（任务交付字段；02 §6.3 未定义，缺省 wildcard——偏差申报）。 */
export const ruleMatchTypeSchema = z.enum(["wildcard", "exact", "regex"]);
export type RuleMatchType = z.infer<typeof ruleMatchTypeSchema>;

/**
 * 权限规则（02 §6.3）。字段名 behavior 对齐 05 §3.6 CHECK 与 06 §2.2 rules.add
 * （allow|deny|ask；任务描述的 decision: allow|deny 视为简写）。
 */
export const permissionRuleSchema = z.object({
  id: z.string(),
  scope: ruleScopeSchema,
  tool: z.string(),
  matchType: ruleMatchTypeSchema.optional(),
  /** 通配/精确/正则模式；null/缺省 = 匹配该工具全部调用（02 §6.3）。 */
  pattern: z.string().nullable().optional(),
  behavior: ruleBehaviorSchema,
  source: z.enum(["user", "allow-always", "import"]),
  createdAt: z.number(),
});
export type PermissionRule = z.infer<typeof permissionRuleSchema>;

/** 审计记录（05 §3.8 permission_decisions 投影；permission.decisions.list 返回项）。 */
export const permissionDecisionRecordSchema = z.object({
  id: z.number(),
  ts: z.number(),
  sessionId: z.string(),
  workspaceId: z.string(),
  toolName: z.string(),
  mode: collaborationModeSchema,
  decision: permissionDecisionSchema,
  matchedBy: matchedBySchema,
  ruleId: z.string().nullable().optional(),
  grantId: z.string().nullable().optional(),
  reason: z.string(),
  /** 归一化输入摘要（脱敏：参数截断 + apiKey 模式抹除）。 */
  inputDigest: z.string(),
  respondLatencyMs: z.number().nullable().optional(),
});
export type PermissionDecisionRecord = z.infer<typeof permissionDecisionRecordSchema>;

// ---------------------------------------------------------------------------
// permission.respond（06 §2.2；grantId 单消费）
// ---------------------------------------------------------------------------

export const permissionRespondParamsSchema = z.strictObject({
  grantId: z.string(),
  decision: z.enum(["allow", "deny"]),
  always: z.boolean().optional(),
  scope: ruleScopeSchema.optional(),
  /**
   * ask_user_question 通道的自由文本应答（T2.7 P1；capability: permission.respond.answer）。
   * 仅 decision=allow 且 toolName=ask_user_question 的审批单有语义：应答文本经
   * permission.resolved 事件与 askAndWait 等待侧透出（approvals 表不加列，不落库）。
   */
  answerText: z.string().optional(),
});
export type PermissionRespondParams = z.infer<typeof permissionRespondParamsSchema>;

export const permissionRespondResultSchema = z.object({
  resolved: z.boolean(),
  alreadyResolved: z.boolean().optional(),
  decision: z.enum(["allow", "deny"]).optional(),
  ruleId: z.string().optional(),
});
export type PermissionRespondResult = z.infer<typeof permissionRespondResultSchema>;

// ---------------------------------------------------------------------------
// permission.rules.list / add / remove（06 §2.2）
// ---------------------------------------------------------------------------

export const permissionRulesListParamsSchema = z.strictObject({
  scope: ruleScopeSchema.optional(),
  tool: z.string().optional(),
});
export type PermissionRulesListParams = z.infer<typeof permissionRulesListParamsSchema>;

export const permissionRulesListResultSchema = z.object({
  rules: z.array(permissionRuleSchema),
});
export type PermissionRulesListResult = z.infer<typeof permissionRulesListResultSchema>;

/** rules.add scope 仅允许 project/global（session 驻内存不入库，05 §3.6；落点为审批 respond always）。 */
export const permissionRulesAddParamsSchema = z.strictObject({
  scope: z.enum(["project", "global"]),
  tool: z.string().min(1),
  pattern: z.string().optional(),
  matchType: ruleMatchTypeSchema.optional(),
  behavior: ruleBehaviorSchema,
});
export type PermissionRulesAddParams = z.infer<typeof permissionRulesAddParamsSchema>;

export const permissionRulesAddResultSchema = z.object({
  rule: permissionRuleSchema,
});
export type PermissionRulesAddResult = z.infer<typeof permissionRulesAddResultSchema>;

export const permissionRulesRemoveParamsSchema = z.strictObject({
  id: z.string(),
});
export type PermissionRulesRemoveParams = z.infer<typeof permissionRulesRemoveParamsSchema>;

export const permissionRulesRemoveResultSchema = z.object({
  removed: z.boolean(),
});
export type PermissionRulesRemoveResult = z.infer<typeof permissionRulesRemoveResultSchema>;

// ---------------------------------------------------------------------------
// permission.decisions.list（06 §2.2 审计只读查询）
// ---------------------------------------------------------------------------

export const permissionDecisionsListParamsSchema = z.strictObject({
  sessionId: z.string().optional(),
  toolName: z.string().optional(),
  decision: permissionDecisionSchema.optional(),
  since: z.number().optional(),
  page: pageParamsSchema.optional(),
});
export type PermissionDecisionsListParams = z.infer<typeof permissionDecisionsListParamsSchema>;

export const permissionDecisionsListResultSchema = z.object({
  items: z.array(permissionDecisionRecordSchema),
  nextCursor: z.string().optional(),
});
export type PermissionDecisionsListResult = z.infer<typeof permissionDecisionsListResultSchema>;

// ---------------------------------------------------------------------------
// 事件 payload（06 §3.2 B 组；permission.requested 主体复用 common.ts 审批单结构）
// ---------------------------------------------------------------------------

export const permissionRequestedEventPayloadSchema = eventBaseSchema.extend(
  permissionRequestedPayloadSchema.shape,
);
export type PermissionRequestedEventPayload = z.infer<typeof permissionRequestedEventPayloadSchema>;

export const permissionResolvedEventPayloadSchema = eventBaseSchema.extend({
  grantId: z.string(),
  decision: z.enum(["allow", "deny"]),
  always: z.boolean().optional(),
  scope: ruleScopeSchema.optional(),
  /** user=respond 到达；timeout=审批超时（默认 120s 视为 deny）；offline=离线兜底。 */
  by: z.enum(["user", "timeout", "offline"]),
  ruleId: z.string().optional(),
  respondLatencyMs: z.number(),
  /** ask_user_question 通道的用户应答文本（T2.7 P1 可选扩展；出参宽松，旧端忽略）。 */
  answerText: z.string().optional(),
});
export type PermissionResolvedEventPayload = z.infer<typeof permissionResolvedEventPayloadSchema>;

// ---------------------------------------------------------------------------
// 事件构造函数（06 §5：出口即合法；seq 由会话事件流分配，ts 缺省取当前时刻）
// ---------------------------------------------------------------------------

export function buildPermissionRequestedEvent(
  input: Omit<PermissionRequestedEventPayload, "ts"> & { ts?: number },
): PermissionRequestedEventPayload {
  return permissionRequestedEventPayloadSchema.parse({ ...input, ts: input.ts ?? Date.now() });
}

export function buildPermissionResolvedEvent(
  input: Omit<PermissionResolvedEventPayload, "ts"> & { ts?: number },
): PermissionResolvedEventPayload {
  return permissionResolvedEventPayloadSchema.parse({ ...input, ts: input.ts ?? Date.now() });
}
