import { z } from "zod";

/**
 * 协议公共契约（06-api-spec §5 common.ts）。
 * 只放 schema、纯类型、常量与跨域复用结构，禁止业务行为（04 §2.4 铁律 2，防「shared 巨石化」）。
 */

/** 协议版本（06 §1.4：semver 的 major.minor，经 system.ping 握手协商）。 */
export const PROTOCOL_VERSION = "1.0";

/** 系统错误码（06 §4.2 段 0：传输与协议层，任意方法均可能返回）。 */
export const SYSTEM_ERROR_CODES = {
  PARSE_ERROR: "PARSE_ERROR",
  INVALID_PARAMS: "INVALID_PARAMS",
  METHOD_NOT_FOUND: "METHOD_NOT_FOUND",
  TIMEOUT: "TIMEOUT",
  TRANSPORT_CLOSED: "TRANSPORT_CLOSED",
  VERSION_MISMATCH: "VERSION_MISMATCH",
  CANCELLED: "CANCELLED",
  INTERNAL: "INTERNAL",
  // T3.8（v1.9）：连接级鉴权门未通过（06 §6.3 websocket 绑定：ws.auth 成功前一切请求拒绝）
  UNAUTHORIZED: "UNAUTHORIZED",
} as const;
export type SystemErrorCode = (typeof SYSTEM_ERROR_CODES)[keyof typeof SYSTEM_ERROR_CODES];

// ---------------------------------------------------------------------------
// ID 类型（06 §2.0：不透明字符串，约定形如 <prefix>_<ulid>，协议层不作格式强校验）
// ---------------------------------------------------------------------------

export type SessionId = string;
export type TurnId = string;
export type ToolCallId = string;
export type GrantId = string;
export type SubagentId = string;
export type CompactionId = string;
export type RuleId = string;
export type EntryId = string;
export type TaskId = string;

/** 不透明 ID schema（协议层不作格式强校验，仅约束为字符串）。 */
export const opaqueIdSchema = z.string();

// ---------------------------------------------------------------------------
// RpcError 与 RpcFrame（04 §4.1 逐字段一致；error 含可选 details，06 §1.2）
// ---------------------------------------------------------------------------

/** RPC 错误对象（06 §1.2/§4.1：details 为可选扩展字段，旧解析器忽略未知字段即可）。 */
export const rpcErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
});
export type RpcError = z.infer<typeof rpcErrorSchema>;

/**
 * 帧结构（06 §1.2）：JSON-RPC 2.0 语义（id / method / params / result / error）。
 * 宽松模式（strip）：帧中的未知字段被忽略（06 §1.4 帧兼容规则）。
 */
export const rpcFrameSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("request"),
    id: z.string(),
    method: z.string(),
    params: z.unknown(),
  }),
  z.object({
    kind: z.literal("response"),
    id: z.string(),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: rpcErrorSchema.optional(),
  }),
  z.object({
    kind: z.literal("event"),
    name: z.string(),
    payload: z.unknown(),
  }),
]);
export type RpcFrame = z.infer<typeof rpcFrameSchema>;
export type RequestFrame = Extract<RpcFrame, { kind: "request" }>;
export type ResponseFrame = Extract<RpcFrame, { kind: "response" }>;
export type EventFrame = Extract<RpcFrame, { kind: "event" }>;

// ---------------------------------------------------------------------------
// EventBase（06 §3.1：所有事件 payload 的公共信封）
// ---------------------------------------------------------------------------

export const eventBaseSchema = z.object({
  seq: z.number().int().positive(), // 会话内单调递增，从 1 开始
  sessionId: z.string().optional(), // 全局事件（如 mcp.server_status_changed）缺省
  ts: z.number(), // 服务端产生时刻（epoch ms）
});
export type EventBase = z.infer<typeof eventBaseSchema>;

// ---------------------------------------------------------------------------
// 分页（06 §2.0：limit 默认 50、上限 200；默认值由服务端执行时取）
// ---------------------------------------------------------------------------

export const pageParamsSchema = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().positive().max(200).optional(),
});
export type PageParams = z.infer<typeof pageParamsSchema>;

export function pageResultSchema<T>(itemSchema: z.ZodType<T>) {
  return z.object({ items: z.array(itemSchema), nextCursor: z.string().optional() });
}

