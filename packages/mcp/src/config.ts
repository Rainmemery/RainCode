/**
 * MCP 配置（02-module-design §3.3 / 06-api-spec §2.5）。
 *
 * - mcp.json 持久化形态：{ mcpServers: { <serverKey>: config } }（与 Claude/Cursor 生态约定兼容）；
 * - 加载期校验：zod strict + serverKey 冲突拒绝（同 key 跨文件冲突报告位置，02 §3.4）；
 * - serverKey 为内置工具名或含保留命名空间字符即拒绝（02 §3.4「与内置工具重名」）；
 * - 命名规则：mcp__<serverKey>__<toolName>，非法字符统一替换 "_"，空段回退 "unknown"。
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { z } from "zod";
import { mcpConfigFileSchema, mcpServerConfigSchema } from "@raincode/shared";
import type { McpServerConfig } from "@raincode/shared";

/** 内置工具名（02 §3.4：用户配置 serverKey 撞内置名时加载期拒绝）。 */
export const BUILTIN_TOOL_NAMES: readonly string[] = [
  "bash",
  "read",
  "write",
  "edit",
  "glob",
  "grep",
  "todo_write",
  "web_fetch",
];

export interface McpConfigSource {
  /** 配置文件绝对路径（project 级 <workspace>/.raincode/mcp.json 或 global RAINCODE_HOME/mcp.json）。 */
  path: string;
  level: "project" | "global";
}

export interface LoadedMcpConfig {
  configs: Map<string, McpServerConfigLevel>;
  /** 有配置文件路径的层（add/remove 持久化写回目标）。 */
  sources: McpConfigSource[];
}

export class McpConfigError extends Error {
  constructor(
    public readonly code: "MCP_CONFIG_INVALID" | "MCP_SERVER_CONFLICT",
    message: string,
  ) {
    super(message);
  }
}

/** manager 使用的配置形态（loadMcpConfig 输出）。 */
export interface McpServerConfigLevel extends McpServerConfig {
  level: "project" | "global";
}

/** 工具模型可见名：mcp__<serverKey>__<toolName>（非法字符统一 "_"，空段回退 "unknown"）。 */
export function toMcpToolName(serverKey: string, toolName: string): string {
  const sanitize = (value: string): string => {
    const cleaned = value.replace(/[^a-zA-Z0-9_-]/g, "_");
    return cleaned.length > 0 ? cleaned : "unknown";
  };
  return `mcp__${sanitize(serverKey)}__${sanitize(toolName)}`;
}

/** serverKey 是否可接受（内置名 / 保留命名空间冲突拒绝）。 */
export function validateServerKey(serverKey: string): void {
  if (BUILTIN_TOOL_NAMES.includes(serverKey)) {
    throw new McpConfigError("MCP_SERVER_CONFLICT", `serverKey "${serverKey}" conflicts with a builtin tool name`);
  }
}

/** 单文件加载：缺文件返回空 map（不视为错误）；zod 校验失败 → MCP_CONFIG_INVALID。
 * 文件形态 serverKey 由 map 键承载（Claude/Cursor 生态约定，README 文档形态）；
 * 条目内显式 serverKey 字段可省（写回形态带字段，向后兼容），给出时须与 map 键一致。
 * （T3.9 桌面走查发现：文档形态此前被 schema 判缺 serverKey 字段而拒载。） */
async function loadFile(path: string): Promise<Map<string, McpServerConfig>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return new Map();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new McpConfigError("MCP_CONFIG_INVALID", `mcp config is not valid JSON: ${path}`);
  }
  const shape = z.object({ mcpServers: z.record(z.unknown()) }).safeParse(parsed);
  if (!shape.success) {
    throw new McpConfigError("MCP_CONFIG_INVALID", `mcp config invalid at ${path}: mcpServers map expected`);
  }
  const configs = new Map<string, McpServerConfig>();
  for (const [mapKey, entry] of Object.entries(shape.data.mcpServers)) {
    const record = (entry ?? {}) as Record<string, unknown>;
    const declared = record["serverKey"];
    if (typeof declared === "string" && declared !== mapKey) {
      throw new McpConfigError(
        "MCP_CONFIG_INVALID",
        `mcp config invalid at ${path}: serverKey "${declared}" does not match map key "${mapKey}"`,
      );
    }
    const result = mcpServerConfigSchema.safeParse({ ...record, serverKey: mapKey });
    if (!result.success) {
      const detail = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new McpConfigError("MCP_CONFIG_INVALID", `mcp config invalid at ${path} [${mapKey}]: ${detail}`);
    }
    configs.set(mapKey, result.data);
  }
  return configs;
}

/**
 * 多层配置加载：project 覆盖 global 仅限「完全相同的 serverKey+transport+目标」不存在——
 * 按 02 §3.4 从严：同名 serverKey 在多层同时出现视为冲突拒绝（报告位置），单文件内重复键
 * 由 JSON.parse 天然去重（后值覆盖前值，语义同生态惯例）。
 */
export async function loadMcpConfig(sources: McpConfigSource[]): Promise<LoadedMcpConfig> {
  const configs = new Map<string, McpServerConfigLevel>();
  for (const source of sources) {
    const fileConfigs = await loadFile(source.path);
    for (const [serverKey, config] of fileConfigs) {
      validateServerKey(serverKey);
      if (configs.has(serverKey)) {
        throw new McpConfigError(
          "MCP_SERVER_CONFLICT",
          `duplicate serverKey "${serverKey}" in ${source.path} (already defined for ${String(configs.get(serverKey)!.level)} level)`,
        );
      }
      configs.set(serverKey, { ...config, level: source.level });
    }
  }
  return { configs, sources };
}

/** 把单份 server 配置持久化写回指定层级 mcp.json（add/remove 共用；目录不存在则创建）。 */
export async function persistMcpConfig(
  path: string,
  mutate: (servers: Record<string, McpServerConfig>) => void,
): Promise<void> {
  let servers: Record<string, McpServerConfig> = {};
  try {
    const raw = await readFile(path, "utf8");
    const parsed = mcpConfigFileSchema.safeParse(JSON.parse(raw));
    if (parsed.success) {
      servers = parsed.data.mcpServers;
    }
  } catch {
    // 缺文件/损坏：以空配置起底（损坏文件被覆盖前已由 loadMcpConfig 校验拦截）
  }
  mutate(servers);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`, "utf8");
}

export { mcpServerConfigSchema };
