import { z } from "zod";
import {
  attachmentSchema,
  collaborationModeSchema,
  eventBaseSchema,
  opaqueIdSchema,
  pageParamsSchema,
  permissionRequestedPayloadSchema,
  turnPhaseSchema,
} from "./common.js";

/**
 * session 域（06-api-spec §2.1）：会话与 Turn。
 * 本波 walking skeleton 覆盖 create / send / cancel / list / resume；
 * steer / compact / archive 随后续波次补充。
 */

// ---------------------------------------------------------------------------
// 共享结构
// ---------------------------------------------------------------------------

export const sessionStateSchema = z.enum(["Active", "Archived"]);
export type SessionState = z.infer<typeof sessionStateSchema>;

export const contextUsageSchema = z.object({
  tokens: z.number(),
  maxTokens: z.number(),
});
export type ContextUsage = z.infer<typeof contextUsageSchema>;

/** 会话摘要（06 §2.1 session.list 返回项）。 */
export const sessionSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  state: sessionStateSchema,
  createdAt: z.number(),
  lastActiveAt: z.number(),
  model: z.string(),
  contextUsage: contextUsageSchema,
});
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

/**
 * 消息内容块（05-database §JSONL：tool_call 块内嵌于 assistant 消息）。
 * - tool_call：assistant 发起的工具调用（id/name/arguments；arguments 保持模型原参结构，
 *   线上 JSON 序列化在 context 组装时进行——与 verify-wave2 既有 fixture 深比较兼容）；
 * - tool_result：工具结果块（05 §4.2 数据形态；turn 内聚合优先以独立 role:"tool" 消息行落库）。
 */
export const contentBlockSchema = z.union([
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("tool_call"),
    toolCallId: z.string(),
    name: z.string(),
    arguments: z.unknown(),
  }),
  z.object({
    type: z.literal("tool_result"),
    toolUseId: z.string(),
    content: z.string(),
    isError: z.boolean(),
  }),
]);
export type ContentBlock = z.infer<typeof contentBlockSchema>;

/** 消息记录（JSONL 会话事件流的消息体形态，05-database；session.snapshot.messages 投影使用）。 */
export const messageRecordSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "tool"]),
  content: z.union([z.string(), z.array(contentBlockSchema)]),
  attachments: z.array(attachmentSchema).optional(),
  toolCallId: z.string().optional(),
  isError: z.boolean().optional(),
});
export type MessageRecord = z.infer<typeof messageRecordSchema>;

/** 任务清单项（02 §2.3 todo_write 覆盖式更新；设计文档未细化字段，暂取最小形态，tools 波次对齐）。 */
export const todoItemSchema = z.object({
  content: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
  activeForm: z.string().optional(),
});
export type TodoItem = z.infer<typeof todoItemSchema>;

/**
 * 会话快照主体（06 §3.2 SessionSnapshotPayload）。
 * messages 只含末尾 checkpoint 之后的增量（NFR-5 ≤1s 的协议投影）；
 * pendingApprovals 复用 permission.requested 的 payload 主体，实现重连补推未决审批（02 §6.4）。
 */
export const sessionSnapshotPayloadSchema = z.object({
  lastSeq: z.number().int(),
  phase: turnPhaseSchema,
  turnId: z.string().optional(),
  model: z.string(),
  activeProviderId: z.string(),
  contextUsage: contextUsageSchema,
  messages: z.array(messageRecordSchema),
  todoState: z.array(todoItemSchema).optional(),
  pendingApprovals: z.array(permissionRequestedPayloadSchema),
});
export type SessionSnapshotPayload = z.infer<typeof sessionSnapshotPayloadSchema>;

// ---------------------------------------------------------------------------
// session.create
// ---------------------------------------------------------------------------

