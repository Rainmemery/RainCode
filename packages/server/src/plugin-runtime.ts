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
  /**
   * 装配后钩子（T6.1）：初扫 + 激活完成后、ready 就绪门放行前执行——marketplace 域台账重
   * attach 的确定序接入点（保证重启后首次 plugins.list 已含市场安装插件）。
   */
  postBootstrap?: () => Promise<void>;
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
  /** 记录来源（T6.1）：dir = plugins 目录扫描发布；marketplace = 市场安装副本装配（attachExternal）。 */
  origin: "dir" | "marketplace";
}

export class PluginRuntime {
  private readonly pluginsPath: string;
  private readonly statePath: string;
  private readonly records = new Map<string, PluginRecord>();
  private seq = 0;
  /** 装配期初扫 + 激活的门（attachExternal/detachExternal 等待之——postBootstrap 在其后运行）。 */
  private readonly scanned: Promise<void>;
  /** 就绪门（控制面方法 await 之）：初扫 + 激活 + postBootstrap 钩子（marketplace 重 attach）完成。 */
  private readonly ready: Promise<void>;

  constructor(private readonly options: PluginRuntimeOptions) {
    this.pluginsPath = join(options.dataRoot, "plugins");
    this.statePath = join(options.dataRoot, "plugins.json");
    this.scanned = this.scanAndActivate();
    this.ready = this.scanned.then(() => this.options.postBootstrap?.()).catch((reason: unknown) => {
      this.diag("post-bootstrap hook failed (isolated)", reason);
    });
  }

  /** 初扫 + 逐个激活启用中的插件（异步受理：失败仅该插件 failed，不阻塞服务启动）。 */
  private async scanAndActivate(): Promise<void> {
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
        origin: "dir",
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

  /**
   * plugins.rescan（B10 缺陷修复 / 06 §2.10 v1.11）：运行时重扫描插件目录装载新拷入插件。
   * 仅新增目录：已有记录（含 failed）不重载不触碰（激活中插件的运行状态不可被扫描打断）；
   * 新目录按停用名单判定启用状态，启用中的经 activateRecord 激活（失败隔离为 failed）。
   * 返回本次新装载的插件名（已存在目录名不重复装载）。
   */
  async rescan(): Promise<{ added: string[] }> {
    await this.ready;
    const state = await loadPluginState(this.statePath);
    const disabled = new Set(state.disabled);
    const candidates = await scanPluginDir(this.pluginsPath);
    const added: string[] = [];
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
        continue; // 首命中生效（同技能/profile 口径）：已有记录不重载
      }
      const record: PluginRecord = {
        name,
        dir: candidate.dir,
        manifest,
        enabled: !disabled.has(name),
        status: "disabled",
        tools: [],
        activation: null,
        lastError,
        origin: "dir",
      };
      this.records.set(name, record);
      added.push(name);
      if (record.enabled) {
        await this.activateRecord(record).catch(() => undefined); // 错误已在 record.lastError 记录
      }
    }
    return { added };
  }

  /**
   * marketplace 安装副本装配（T6.1 attachExternal；MarketplaceRuntime 注入调用）：
   * - 同名记录已存在且同为 marketplace 来源：同目录幂等返回现状态；异目录按版本升级处理
   *   （旧激活态退役 + 记录替换 + 重装配）；dir 来源记录同名 → 拒绝（发布目录与市场安装互斥，
   *   由调用方映射 MARKETPLACE_INVALID）；
   * - 新记录按停用名单判定启用状态；清单读取失败不抛（failed 态可见，同 bootstrap 隔离口径），
   *   激活失败隔离为 failed（经 plugin.status_changed 与 plugins.list 可查）。
   */
  async attachExternal(input: { name: string; dir: string }): Promise<PluginStatus> {
    await this.scanned;
    const existing = this.records.get(input.name);
    if (existing !== undefined) {
      if (existing.origin !== "marketplace") {
        throw new RpcCallError("PLUGIN_INVALID", `plugin name conflict: "${input.name}" already published in plugins dir (${existing.dir})`);
      }
      if (existing.dir === input.dir) {
        return existing.status; // 幂等：同源同目录重复装配
      }
      this.deactivateRecord(existing); // 版本升级：旧激活态退役后替换记录
      this.records.delete(input.name);
    }
    const record: PluginRecord = {
      name: input.name,
      dir: input.dir,
      manifest: null,
      enabled: true,
      status: "disabled",
      tools: [],
      activation: null,
      lastError: null,
      origin: "marketplace",
    };
    this.records.set(input.name, record);
    try {
      // dirNameMustMatch: false——marketplace 安装副本目录尾段是版本号（<mkt>/<plugin>/<ver>/），
      // 身份由市场清单 + 安装台账背书（安装前已做 manifest name/version 一致性校验）
      record.manifest = await readPluginManifest(input.dir, { dirNameMustMatch: false });
    } catch (reason: unknown) {
      record.lastError = reason instanceof Error ? reason.message : String(reason);
    }
    const state = await loadPluginState(this.statePath);
    record.enabled = !state.disabled.includes(input.name);
    if (record.enabled) {
      await this.activateRecord(record).catch(() => undefined); // 失败已隔离为 failed + lastError
    } else {
      this.publishStatus(record);
    }
    return record.status;
  }

  /**
   * marketplace 卸载退役（T6.1 detachExternal）：deactivate + 工具注销 + 记录移除 +
   * 停用名单同步清除（卸载 ≠ 停用——残留名单会在重装时压制新插件）。dir 来源记录拒绝
   * （发布目录的移除不经本方法）；记录不存在容忍（幂等，清单读取失败态也可能无记录）。
   */
  async detachExternal(name: string): Promise<void> {
    await this.scanned;
    const record = this.records.get(name);
    if (record !== undefined) {
      if (record.origin !== "marketplace") {
        throw new RpcCallError("PLUGIN_INVALID", `plugin "${name}" is not marketplace-managed; its plugins-dir copy is not uninstallable via marketplace`);
      }
      this.deactivateRecord(record);
      this.records.delete(name);
    }
    const state = await loadPluginState(this.statePath);
    if (state.disabled.includes(name)) {
      await persistPluginState(this.statePath, { disabled: state.disabled.filter((item) => item !== name) });
    }
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

  /** 控制面方法表（06 §2.10 plugins 域 3 方法；形态对齐 mcp-runtime.methods）。 */
  methods(register: (method: string, handler: (params: unknown) => Promise<unknown>) => unknown): Record<string, unknown> {
    return {
      "plugins.list": register("plugins.list", async () => ({ plugins: await this.list() })),
      "plugins.rescan": register("plugins.rescan", async () => this.rescan()),
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
