import { z } from "zod";
import { eventBaseSchema, tokenUsageSchema } from "./common.js";

/**
 * subagent 域（06-api-spec §2.5 / §3.2 C 组）：子代理派发受理 + 镜像事件。
 * 状态机 S1–S6 与镜像映射表见 02-module-design §4；模型侧经 `agent` 工具派发（02 §4.3），
 * 本域为控制面入口（端层面板/诊断用），执行进展不轮询、一律经 `subagent.*` 事件镜像推送。
 */

// ---------------------------------------------------------------------------
// 状态与 profile 结构（02 §4.2 状态机五态 / §4.3 SubagentProfile）
// ---------------------------------------------------------------------------

/** 子代理运行状态（02 §4.2 S1–S6 的 5 态投影）。 */
export const subagentStatusSchema = z.enum(["Pending", "Running", "Completed", "Failed", "Stopped"]);
export type SubagentStatus = z.infer<typeof subagentStatusSchema>;

/**
 * profile 内联形态：模型经 `agent` 工具直接传对象时的入参（文件形态的 markdown+frontmatter
 * 解析属 agent-core profile.ts，此处只约束协议面）；maxTurns 硬上限 100（02 §4.3）。
 */
export const subagentProfileInlineSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9-]+$/, "name must match [a-z0-9-]+"),
    description: z.string().min(1),
    tools: z.array(z.string().min(1)).optional(),
    model: z.string().min(1).optional(),
    maxTurns: z.number().int().min(1).max(100).optional(),
  })
  .strict();
export type SubagentProfileInline = z.infer<typeof subagentProfileInlineSchema>;

// ---------------------------------------------------------------------------
// 控制面方法（06 §2.5 subagent 域 4 方法）
// ---------------------------------------------------------------------------

export const subagentSpawnParamsSchema = z.strictObject({
  sessionId: z.string(),
  /** string = 按 name 解析（`.raincode/agents/*.md`）；对象 = 内联 profile。 */
  profile: z.union([z.string().min(1), subagentProfileInlineSchema]),
  task: z.string().min(1),
});
export type SubagentSpawnParams = z.infer<typeof subagentSpawnParamsSchema>;

export const subagentSpawnResultSchema = z.object({
  subagentId: z.string(),
  status: z.enum(["Pending", "Running"]),
  queuePosition: z.number().int().min(1).optional(),
});
export type SubagentSpawnResult = z.infer<typeof subagentSpawnResultSchema>;

export const subagentStopParamsSchema = z.strictObject({
  subagentId: z.string(),
  reason: z.string().optional(),
});
export type SubagentStopParams = z.infer<typeof subagentStopParamsSchema>;

export const subagentStopResultSchema = z.object({
  stopped: z.boolean(),
  status: subagentStatusSchema,
});
export type SubagentStopResult = z.infer<typeof subagentStopResultSchema>;

/** 子代理信息（subagent.list 项；06 §2.5）。 */
export const subagentInfoSchema = z.object({
  id: z.string(),
  profileName: z.string(),
  status: subagentStatusSchema,
  /** ISO 时刻。 */
  startedAt: z.string().optional(),
  usage: tokenUsageSchema.optional(),
  turnsUsed: z.number().int().nonnegative().optional(),
});
export type SubagentInfo = z.infer<typeof subagentInfoSchema>;

export const subagentListParamsSchema = z.strictObject({
  sessionId: z.string().optional(),
});
export type SubagentListParams = z.infer<typeof subagentListParamsSchema>;

export const subagentListResultSchema = z.object({
  items: z.array(subagentInfoSchema),
});
export type SubagentListResult = z.infer<typeof subagentListResultSchema>;

/** profile 清单摘要（subagent.profiles.list 项；frontmatter 投影，02 §4.3）。 */
export const subagentProfileSummarySchema = z.object({
  name: z.string(),
  description: z.string(),
  source: z.enum(["workspace", "global"]),
  tools: z.array(z.string()).optional(),
  model: z.string().optional(),
  maxTurns: z.number().int().optional(),
});
export type SubagentProfileSummary = z.infer<typeof subagentProfileSummarySchema>;

export const subagentProfilesListParamsSchema = z.strictObject({});
export type SubagentProfilesListParams = z.infer<typeof subagentProfilesListParamsSchema>;

export const subagentProfilesListResultSchema = z.object({
  profiles: z.array(subagentProfileSummarySchema),
});
export type SubagentProfilesListResult = z.infer<typeof subagentProfilesListResultSchema>;

// ---------------------------------------------------------------------------
// 事件（06 §3.2 C 组；progress 500ms 窗口合并策略见 06 §3.4 / 02 §4.4）
// ---------------------------------------------------------------------------

/** subagent.spawned：spawn 受理（含排队）。 */
export const subagentSpawnedEventPayloadSchema = eventBaseSchema.extend({
  subagentId: z.string(),
  profileName: z.string(),
  taskPreview: z.string(),
  status: z.enum(["Pending", "Running"]),
  queuePosition: z.number().int().min(1).optional(),
});
export type SubagentSpawnedEventPayload = z.infer<typeof subagentSpawnedEventPayloadSchema>;

/** subagent.progress：02 §4.2 镜像映射表的 progress 投影；终态事件不合并（06 §3.4）。 */
export const subagentProgressEventPayloadSchema = eventBaseSchema.extend({
  subagentId: z.string(),
  stage: z.enum(["started", "tool", "done", "failed"]),
  toolName: z.string().optional(),
  summary: z.string().optional(),
});
export type SubagentProgressEventPayload = z.infer<typeof subagentProgressEventPayloadSchema>;

/** subagent.completed：子 turn 终态（S2–S6）；完成通知随后注入主循环（02 §4.1）。 */
export const subagentCompletedEventPayloadSchema = eventBaseSchema.extend({
  subagentId: z.string(),
  status: z.enum(["Completed", "Failed", "Stopped"]),
  summary: z.string(),
  usage: tokenUsageSchema,
  turnsUsed: z.number().int(),
});
export type SubagentCompletedEventPayload = z.infer<typeof subagentCompletedEventPayloadSchema>;

/** 事件构造函数：出口即合法（06 §5）；seq 由分配方给定，ts 缺省取当前时刻。 */
export function buildSubagentSpawnedEvent(
  input: Omit<SubagentSpawnedEventPayload, "ts"> & { ts?: number },
): SubagentSpawnedEventPayload {
  return subagentSpawnedEventPayloadSchema.parse({ ...input, ts: input.ts ?? Date.now() });
}

export function buildSubagentProgressEvent(
  input: Omit<SubagentProgressEventPayload, "ts"> & { ts?: number },
): SubagentProgressEventPayload {
  return subagentProgressEventPayloadSchema.parse({ ...input, ts: input.ts ?? Date.now() });
}

export function buildSubagentCompletedEvent(
  input: Omit<SubagentCompletedEventPayload, "ts"> & { ts?: number },
): SubagentCompletedEventPayload {
  return subagentCompletedEventPayloadSchema.parse({ ...input, ts: input.ts ?? Date.now() });
}