export const sessionCreateParamsSchema = z.strictObject({
  workspaceRoot: z.string().min(1),
  title: z.string().optional(),
  providerId: z.string().optional(),
  mode: collaborationModeSchema.optional(),
});
export type SessionCreateParams = z.infer<typeof sessionCreateParamsSchema>;

export const sessionCreateResultSchema = z.object({
  sessionId: z.string(),
  state: sessionStateSchema,
  createdAt: z.number(),
});
export type SessionCreateResult = z.infer<typeof sessionCreateResultSchema>;

// ---------------------------------------------------------------------------
// session.send（受理即返，06 §1.1 关键约定：流式输出不是长驻请求）
// ---------------------------------------------------------------------------

export const sessionSendParamsSchema = z.strictObject({
  sessionId: z.string(),
  input: z.object({
    text: z.string().min(1),
    attachments: z.array(attachmentSchema).optional(),
  }),
});
export type SessionSendParams = z.infer<typeof sessionSendParamsSchema>;

export const sessionSendResultSchema = z.object({
  turnId: z.string(),
  admission: z.enum(["started", "queued"]),
  queuePosition: z.number().int().optional(),
});
export type SessionSendResult = z.infer<typeof sessionSendResultSchema>;

// ---------------------------------------------------------------------------
// session.cancel（幂等：无运行中 turn 时返回 cancelled: false）
// ---------------------------------------------------------------------------

export const sessionCancelParamsSchema = z.strictObject({
  sessionId: z.string(),
  turnId: z.string().optional(),
  reason: z.string().optional(),
});
export type SessionCancelParams = z.infer<typeof sessionCancelParamsSchema>;

export const sessionCancelResultSchema = z.object({
  cancelled: z.boolean(),
  at: turnPhaseSchema.optional(),
});
export type SessionCancelResult = z.infer<typeof sessionCancelResultSchema>;

// ---------------------------------------------------------------------------
// session.list
// ---------------------------------------------------------------------------

export const sessionListParamsSchema = z.strictObject({
  filter: z
    .object({
      state: sessionStateSchema.optional(),
      workspaceRoot: z.string().optional(),
      keyword: z.string().optional(),
    })
    .optional(),
  page: pageParamsSchema.optional(),
});
export type SessionListParams = z.infer<typeof sessionListParamsSchema>;

export const sessionListResultSchema = z.object({
  items: z.array(sessionSummarySchema),
  nextCursor: z.string().optional(),
});
export type SessionListResult = z.infer<typeof sessionListResultSchema>;

// ---------------------------------------------------------------------------
// session.resume（幂等：会话已 Active 时直接返回当前快照）
// ---------------------------------------------------------------------------

export const sessionResumeParamsSchema = z.strictObject({
  sessionId: z.string(),
});
export type SessionResumeParams = z.infer<typeof sessionResumeParamsSchema>;

export const sessionResumeResultSchema = z.object({
  sessionId: z.string(),
  snapshot: sessionSnapshotPayloadSchema,
});
export type SessionResumeResult = z.infer<typeof sessionResumeResultSchema>;

// ---------------------------------------------------------------------------
// session.steer（06 §2.1：运行中注入 steeringBuffer 不开新 turn；空闲按 turn.new 处理）
// ---------------------------------------------------------------------------

export const sessionSteerParamsSchema = z.strictObject({
  sessionId: z.string(),
  input: z.object({ text: z.string().min(1) }),
});
export type SessionSteerParams = z.infer<typeof sessionSteerParamsSchema>;

export const sessionSteerResultSchema = z.object({
  result: z.enum(["injected", "started", "queued"]),
  turnId: z.string().optional(),
});
export type SessionSteerResult = z.infer<typeof sessionSteerResultSchema>;

// ---------------------------------------------------------------------------
// session.archive（06 §2.1：flush + 标记只读；后台任务阻塞见 SESSION_BACKGROUND_TASKS）
// ---------------------------------------------------------------------------

