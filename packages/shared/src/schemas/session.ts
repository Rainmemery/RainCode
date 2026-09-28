import { z } from "zod";
import {
  attachmentSchema,
  collaborationModeSchema,
  eventBaseSchema,
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

/** 消息内容块（05-database §JSONL：tool_call 块内嵌于 assistant 消息）。 */
export const contentBlockSchema = z.union([
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("tool_call"),
    toolCallId: z.string(),
    name: z.string(),
    arguments: z.unknown(),
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
