/**
 * 插件清单加载与激活（M3 T3.5；02-module-design §2.3 ToolRegistry 插件扩展点）。
 *
 * 插件包形态（与技能/profile 目录约定同口径，07 §4.1 T3.5「复用技能加载的注册机制」）：
 * `<dataRoot>/plugins/<name>/` 目录 = plugin.json 清单 + 入口 ES module（缺省 index.mjs）。
 * 模块契约：`export function activate(context: { pluginDir: string })` 返回工具描述符数组，
 * 可选 `export function deactivate()`（停用/收尾时调用，出错仅诊断不阻塞注销）。
 *
 * 故障隔离（验收项「插件故障不拖垮内核」）：清单非法/入口缺失/activate 抛错均映射为
 * PluginError 由 runtime 捕获为该插件 failed 状态——同批其他插件与内核装配不受影响；
 * 插件名 [a-z0-9-]+（防路径逃逸，同名目录扫描首命中生效）。
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

/** 清单文件名（插件目录内）。 */
export const PLUGIN_MANIFEST_FILE = "plugin.json";
/** 入口缺省文件名（清单 entry 可覆盖）。 */
export const PLUGIN_DEFAULT_ENTRY = "index.mjs";

/** 插件名（目录名与清单 name 一致性校验用；[a-z0-9-]+ 挡路径逃逸，同技能名口径）。 */
export const PLUGIN_NAME_PATTERN = /^[a-z0-9-]+$/;
/** 插件工具名（工具段允许下划线，同内置工具 todo_write 口径）。 */
export const PLUGIN_TOOL_NAME_PATTERN = /^[a-z0-9_]+$/;

/** 插件加载错误（runtime 捕获 → 插件 failed 状态 + lastError，不拖垮内核）。 */
export class PluginError extends Error {
  readonly code: "PLUGIN_MANIFEST_INVALID" | "PLUGIN_ENTRY_INVALID" | "PLUGIN_ACTIVATE_FAILED";

  constructor(code: PluginError["code"], message: string) {
    super(`[${code}] ${message}`);
    this.name = "PluginError";
    this.code = code;
  }
}

/** plugin.json 清单（zod 单一事实源；entry 相对插件目录解析）。 */
export const pluginManifestSchema = z.strictObject({
  name: z.string().regex(PLUGIN_NAME_PATTERN),
  description: z.string().min(1),
  version: z.string().min(1).optional(),
  entry: z.string().min(1).endsWith(".mjs").optional(),
});
export type PluginManifest = z.infer<typeof pluginManifestSchema>;

/** 插件工具描述符（activate 返回；plain JS 契约，无 zod 依赖——schema 走 JSON Schema 直通）。 */
export interface PluginToolDescriptor {
  name: string;
  description: string;
  /** JSON Schema 直通（缺省 { type: "object" }；运行时仅保留宽松 object 形状校验，同 MCP 口径）。 */
  parametersJsonSchema?: Record<string, unknown>;
  /** 权限元数据（缺省从严：needsApproval=true / riskLevel="medium"，同 MCP 适配器口径）。 */
  metadata?: {
    readOnly?: boolean;
    destructive?: boolean;
    needsApproval?: boolean;
    riskLevel?: "low" | "medium" | "high";
    timeoutMs?: number;
  };
  execute(args: unknown, ctx: { signal: AbortSignal }): Promise<string>;
}

/** 激活产物：工具描述符 + 可选反激活钩子。 */
export interface PluginActivation {
  tools: PluginToolDescriptor[];
  deactivate?: () => void | Promise<void>;
}

/** 插件激活上下文（最小面：插件目录绝对路径；后续按需扩入，不透传内核对象）。 */
export interface PluginActivateContext {
  pluginDir: string;
}

