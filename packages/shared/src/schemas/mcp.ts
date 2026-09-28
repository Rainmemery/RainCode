import { z } from "zod";
import { eventBaseSchema } from "./common.js";

/**
 * MCP 域（06-api-spec §2.5 / §3.5）：server 配置 + 连接生命周期 + 命名空间工具。
 * 连接建立异步——add/retry 只返回受理状态，最终状态以 `mcp.server_status_changed` 事件为准；
 * 状态机与迁移表见 02-module-design §3.2（M1~M8）。
 */

export const mcpTransportSchema = z.enum(["stdio", "http", "sse"]);
export type McpTransport = z.infer<typeof mcpTransportSchema>;

/** 连接状态（02 §3.2 状态机五态投影）。 */
export const mcpServerStatusSchema = z.enum(["Disconnected", "Connecting", "Connected", "Reconnecting", "Failed"]);
export type McpServerStatus = z.infer<typeof mcpServerStatusSchema>;

// ---------------------------------------------------------------------------
// McpServerConfig（02 §3.3；mcp.json 持久化形态与方法面入参共用）
// ---------------------------------------------------------------------------

export const mcpServerConfigSchema = z
  .object({
    /** 命名空间键 [a-z0-9_-]+（mcp__<serverKey>__<toolName>；与内置工具重名加载期拒绝）。 */
    serverKey: z.string().regex(/^[a-z0-9_-]+$/, "serverKey must match [a-z0-9_-]+"),
    transport: mcpTransportSchema,
    /** stdio 必填：启动命令。 */
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    /** stdio 环境变量注入（server 侧经脱敏过滤，02 §3.4）。 */
    env: z.record(z.string()).optional(),
    cwd: z.string().optional(),
    /** http/sse 必填。 */
    url: z.string().url().optional(),
    headers: z.record(z.string()).optional(),
    /** callTool 单调用超时，默认 60000（02 §3.2：超时不杀连接仅本调用报错）。 */
    timeoutMs: z.number().int().positive().default(60000),
    enabled: z.boolean().default(true),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (config.transport === "stdio" && (config.command === undefined || config.command.length === 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["command"], message: "stdio transport requires command" });
    }
    if ((config.transport === "http" || config.transport === "sse") && config.url === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["url"], message: `${config.transport} transport requires url` });
    }
  });
export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;

/** mcp.json 持久化形态（与 Claude/Cursor 生态 mcpServers 约定兼容）。 */
export const mcpConfigFileSchema = z.object({
  mcpServers: z.record(mcpServerConfigSchema),
});
export type McpConfigFile = z.infer<typeof mcpConfigFileSchema>;

// ---------------------------------------------------------------------------
// 状态投影（mcp.servers.list 项 / mcp.server_status_changed 事件）
// ---------------------------------------------------------------------------

export const mcpServerStatusEntrySchema = z.object({
  serverKey: z.string(),
  transport: mcpTransportSchema,
  status: mcpServerStatusSchema,
  enabled: z.boolean(),
  toolCount: z.number().int().nonnegative().optional(),
  lastError: z.string().optional(),
});
export type McpServerStatusEntry = z.infer<typeof mcpServerStatusEntrySchema>;

export const mcpServerStatusChangedEventPayloadSchema = eventBaseSchema.extend({
  /** 全局事件：sessionId 缺省（06 §3.5）。 */
  serverKey: z.string(),
  status: mcpServerStatusSchema,
  toolCount: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
});
export type McpServerStatusChangedEventPayload = z.infer<typeof mcpServerStatusChangedEventPayloadSchema>;

/** 事件构造函数：出口即合法（06 §5）；seq 由分配方给定，ts 缺省取当前时刻。 */
export function buildMcpServerStatusChangedEvent(
  input: Omit<McpServerStatusChangedEventPayload, "ts"> & { ts?: number },
): McpServerStatusChangedEventPayload {
  return mcpServerStatusChangedEventPayloadSchema.parse({ ...input, ts: input.ts ?? Date.now() });
}

// ---------------------------------------------------------------------------
// 命名空间工具（mcp.servers 暴露面；02 §3.3 命名规则 mcp__<serverKey>__<toolName>）
// ---------------------------------------------------------------------------

export const mcpToolDescriptorSchema = z.object({
  name: z.string(),
  serverKey: z.string(),
  description: z.string().optional(),
  /** MCP 原始 inputSchema（JSON Schema 直通）。 */
  inputSchema: z.unknown(),
  /** false = 失败隔离标记（M6：server Failed 时其工具标记不可用）。 */
  available: z.boolean(),
});
export type McpToolDescriptor = z.infer<typeof mcpToolDescriptorSchema>;

// ---------------------------------------------------------------------------
// 控制面方法（06 §2.5 MCP 域 6 方法）
// ---------------------------------------------------------------------------

export const mcpServersListParamsSchema = z.strictObject({});
export type McpServersListParams = z.infer<typeof mcpServersListParamsSchema>;

export const mcpServersListResultSchema = z.object({
  servers: z.array(mcpServerStatusEntrySchema),
});
export type McpServersListResult = z.infer<typeof mcpServersListResultSchema>;

export const mcpServersAddParamsSchema = z.strictObject({
  config: mcpServerConfigSchema,
  level: z.enum(["project", "global"]).default("global"),
});
export type McpServersAddParams = z.infer<typeof mcpServersAddParamsSchema>;

export const mcpServersAddResultSchema = z.object({
  serverKey: z.string(),
  status: mcpServerStatusSchema,
});
export type McpServersAddResult = z.infer<typeof mcpServersAddResultSchema>;

export const mcpServersRemoveParamsSchema = z.strictObject({
  serverKey: z.string(),
});
export type McpServersRemoveParams = z.infer<typeof mcpServersRemoveParamsSchema>;

export const mcpServersRemoveResultSchema = z.object({
  removed: z.boolean(),
});
export type McpServersRemoveResult = z.infer<typeof mcpServersRemoveResultSchema>;

export const mcpServersRetryParamsSchema = z.strictObject({
  serverKey: z.string(),
});
export type McpServersRetryParams = z.infer<typeof mcpServersRetryParamsSchema>;

export const mcpServersRetryResultSchema = z.object({
  status: mcpServerStatusSchema,
});
export type McpServersRetryResult = z.infer<typeof mcpServersRetryResultSchema>;

export const mcpToolsListParamsSchema = z.strictObject({
  serverKey: z.string().optional(),
});
export type McpToolsListParams = z.infer<typeof mcpToolsListParamsSchema>;

export const mcpToolsListResultSchema = z.object({
  tools: z.array(mcpToolDescriptorSchema),
});
export type McpToolsListResult = z.infer<typeof mcpToolsListResultSchema>;

export const mcpToolsCallParamsSchema = z.strictObject({
  serverKey: z.string(),
  toolName: z.string().min(1),
  args: z.unknown(),
  timeoutMs: z.number().int().positive().optional(),
});
export type McpToolsCallParams = z.infer<typeof mcpToolsCallParamsSchema>;

export const mcpToolsCallResultSchema = z.object({
  /** 模型可见文本（MCP content blocks 的文本投影；非文本块以 JSON 序列化附后）。 */
  content: z.string(),
  isError: z.boolean(),
  /** MCP 原始 content blocks（UI 渲染用）。 */
  raw: z.unknown(),
});
export type McpToolsCallResult = z.infer<typeof mcpToolsCallResultSchema>;
