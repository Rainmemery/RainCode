import { z } from "zod";
import { sideEffectScopeSchema, riskLevelSchema } from "./common.js";

/**
 * tool 域（06-api-spec §2.7 / §4.3 段 7；02-module-design §2 / §5）。
 * 只放 schema、纯类型与常量，禁止业务行为（04 §2.4 铁律 2）。
 */

// ---------------------------------------------------------------------------
// 核心结构（06 §2.7：ToolMetadata / ToolResult / ToolDescriptorInfo）
// ---------------------------------------------------------------------------

/** 声明式副作用元数据（02 §2.3 ToolMetadata；权限判定链第一级载体）。 */
export const toolMetadataSchema = z.object({
  readOnly: z.boolean(),
  destructive: z.boolean(),
  sideEffectScope: sideEffectScopeSchema,
  riskLevel: riskLevelSchema,
  /** 元数据层是否建议 ask（非最终判定，02 §2.3）。 */
  needsApproval: z.boolean(),
  timeoutMs: z.number().int().positive().optional(),
  maxOutputBytes: z.number().int().positive().optional(),
});
export type ToolMetadata = z.infer<typeof toolMetadataSchema>;

/** 工具结果统一格式（02 §2.3 ToolResult；turn 内失败是数据不是协议错误，06 §4.3 注）。 */
export const toolResultSchema = z.object({
  toolCallId: z.string(),
  toolName: z.string(),
  content: z.string(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      detail: z.string().optional(),
    })
    .optional(),
  isError: z.boolean(),
  truncated: z.boolean(),
  durationMs: z.number(),
});
export type ToolResult = z.infer<typeof toolResultSchema>;

/** 工具描述符（06 §2.7 tool.tools.list 返回项；parametersSchema 为 zod→JSON Schema 投影）。 */
export const toolDescriptorInfoSchema = z.object({
  name: z.string(),
  description: z.string(),
  source: z.enum(["builtin", "mcp", "plugin"]),
  metadata: toolMetadataSchema,
  parametersSchema: z.unknown(),
});
export type ToolDescriptorInfo = z.infer<typeof toolDescriptorInfoSchema>;

// ---------------------------------------------------------------------------
// 数据级错误码（ToolResult.error.code 取值；命名对齐 06 §4.3 段 7 TOOL_* 段）
// ---------------------------------------------------------------------------

export const TOOL_ERROR_CODES = {
  /** 入参不满足 zod schema（02 §2.4：不进权限与执行）。 */
  INVALID_INPUT: "TOOL_INVALID_INPUT",
  /** 工具名不存在（06 §4.3 TOOL_UNKNOWN）。 */
  UNKNOWN: "TOOL_UNKNOWN",
  /** MCP 工具所在 server 不可用（06 §4.3 TOOL_UNAVAILABLE；mcp 包波次使用）。 */
  UNAVAILABLE: "TOOL_UNAVAILABLE",
  /** 执行超时（沙箱按 timeoutMs 终止进程树，02 §2.4）。 */
  TIMEOUT: "TOOL_TIMEOUT",
  /** 中途取消（turn.cancelled 广播到工具执行器，02 §1.4 T12）。 */
  CANCELLED: "TOOL_CANCELLED",
  /** 越界路径（workspace 逃逸；权限放行钩子见 packages/tools path-guard）。 */
  PATH_ESCAPED: "TOOL_PATH_ESCAPED",
  /** edit 的 oldString 多处匹配（02 §2.4 ambiguous_match）。 */
  AMBIGUOUS_MATCH: "TOOL_AMBIGUOUS_MATCH",
  /** edit 的 oldString 无匹配。 */
  NO_MATCH: "TOOL_NO_MATCH",
  /** 权限判定 deny（审批拒绝/兜底 deny）。 */
  PERMISSION_DENIED: "TOOL_PERMISSION_DENIED",
  /** web_fetch 目标命中私网/环回/保留段等 SSRF 黑名单（02 §2.4：直接拒绝并注明原因）。 */
  SSRF_BLOCKED: "TOOL_SSRF_BLOCKED",
  /** IO / 进程等执行层失败（含目标文件不存在）。 */
  EXEC_FAILED: "TOOL_EXEC_FAILED",
  /** 未分类工具内部错误。 */
  INTERNAL: "TOOL_INTERNAL",
  /** 单 turn 内工具参数校验失败次数超限（受限重试上限 3，AC-12；turn-loop 强制收束，06 §4.3 段 7）。 */
  INPUT_RETRY_EXCEEDED: "TOOL_INPUT_RETRY_EXCEEDED",
} as const;
export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[keyof typeof TOOL_ERROR_CODES];

// ---------------------------------------------------------------------------
// 控制面方法（06 §2.7：tool.tools.list + 后台任务三方法）
// ---------------------------------------------------------------------------

export const toolToolsListParamsSchema = z.strictObject({
  source: z.enum(["builtin", "mcp", "plugin"]).optional(),
});
export type ToolToolsListParams = z.infer<typeof toolToolsListParamsSchema>;

export const toolToolsListResultSchema = z.object({
  tools: z.array(toolDescriptorInfoSchema),
});
export type ToolToolsListResult = z.infer<typeof toolToolsListResultSchema>;

/** 后台任务信息（06 §2.7 tool.background.list 返回项；02 §5.3 BackgroundTaskInfo 投影）。 */
export const backgroundTaskInfoSchema = z.object({
  taskId: z.string(),
  command: z.string(),
  status: z.enum(["Running", "Completed", "Failed", "Timeout", "Killed"]),
  startedAt: z.number(),
  exitCode: z.number().nullable().optional(),
});
export type BackgroundTaskInfo = z.infer<typeof backgroundTaskInfoSchema>;

export const toolBackgroundListParamsSchema = z.strictObject({
  sessionId: z.string().optional(),
});
export type ToolBackgroundListParams = z.infer<typeof toolBackgroundListParamsSchema>;

export const toolBackgroundListResultSchema = z.object({
  tasks: z.array(backgroundTaskInfoSchema),
});
export type ToolBackgroundListResult = z.infer<typeof toolBackgroundListResultSchema>;

export const toolBackgroundKillParamsSchema = z.strictObject({
  taskId: z.string(),
});
export type ToolBackgroundKillParams = z.infer<typeof toolBackgroundKillParamsSchema>;

export const toolBackgroundKillResultSchema = z.object({
  ok: z.boolean(),
  reason: z.enum(["not_found", "not_running", "ownership_rejected", "terminated"]).optional(),
});
export type ToolBackgroundKillResult = z.infer<typeof toolBackgroundKillResultSchema>;

export const toolBackgroundOutputParamsSchema = z.strictObject({
  taskId: z.string(),
  tail: z.number().int().positive().optional(),
});
export type ToolBackgroundOutputParams = z.infer<typeof toolBackgroundOutputParamsSchema>;

export const toolBackgroundOutputResultSchema = z.object({
  output: z.string(),
  truncated: z.boolean(),
});
export type ToolBackgroundOutputResult = z.infer<typeof toolBackgroundOutputResultSchema>;