/** 扫描单个插件目录清单：读 plugin.json → zod 校验 → 目录名与 name 一致性（可放宽，见参数）。 */
export async function readPluginManifest(
  dir: string,
  options?: { /** false = 放宽目录名比对（T6.1 marketplace 安装副本：<...>/<plugin>/<version>/ 尾段是版本号，身份由市场清单+台账背书，安装前已做 manifest 一致性校验）；缺省严格。 */ dirNameMustMatch?: boolean },
): Promise<PluginManifest> {
  const dirNameMustMatch = options?.dirNameMustMatch ?? true;
  let raw: string;
  try {
    raw = await readFile(join(dir, PLUGIN_MANIFEST_FILE), "utf8");
  } catch (reason: unknown) {
    throw new PluginError("PLUGIN_MANIFEST_INVALID", `plugin manifest unreadable at ${dir}: ${String(reason)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PluginError("PLUGIN_MANIFEST_INVALID", `plugin manifest is not valid JSON: ${join(dir, PLUGIN_MANIFEST_FILE)}`);
  }
  const result = pluginManifestSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new PluginError("PLUGIN_MANIFEST_INVALID", `plugin manifest invalid at ${dir}: ${detail}`);
  }
  if (dirNameMustMatch && result.data.name !== dir.split(/[\\/]/).filter(Boolean).pop()) {
    throw new PluginError(
      "PLUGIN_MANIFEST_INVALID",
      `plugin name "${result.data.name}" does not match its directory name at ${dir}`,
    );
  }
  return result.data;
}

/** 扫描插件根目录下的全部插件（一级子目录含 plugin.json 即候选；仅目录、符号链接不跟进）。 */
export async function scanPluginDir(root: string): Promise<Array<{ dir: string; name: string }>> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return []; // 根目录不存在 = 无插件（不视为错误，技能目录同口径）
  }
  const found: Array<{ dir: string; name: string }> = [];
  for (const entry of entries) {
    if (!PLUGIN_NAME_PATTERN.test(entry)) {
      continue; // 非法目录名直接忽略（防路径逃逸）
    }
    const dir = join(root, entry);
    try {
      if ((await stat(dir)).isDirectory()) {
        found.push({ dir, name: entry });
      }
    } catch {
      // stat 失败（竞态删除/权限）：跳过该候选
    }
  }
  return found;
}

/** 逐条校验 activate 返回的工具描述符（LLM/第三方产出不可信，加载期即拦截）。 */
function validateDescriptor(raw: unknown, index: number, pluginName: string): PluginToolDescriptor {
  if (typeof raw !== "object" || raw === null) {
    throw new PluginError("PLUGIN_ACTIVATE_FAILED", `plugin "${pluginName}" tool[${String(index)}] is not an object`);
  }
  const record = raw as Record<string, unknown>;
  if (typeof record["name"] !== "string" || !PLUGIN_TOOL_NAME_PATTERN.test(record["name"])) {
    throw new PluginError(
      "PLUGIN_ACTIVATE_FAILED",
      `plugin "${pluginName}" tool[${String(index)}].name must match ${PLUGIN_TOOL_NAME_PATTERN.source}`,
    );
  }
  if (typeof record["description"] !== "string" || record["description"].trim().length === 0) {
    throw new PluginError("PLUGIN_ACTIVATE_FAILED", `plugin "${pluginName}" tool[${String(record["name"])}].description must be a non-empty string`);
  }
  if (typeof record["execute"] !== "function") {
    throw new PluginError("PLUGIN_ACTIVATE_FAILED", `plugin "${pluginName}" tool[${String(record["name"])}].execute must be a function`);
  }
  const schema = record["parametersJsonSchema"];
  if (schema !== undefined && (typeof schema !== "object" || schema === null || Array.isArray(schema))) {
    throw new PluginError("PLUGIN_ACTIVATE_FAILED", `plugin "${pluginName}" tool[${String(record["name"])}].parametersJsonSchema must be an object`);
  }
  const meta = record["metadata"];
  if (meta !== undefined) {
    if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
      throw new PluginError("PLUGIN_ACTIVATE_FAILED", `plugin "${pluginName}" tool[${String(record["name"])}].metadata must be an object`);
    }
    const m = meta as Record<string, unknown>;
    for (const flag of ["readOnly", "destructive", "needsApproval"] as const) {
      if (m[flag] !== undefined && typeof m[flag] !== "boolean") {
        throw new PluginError("PLUGIN_ACTIVATE_FAILED", `plugin "${pluginName}" tool[${String(record["name"])}].metadata.${flag} must be boolean`);
      }
    }
    if (m["riskLevel"] !== undefined && m["riskLevel"] !== "low" && m["riskLevel"] !== "medium" && m["riskLevel"] !== "high") {
      throw new PluginError("PLUGIN_ACTIVATE_FAILED", `plugin "${pluginName}" tool[${String(record["name"])}].metadata.riskLevel must be low|medium|high`);
    }
    if (m["timeoutMs"] !== undefined && (typeof m["timeoutMs"] !== "number" || !Number.isInteger(m["timeoutMs"]) || m["timeoutMs"] <= 0)) {
      throw new PluginError("PLUGIN_ACTIVATE_FAILED", `plugin "${pluginName}" tool[${String(record["name"])}].metadata.timeoutMs must be a positive integer`);
    }
  }
  return {
    name: record["name"],
    description: record["description"],
    ...(schema !== undefined && { parametersJsonSchema: schema as Record<string, unknown> }),
    ...(meta !== undefined && { metadata: meta as PluginToolDescriptor["metadata"] }),
    execute: record["execute"] as PluginToolDescriptor["execute"],
  };
}

/**
 * 加载并激活插件：动态 import 入口（ESM 缓存按 URL，重启用复用同模块）→ activate →
 * 逐条校验描述符。入口缺失 / 无 activate 导出 / activate 抛错 / 描述符非法 → PluginError。
 */
export async function activatePlugin(dir: string, manifest: PluginManifest): Promise<PluginActivation> {
  const entry = join(dir, manifest.entry ?? PLUGIN_DEFAULT_ENTRY);
  let module: Record<string, unknown>;
  try {
    module = (await import(pathToFileURL(entry).href)) as Record<string, unknown>;
  } catch (reason: unknown) {
    throw new PluginError("PLUGIN_ENTRY_INVALID", `plugin "${manifest.name}" entry import failed: ${String(reason)}`);
  }
  if (typeof module["activate"] !== "function") {
    throw new PluginError("PLUGIN_ENTRY_INVALID", `plugin "${manifest.name}" entry has no activate() export: ${entry}`);
  }
  let returned: unknown;
  try {
    returned = await (module["activate"] as (ctx: PluginActivateContext) => unknown)({ pluginDir: dir });
  } catch (reason: unknown) {
    throw new PluginError("PLUGIN_ACTIVATE_FAILED", `plugin "${manifest.name}" activate() threw: ${String(reason)}`);
  }
  if (!Array.isArray(returned)) {
    throw new PluginError("PLUGIN_ACTIVATE_FAILED", `plugin "${manifest.name}" activate() must return an array of tool descriptors`);
  }
  const deactivate = typeof module["deactivate"] === "function" ? (module["deactivate"] as () => void | Promise<void>) : undefined;
  return {
    tools: returned.map((raw, index) => validateDescriptor(raw, index, manifest.name)),
    ...(deactivate !== undefined && { deactivate }),
  };
}

/** 插件工具全名（命名空间与 mcp__<serverKey>__<toolName> 同构，registry 命名空间豁免对应）。 */
export function toPluginToolName(pluginName: string, toolName: string): string {
  return `plugin__${pluginName}__${toolName}`;
}
