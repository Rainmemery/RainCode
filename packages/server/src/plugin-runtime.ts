/**
 * PluginRuntime：plugins 域装配（06-api-spec §2.10 / v1.8；M3 T3.5 插件化）。
 *
 * - 插件目录 = `<dataRoot>/plugins/<name>/`（plugin.json + 入口 ES module）——插件是注册进
 *   ToolRegistry 的可执行代码（节点全局），不做 workspace 逐会话层（会跨会话泄漏；技能的
 *   per-session 解析不适用于插件），「发布」= 将插件目录拷入 plugins 目录；
 * - 启停：`<dataRoot>/plugins.json`（`{ disabled: string[] }` 停用名单——目录即配置，
 *   停用 ≠ 卸载，状态可独立持久化）；setEnabled(false) = deactivate + 工具注销 + 落盘；
 *   setEnabled(true) = 激活 + 工具注册（source="plugin"）+ 落盘，受理即返（加载为异步，
 *   最终状态经 plugin.status_changed 全局事件与 plugins.list 可查）；
 * - 生命周期：activate（返回工具描述符）→ 注册 → active；deactivate（可选导出，出错仅诊断
 *   不阻塞注销）→ 注销 → disabled；加载/激活失败 → failed + lastError（验收项「插件故障
 *   不拖垮内核」：同批其他插件与内核装配不受影响，工具调用错误为数据级 ToolExecutionError）。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RpcCallError } from "@raincode/rpc";
import type { RpcServiceBinding } from "@raincode/rpc";
import { buildPluginStatusChangedEvent } from "@raincode/shared";
import type { PluginStatus, PluginSummary } from "@raincode/shared";
import { ToolExecutionError } from "@raincode/tools";
import type { ToolRegistry } from "@raincode/tools";
import {
  PluginError,
  activatePlugin,
  createPluginTool,
  readPluginManifest,
  scanPluginDir,
  toPluginToolName,
} from "@raincode/tools";
import type { PluginActivation, PluginManifest } from "@raincode/tools";

// ---------------------------------------------------------------------------
// 停用名单持久化（<dataRoot>/plugins.json；目录即配置，仅状态需落盘）
// ---------------------------------------------------------------------------

/** plugins.json 缺省形态（缺文件 = 空名单 = 全部启用）。 */
interface PluginStateFile {
  disabled: string[];
}

async function loadPluginState(path: string): Promise<PluginStateFile> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { disabled: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { disabled: [] }; // 状态文件损坏按空名单处理（目录仍是真源，最多回到全启用）
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { disabled: [] };
  }
  const record = parsed as Record<string, unknown>;
  const disabled = record["disabled"];
  if (!Array.isArray(disabled) || !disabled.every((item) => typeof item === "string")) {
    return { disabled: [] };
  }
  return { disabled: disabled.filter((item): item is string => typeof item === "string") };
}

async function persistPluginState(path: string, state: PluginStateFile): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify({ disabled: state.disabled }, null, 2)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// PluginRuntime
// ---------------------------------------------------------------------------

/** plugins 域装配依赖（agent-service 注入；风格对齐 McpRuntimeOptions）。 */
export interface PluginRuntimeOptions {
  registry: ToolRegistry;
  /** RAINCODE_HOME（plugins 目录与 plugins.json 所在数据根）。 */
  dataRoot: string;
  /** 全局事件出口（plugin.status_changed；sessionId 缺省事件）。 */
  publish: RpcServiceBinding["publish"];
  /** 诊断出口（缺省 console.error，风格同 mcp-runtime）。 */
  onDiagnostic?: (message: string, err?: unknown) => void;
}

interface PluginRecord {
  name: string;
  dir: string;
  /** 清单解析成功才有 manifest（目录名即 name 的候选也保留 failed 态供 list 呈现）。 */
  manifest: PluginManifest | null;
  enabled: boolean;
  status: PluginStatus;
  tools: string[];
  activation: PluginActivation | null;
  lastError: string | null;
}

export class PluginRuntime {
  private readonly pluginsPath: string;
  private readonly statePath: string;
  private readonly records = new Map<string, PluginRecord>();
  private seq = 0;
  /** 装配期扫描 + 激活的就绪门（控制面方法 await 之——初次扫描完成前调用不落空）。 */
  private readonly ready: Promise<void>;

  constructor(private readonly options: PluginRuntimeOptions) {
    this.pluginsPath = join(options.dataRoot, "plugins");
    this.statePath = join(options.dataRoot, "plugins.json");
    this.ready = this.bootstrap();
  }

  /** 扫描 + 逐个激活启用中的插件（异步受理：失败仅该插件 failed，不阻塞服务启动）。 */
  private async bootstrap(): Promise<void> {
    const state = await loadPluginState(this.statePath);
    const disabled = new Set(state.disabled);
    const candidates = await scanPluginDir(this.pluginsPath);
    for (const candidate of candidates) {
      let manifest: PluginManifest | null = null;
      let lastError: string | null = null;
      try {
        manifest = await readPluginManifest(candidate.dir);
      } catch (reason: unknown) {
        lastError = reason instanceof Error ? reason.message : String(reason);
      }
      const name = manifest?.name ?? candidate.name;
      if (this.records.has(name)) {
        continue; // 重名目录（异常形态）：首命中生效，同技能/profile 口径
      }
      this.records.set(name, {
        name,
        dir: candidate.dir,
        manifest,
        enabled: !disabled.has(name),
        status: "disabled",
        tools: [],
        activation: null,
        lastError,
      });
    }
    // 依次激活启用中的插件（逐个 try/catch——单插件故障不拖垮装配）
    for (const record of this.records.values()) {
      if (!record.enabled) {
        continue;
      }
      await this.activateRecord(record).catch(() => undefined); // 错误已在 record.lastError 记录
    }
  }