export const sessionArchiveParamsSchema = z.strictObject({
  sessionId: z.string(),
  force: z.boolean().optional(),
});
export type SessionArchiveParams = z.infer<typeof sessionArchiveParamsSchema>;

export const sessionArchiveResultSchema = z.object({
  archived: z.boolean(),
});
export type SessionArchiveResult = z.infer<typeof sessionArchiveResultSchema>;

// ---------------------------------------------------------------------------
// session.setMode（06 §2.1：切协作模式，影响权限判定链层级 2，对运行中 turn 立即生效）
// ---------------------------------------------------------------------------

export const sessionSetModeParamsSchema = z.strictObject({
  sessionId: z.string(),
  mode: collaborationModeSchema,
});
export type SessionSetModeParams = z.infer<typeof sessionSetModeParamsSchema>;

export const sessionSetModeResultSchema = z.object({
  mode: collaborationModeSchema,
});
export type SessionSetModeResult = z.infer<typeof sessionSetModeResultSchema>;

// ---------------------------------------------------------------------------
// session.compact（06 §2.1：手动压缩，异步执行 NFR-6；in-flight 幂等复用既有 ticket）
// ---------------------------------------------------------------------------

export const sessionCompactParamsSchema = z.strictObject({
  sessionId: z.string(),
});
export type SessionCompactParams = z.infer<typeof sessionCompactParamsSchema>;

export const sessionCompactResultSchema = z.object({
  compactionId: opaqueIdSchema,
  epoch: z.number().int().nonnegative(),
  alreadyRunning: z.boolean(),
});
export type SessionCompactResult = z.infer<typeof sessionCompactResultSchema>;

// ---------------------------------------------------------------------------
// session.rename（06 §2.1：会话重命名，AC-9；title trim 后 1~200 字符——schema 层 trim 先行，
// handler 收到的即已 trim 的值）
// ---------------------------------------------------------------------------

export const sessionRenameParamsSchema = z.strictObject({
  sessionId: z.string(),
  title: z.string().trim().min(1).max(200),
});
export type SessionRenameParams = z.infer<typeof sessionRenameParamsSchema>;

export const sessionRenameResultSchema = z.object({
  sessionId: z.string(),
  title: z.string(),
});
export type SessionRenameResult = z.infer<typeof sessionRenameResultSchema>;

// ---------------------------------------------------------------------------
// session.fork（06 §2.1：从既有会话分叉新会话，AC-9——复制全量历史消息落盘、
// parent_session_id 回链源会话；fork 后新会话独立演进）
// ---------------------------------------------------------------------------

export const sessionForkParamsSchema = z.strictObject({
  sessionId: z.string(),
  title: z.string().trim().min(1).max(200).optional(),
});
export type SessionForkParams = z.infer<typeof sessionForkParamsSchema>;

export const sessionForkResultSchema = z.object({
  sessionId: z.string(),
  parentSessionId: z.string(),
  title: z.string(),
  messageCount: z.number().int().nonnegative(),
});
export type SessionForkResult = z.infer<typeof sessionForkResultSchema>;

// ---------------------------------------------------------------------------
// session.usage（06 §2.1：会话累计用量与费用估算，AC-10）；costEstimateUsd 仅当活跃 Provider
// 配置单价时返回（input×inputPrice/1M + output×outputPrice/1M，非精确计费）——undefined
// 字段在响应中条件展开剔除（出参宽松 strip，旧端忽略即可）
// ---------------------------------------------------------------------------

export const sessionUsageParamsSchema = z.strictObject({
  sessionId: z.string(),
});
export type SessionUsageParams = z.infer<typeof sessionUsageParamsSchema>;

export const sessionUsageResultSchema = z.object({
  sessionId: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  turnsCount: z.number(),
  costEstimateUsd: z.number().optional(),
});
export type SessionUsageResult = z.infer<typeof sessionUsageResultSchema>;

