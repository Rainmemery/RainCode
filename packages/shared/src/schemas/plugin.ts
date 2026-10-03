import { z } from "zod";
import { eventBaseSchema } from "./common.js";

/**
 * plugins 域（06-api-spec §2.10 / v1.8，M3 T3.5 插件化）：
 * 插件 = `<dataRoot>/plugins/<name>/`（plugin.json 清单 + 入口 ES module）的工具扩展包，
 * 注册进 ToolRegistry 时 source="plugin"（工具全名 `plugin__<pluginName>__<toolName>`）。
 * 只放 schema、纯类型、常量与事件构造函数，禁止业务行为（04 §2.4 铁律 2）。
 */

// ---------------------------------------------------------------------------
// 错误码常量（06 §4.3 段 10）
// ---------------------------------------------------------------------------

export const PLUGIN_ERROR_CODES = {
  /** 插件不存在（plugins.setEnabled 未知 name；06 §4.3 PLUGIN_NOT_FOUND）。 */
  NOT_FOUND: "PLUGIN_NOT_FOUND",
  /** 插件清单/模块/工具描述符非法（加载期即拦截为 failed 状态，方法面不直接抛）。 */
  INVALID: "PLUGIN_INVALID",
} as const;
export type PluginErrorCode = (typeof PLUGIN_ERROR_CODES)[keyof typeof PLUGIN_ERROR_CODES];

// ---------------------------------------------------------------------------
// 插件状态与摘要（06 §2.10）
// ---------------------------------------------------------------------------

/** 插件运行态：active = 已激活工具已注册；disabled = 停用名单内（未加载）；failed = 启用但加载失败。 */
export const pluginStatusSchema = z.enum(["active", "disabled", "failed"]);
export type PluginStatus = z.infer<typeof pluginStatusSchema>;

/** 插件摘要（plugins.list 投影；dir 为绝对路径，发布 = 将插件目录拷入 `<dataRoot>/plugins/`）。 */
export const pluginSummarySchema = z.object({
  name: z.string(),
  description: z.string(),
  version: z.string().optional(),
  dir: z.string(),
  enabled: z.boolean(),
  status: pluginStatusSchema,
  /** 已注册工具全名（`plugin__<pluginName>__<toolName>`，与 tool.tools.list source=plugin 一致）。 */
  tools: z.array(z.string()),
  lastError: z.string().nullable(),
});
export type PluginSummary = z.infer<typeof pluginSummarySchema>;

// ---------------------------------------------------------------------------
// plugins.list / plugins.setEnabled（06 §2.10；v1.8 minor+1 additive）
// ---------------------------------------------------------------------------

export const pluginsListParamsSchema = z.strictObject({});
export type PluginsListParams = z.infer<typeof pluginsListParamsSchema>;

export const pluginsListResultSchema = z.object({
  plugins: z.array(pluginSummarySchema),
});
export type PluginsListResult = z.infer<typeof pluginsListResultSchema>;

export const pluginsSetEnabledParamsSchema = z.strictObject({
  name: z.string().min(1),
  enabled: z.boolean(),
});
export type PluginsSetEnabledParams = z.infer<typeof pluginsSetEnabledParamsSchema>;

export const pluginsSetEnabledResultSchema = z.object({
  name: z.string(),
  enabled: z.boolean(),
  /** 受理时点状态快照（active/disabled/failed）；加载失败经 plugin.status_changed 事件与 plugins.list 可查。 */
  status: pluginStatusSchema,
});
export type PluginsSetEnabledResult = z.infer<typeof pluginsSetEnabledResultSchema>;

// plugins.rescan（06 §2.10；v1.11 additive，B10 可视化测试缺陷修复）：
// 运行时重扫描 plugins 目录装载新拷入插件——此前「发布 = 目录拷入」后只能重启应用（面板「刷新」
// 仅重拉 list，语义不符）。仅新增目录：已有记录（含 failed）不重载不触碰，启用中的新插件激活。
export const pluginsRescanParamsSchema = z.strictObject({});
export type PluginsRescanParams = z.infer<typeof pluginsRescanParamsSchema>;

export const pluginsRescanResultSchema = z.object({
  /** 本次新装载的插件名（新目录按启用状态激活；已存在目录名不重复装载）。 */
  added: z.array(z.string()),
});
export type PluginsRescanResult = z.infer<typeof pluginsRescanResultSchema>;

// ---------------------------------------------------------------------------
// 事件 plugin.status_changed（06 §3.2 v1.8；全局事件，sessionId 缺省）
// ---------------------------------------------------------------------------

export const pluginStatusChangedEventPayloadSchema = eventBaseSchema.extend({
  name: z.string(),
  status: pluginStatusSchema,
  toolCount: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
});
export type PluginStatusChangedEventPayload = z.infer<typeof pluginStatusChangedEventPayloadSchema>;

/** 事件构造函数：出口即合法（06 §5）；seq 由分配方给定，ts 缺省取当前时刻。 */
export function buildPluginStatusChangedEvent(
  input: Omit<PluginStatusChangedEventPayload, "ts"> & { ts?: number },
): PluginStatusChangedEventPayload {
  return pluginStatusChangedEventPayloadSchema.parse({ ...input, ts: input.ts ?? Date.now() });
}