// ---------------------------------------------------------------------------
// 跨域复用标量与结构（06 §5「域间复用结构提升到 common.ts」）
// ---------------------------------------------------------------------------

/** TurnPhase 状态机的 8 个阶段（02 §1.2.1，T1–T15 迁移表）。 */
export const turnPhaseSchema = z.enum([
  "Idle",
  "ProcessingInput",
  "ModelRequest",
  "Streaming",
  "ToolSchedule",
  "ToolExecution",
  "AggregatingResults",
  "TurnComplete",
]);
export type TurnPhase = z.infer<typeof turnPhaseSchema>;

/** Token 使用量（06 §3.2 惯例）。 */
export const tokenUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cachedTokens: z.number().optional(),
});
export type TokenUsage = z.infer<typeof tokenUsageSchema>;

/** 协作模式（06 §2.1 session.create / session.setMode）。 */
export const collaborationModeSchema = z.enum(["normal", "plan", "auto-accept"]);
export type CollaborationMode = z.infer<typeof collaborationModeSchema>;

/** 工具副作用范围声明（02 §2.2）。 */
export const sideEffectScopeSchema = z.enum(["none", "workspace", "machine", "network"]);
export type SideEffectScope = z.infer<typeof sideEffectScopeSchema>;

/** 工具风险级别（02 §2.2）。 */
export const riskLevelSchema = z.enum(["low", "medium", "high"]);
export type RiskLevel = z.infer<typeof riskLevelSchema>;

/** 会话附件（06 §2.1 session.send.attachments；path 越界 workspaceRoot 由服务端入口拒绝）。 */
export const attachmentSchema = z.object({
  path: z.string(),
  mediaType: z.string().optional(),
});
export type Attachment = z.infer<typeof attachmentSchema>;

/**
 * 工具权限元数据摘要（tool_call.started 事件与 permission.requested 共用的 4 字段投影）。
 * 跨域复用结构：完整 ToolMetadata 属 tool 域（schemas/tool.ts），此处只放事件/审批共用摘要
 * （06 §5：复用结构属主域定义、引用方经 common.ts 提升共用）。
 */
export const toolMetadataSummarySchema = z.object({
  readOnly: z.boolean(),
  destructive: z.boolean(),
  sideEffectScope: sideEffectScopeSchema,
  riskLevel: riskLevelSchema,
});
export type ToolMetadataSummary = z.infer<typeof toolMetadataSummarySchema>;

/**
 * 规则行为（02 §6.3 behavior；05 §3.6 CHECK 同枚举）。
 * 跨域复用标量：permission.ts 规则 schema 与审批闭环共用。
 */
export const ruleBehaviorSchema = z.enum(["allow", "deny", "ask"]);
export type RuleBehavior = z.infer<typeof ruleBehaviorSchema>;

/** 判定命中来源（02 §6.3 matchedBy；五级判定链层级投影）。 */
export const matchedBySchema = z.enum([
  "metadata",
  "mode",
  "session-rule",
  "project-rule",
  "global-rule",
  "default",
]);
export type MatchedBy = z.infer<typeof matchedBySchema>;

/**
 * 审批单 payload 主体（06 §3.2 permission.requested）。
 * 跨域复用结构：SessionSnapshotPayload.pendingApprovals 引用之（06 §3.2 A 组），
 * 按 06 §5 提升到 common.ts；permission 域落地后由 permission.ts re-export。
 * ruleCandidates 为任务交付新增可选字段（参与匹配的候选规则；06 §3.2 未定义，出参宽松兼容）。
 */
export const permissionRequestedPayloadSchema = z.object({
  grantId: z.string(),
  turnId: z.string().optional(),
  toolCallId: z.string().optional(),
  toolName: z.string(),
  normalizedInput: z.unknown(),
  metadata: toolMetadataSummarySchema,
  mode: collaborationModeSchema,
  matchedBy: matchedBySchema,
  reason: z.string(),
  expiresAt: z.number(), // epoch ms；离线审批在客户端重新可见后才参与超时判定（06 §3.3）
  ruleCandidates: z.array(z.unknown()).optional(),
});
export type PermissionRequestedPayload = z.infer<typeof permissionRequestedPayloadSchema>;