// ---------------------------------------------------------------------------
// compact.started / compact.completed 事件（06 §3.5 C 组：压缩生命周期）
// ---------------------------------------------------------------------------

export const compactStartedEventPayloadSchema = eventBaseSchema.extend({
  sessionId: z.string(),
  compactionId: opaqueIdSchema,
  epoch: z.number().int().nonnegative(),
  trigger: z.enum(["auto", "manual"]),
});
export type CompactStartedEventPayload = z.infer<typeof compactStartedEventPayloadSchema>;

export const compactCompletedEventPayloadSchema = eventBaseSchema.extend({
  sessionId: z.string(),
  compactionId: opaqueIdSchema,
  epoch: z.number().int().nonnegative(),
  ok: z.boolean(),
  tokensBefore: z.number().optional(),
  tokensAfter: z.number().optional(),
  failure: z.object({ reason: z.string() }).optional(),
});
export type CompactCompletedEventPayload = z.infer<typeof compactCompletedEventPayloadSchema>;

/** 事件构造函数：出口即合法（06 §5）；seq 由会话事件流分配，ts 缺省取当前时刻。 */
export function buildCompactStartedEvent(
  input: Omit<CompactStartedEventPayload, "ts"> & { ts?: number },
): CompactStartedEventPayload {
  return compactStartedEventPayloadSchema.parse({ ...input, ts: input.ts ?? Date.now() });
}

/** 事件构造函数：出口即合法（06 §5）；seq 由会话事件流分配，ts 缺省取当前时刻。 */
export function buildCompactCompletedEvent(
  input: Omit<CompactCompletedEventPayload, "ts"> & { ts?: number },
): CompactCompletedEventPayload {
  return compactCompletedEventPayloadSchema.parse({ ...input, ts: input.ts ?? Date.now() });
}

// ---------------------------------------------------------------------------
// session.created 事件（07 §2.1 P0 事件第 12 个：05-database JSONL 头行同名事件的 rpc 投影；
// 06 §3.2 未列属文档缺口，按 §7.4 新事件名追加兼容）
// ---------------------------------------------------------------------------

export const sessionCreatedEventPayloadSchema = eventBaseSchema.extend({
  sessionId: z.string(),
  title: z.string(),
  workspaceRoot: z.string(),
  mode: collaborationModeSchema,
  createdAt: z.number(),
  // T2.6 可选演进（06 §7.1 新增可选事件字段兼容）：会话种类与 fork 回链源会话（06 §3.2 A 组）
  kind: z.enum(["main", "subagent"]).optional(),
  parentSessionId: z.string().optional(),
});
export type SessionCreatedEventPayload = z.infer<typeof sessionCreatedEventPayloadSchema>;

/** 事件构造函数：出口即合法（06 §5）；seq 由服务端分配（create 路径为 1），ts 缺省取当前时刻。 */
export function buildSessionCreatedEvent(
  input: Omit<SessionCreatedEventPayload, "ts"> & { ts?: number },
): SessionCreatedEventPayload {
  return sessionCreatedEventPayloadSchema.parse({ ...input, ts: input.ts ?? Date.now() });
}

// ---------------------------------------------------------------------------
// session.snapshot 事件 payload（06 §3.2 A 组：EventBase + 快照主体）
// ---------------------------------------------------------------------------

export const sessionSnapshotEventPayloadSchema = eventBaseSchema.extend(
  sessionSnapshotPayloadSchema.shape,
);
export type SessionSnapshotEventPayload = z.infer<typeof sessionSnapshotEventPayloadSchema>;

/** 事件构造函数：出口即合法（06 §5）；seq 由会话事件流分配，ts 缺省取当前时刻。 */
export function buildSessionSnapshotEvent(
  input: Omit<SessionSnapshotEventPayload, "ts"> & { ts?: number },
): SessionSnapshotEventPayload {
  return sessionSnapshotEventPayloadSchema.parse({ ...input, ts: input.ts ?? Date.now() });
}