  /** plugins.list：全部插件摘要（按名排序，管理面板投影；就绪门后读取）。 */
  async list(): Promise<PluginSummary[]> {
    await this.ready;
    return [...this.records.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((record) => ({
        name: record.name,
        description: record.manifest?.description ?? "",
        ...(record.manifest?.version !== undefined && { version: record.manifest.version }),
        dir: record.dir,
        enabled: record.enabled,
        status: record.status,
        tools: [...record.tools],
        lastError: record.lastError,
      }));
  }

  /**
   * plugins.setEnabled（受理即返）：disable = deactivate + 工具注销 + 停用名单落盘（配置保留
   * ≠ 卸载）；enable = 停用名单移除 + 激活（load/activate 异步，失败 → failed 状态可查）。
   */
  async setEnabled(name: string, enabled: boolean): Promise<{ status: PluginStatus; toolCount: number }> {
    await this.ready;
    const record = this.records.get(name);
    if (record === undefined) {
      throw new RpcCallError("PLUGIN_NOT_FOUND", `plugin not found: ${name}`);
    }
    if (record.enabled === enabled) {
      return { status: record.status, toolCount: record.tools.length }; // 幂等：同态重复请求直接返回
    }
    record.enabled = enabled;
    const state = await loadPluginState(this.statePath);
    const disabled = new Set(state.disabled);
    if (enabled) {
      disabled.delete(name);
    } else {
      disabled.add(name);
    }
    await persistPluginState(this.statePath, { disabled: [...disabled] });
    if (enabled) {
      await this.activateRecord(record);
    } else {
      this.deactivateRecord(record);
    }
    return { status: record.status, toolCount: record.tools.length };
  }

  /** 优雅停机：deactivate 全部 active 插件 + 注销工具（出错仅诊断；就绪门后收敛）。 */
  async dispose(): Promise<void> {
    await this.ready;
    for (const record of this.records.values()) {
      if (record.status === "active") {
        this.deactivateRecord(record);
      }
    }
  }

  /** 激活：load + activate + 注册工具 + 状态/事件推进（失败 → failed + lastError）。 */
  private async activateRecord(record: PluginRecord): Promise<void> {
    try {
      if (record.manifest === null) {
        throw new PluginError("PLUGIN_MANIFEST_INVALID", record.lastError ?? "plugin manifest unreadable");
      }
      const activation = await activatePlugin(record.dir, record.manifest);
      const fullNames: string[] = [];
      for (const descriptor of activation.tools) {
        const tool = createPluginTool(record.name, descriptor);
        this.options.registry.register(tool, "plugin"); // 重名 → registry fail-fast → failed 隔离
        fullNames.push(toPluginToolName(record.name, descriptor.name));
      }
      record.activation = activation;
      record.tools = fullNames;
      record.status = "active";
      record.lastError = null;
    } catch (reason: unknown) {
      record.status = "failed";
      record.lastError = reason instanceof Error ? reason.message : String(reason);
      this.diag(`plugin "${record.name}" activation failed (isolated)`, reason);
    }
    this.publishStatus(record);
  }

  /** 停用：deactivate（出错仅诊断）+ 工具注销 + 状态/事件推进。 */
  private deactivateRecord(record: PluginRecord): void {
    if (record.activation?.deactivate !== undefined) {
      try {
        void record.activation.deactivate();
      } catch (reason: unknown) {
        this.diag(`plugin "${record.name}" deactivate threw (ignored)`, reason);
      }
    }
    for (const fullName of record.tools) {
      this.options.registry.unregister(fullName);
    }
    record.activation = null;
    record.tools = [];
    record.status = "disabled";
    this.publishStatus(record);
  }

  private publishStatus(record: PluginRecord): void {
    try {
      this.options.publish({
        name: "plugin.status_changed",
        payload: buildPluginStatusChangedEvent({
          seq: ++this.seq,
          name: record.name,
          status: record.status,
          toolCount: record.tools.length,
          ...(record.lastError !== null && { error: record.lastError }),
        }),
      });
    } catch (reason: unknown) {
      this.diag(`plugin status event build failed for "${record.name}"`, reason);
    }
  }

  /** 控制面方法表（06 §2.10 plugins 域 2 方法；形态对齐 mcp-runtime.methods）。 */
  methods(register: (method: string, handler: (params: unknown) => Promise<unknown>) => unknown): Record<string, unknown> {
    return {
      "plugins.list": register("plugins.list", async () => ({ plugins: await this.list() })),
      "plugins.setEnabled": register("plugins.setEnabled", async (params) => {
        const { name, enabled } = params as { name: string; enabled: boolean };
        try {
          const result = await this.setEnabled(name, enabled);
          return { name, enabled, status: result.status };
        } catch (reason: unknown) {
          if (reason instanceof RpcCallError) {
            throw reason; // PLUGIN_NOT_FOUND（06 §2.10）
          }
          if (reason instanceof ToolExecutionError) {
            throw new RpcCallError("PLUGIN_INVALID", reason.message);
          }
          throw reason;
        }
      }),
    };
  }

  private diag(message: string, err?: unknown): void {
    const sink = this.options.onDiagnostic ?? ((text: string, error?: unknown) => console.error(`[raincode/server] ${text}`, error ?? ""));
    sink(message, err);
  }
}
