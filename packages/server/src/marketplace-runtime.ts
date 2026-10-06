/**
 * MarketplaceRuntime：marketplace 域装配（T6.1 / 06-api-spec §2.10 v1.14 additive）。
 *
 * 分发链（ZCode「源/市场缓存副本/安装副本」三分离形态的 path 源先行版）：
 * - 已知市场注册表 `<dataRoot>/marketplaces.json`（known_marketplaces 同构，source={path} 本地
 *   目录源先行——url/github 远端源形态预留不实现，schema 收窄以免假支持）；
 * - 安装副本 `<dataRoot>/marketplaces/cache/<marketplaceId>/<plugin>/<version>/` + 内容寻址种子
 *   `.zcode-plugin-seed.json`（内容哈希 = marketplace-fs hashPluginTree；重装同版本哈希一致即幂等，
 *   不一致 = 副本被篡改/种子缺失 → MARKETPLACE_SEED_MISMATCH，卸载重装恢复）；
 * - 安装台账 `<dataRoot>/marketplaces/installed.json`（重启后重装配的事实源：bootstrap 逐条
 *   attachExternal 回 PluginRuntime；插件名全局唯一——台账与插件记录均按名键）；
 * - 市场缓存副本（远端源拉取缓存）属 url/github 源形态，path 源即本地目录，顺延不实现。
 *
 * 技能随插件（T6.1 第三源）：安装副本 `<dir>/skills/*.md` 经 installedPluginDirs() 注入
 * SkillRuntime（解析优先级 workspace > global > plugin）。
 *
 * 生命周期：install = 逃逸防护 → 清单/版本一致性校验 → 哈希 → 拷贝 + 种子 → 台账落盘 →
 * attachExternal（active/disabled/failed 状态快照返回，激活失败隔离同插件域口径）；
 * uninstall = detachExternal + 安装副本删除 + 台账移除（停用名单同步清除——卸载 ≠ 停用）。
 * 装配依赖 plugins 域在位（插件激活/注销归 PluginRuntime；缺位 → 域不装配，06 §2 装配口径）。
 */
import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { RpcCallError } from "@raincode/rpc";
import {
  MARKETPLACE_ERROR_CODES,
  marketplaceLedgerFileSchema,
  marketplaceManifestSchema,
  marketplacesRegistryFileSchema,
  marketplaceSeedFileSchema,
} from "@raincode/shared";
import type {
  KnownMarketplace,
  MarketplaceInstalledRecord,
  MarketplaceManifest,
  MarketplaceSeedFile,
  PluginStatus,
} from "@raincode/shared";
import { readPluginManifest } from "@raincode/tools";
import {
  MarketplaceEscapeError,
  assertPluginTreeContainment,
  copyPluginTree,
  hashPluginTree,
  isDirectory,
  isPathInside,
  MARKETPLACE_SEED_FILE,
} from "./marketplace-fs.js";
import type { PluginRuntime } from "./plugin-runtime.js";

/** marketplace 域装配依赖（runtime-domains 注入）。 */
export interface MarketplaceRuntimeOptions {
  /** RAINCODE_HOME（注册表/台账/缓存根所在数据根）。 */
  dataRoot: string;
  /** 插件域装配（安装副本的激活/注销单点；marketplace 域要求 plugins 域在位）。 */
  plugins: PluginRuntime;
  /** 诊断出口（缺省 console.error；逃逸防护越界路径经此审计）。 */
  onDiagnostic?: (message: string, err?: unknown) => void;
}

/** 泛化 JSON 文件读取（schema 校验；缺失/损坏返回 null——文件属可选状态，同 plugins.json 口径）。 */
async function loadJsonFile<T>(path: string, parse: (raw: unknown) => T): Promise<T | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  try {
    return parse(JSON.parse(text));
  } catch {
    return null;
  }
}

async function persistJson(path: string, data: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function marketplaceError(code: keyof typeof MARKETPLACE_ERROR_CODES, message: string): RpcCallError {
  return new RpcCallError(MARKETPLACE_ERROR_CODES[code], message);
}

export class MarketplaceRuntime {
  private readonly registryPath: string;
  private readonly cacheRoot: string;
  private readonly ledgerPath: string;
  private readonly registry = new Map<string, KnownMarketplace>();
  /** 安装台账（按插件名键——插件名全局唯一）。 */
  private readonly ledger = new Map<string, MarketplaceInstalledRecord>();
  /** 启动门（幂等 bootstrap 惰性 memo）。 */
  private readyPromise: Promise<void> | null = null;

  constructor(private readonly options: MarketplaceRuntimeOptions) {
    const marketplacesDir = join(options.dataRoot, "marketplaces");
    this.registryPath = join(options.dataRoot, "marketplaces.json");
    this.cacheRoot = join(marketplacesDir, "cache");
    this.ledgerPath = join(marketplacesDir, "installed.json");
  }

  /** 启动（幂等）：注册表 + 台账加载（损坏降级为空 + 诊断）→ 已装插件逐条重 attach（重启存活；
   * 失败隔离）。调用方：PluginRuntime postBootstrap 钩子（装配确定序——保证重启后首次
   * plugins.list 已含市场安装插件）；未接钩子时由首个控制面调用自愈启动。 */
  bootstrap(): Promise<void> {
    this.readyPromise ??= this.doBootstrap();
    return this.readyPromise;
  }

  private async doBootstrap(): Promise<void> {
    const registryFile = await loadJsonFile(this.registryPath, (raw) => {
      const parsed = marketplacesRegistryFileSchema.parse(raw);
      // 逐条合法性复核（手改防护）：id 模式与绝对路径不合的条目跳过并诊断
      const valid = parsed.marketplaces.filter(
        (item) => /^[a-z0-9-]+$/.test(item.id) && isAbsolute(item.source.path),
      );
      if (valid.length !== parsed.marketplaces.length) {
        this.diag(`marketplaces.json 含非法条目（id 模式/路径须绝对），已跳过 ${parsed.marketplaces.length - valid.length} 条`);
      }
      return valid;
    });
    for (const item of registryFile ?? []) {
      this.registry.set(item.id, item);
    }
    const ledgerFile = await loadJsonFile(this.ledgerPath, (raw) => marketplaceLedgerFileSchema.parse(raw).installed);
    for (const record of ledgerFile ?? []) {
      this.ledger.set(record.plugin, record);
    }
    for (const record of this.ledger.values()) {
      await this.options.plugins.attachExternal({ name: record.plugin, dir: record.dir }).catch((reason: unknown) => {
        this.diag(`marketplace 安装插件 "${record.plugin}" 重装配失败（隔离，台账保留）`, reason);
      });
    }
  }

  /** 技能第三源（SkillRuntime 注入）：已安装插件根目录（技能取 `<dir>/skills`）。 */
  async installedPluginDirs(): Promise<string[]> {
    await this.bootstrap();
    return [...this.ledger.values()].sort((a, b) => a.plugin.localeCompare(b.plugin)).map((record) => record.dir);
  }

  // -------------------------------------------------------------------------
  // 控制面方法（06 §2.10 v1.14：marketplace.add / list / install / uninstall）
  // -------------------------------------------------------------------------

  /** marketplace.add：path 源市场注册（fail-fast 校验市场根与清单；同 id 同路径幂等）。 */
  private async add(id: string, source: { path: string }): Promise<KnownMarketplace> {
    await this.bootstrap();
    if (!isAbsolute(source.path)) {
      throw marketplaceError("INVALID", `marketplace source path must be absolute: ${source.path}`);
    }
    const root = resolve(source.path);
    if (!(await isDirectory(root))) {
      throw marketplaceError("INVALID", `marketplace source path is not a directory: ${root}`);
    }
    const manifest = await this.readManifest(root);
    const existing = this.registry.get(id);
    if (existing !== undefined) {
      if (resolve(existing.source.path) === root) {
        return existing; // 幂等：同 id 同源重复注册
      }
      throw marketplaceError("INVALID", `marketplace id already registered with a different source: ${id}`);
    }
    const record: KnownMarketplace = { id, source: { path: root }, name: manifest.name, addedAt: Date.now() };
    this.registry.set(id, record);
    await this.persistRegistry();
    return record;
  }

  /** marketplace.list：注册表投影 + 市场清单现读（单市场清单损坏降级 lastError，不阻塞其他市场）。 */
  private async list(): Promise<{
    marketplaces: ReturnType<MarketplaceRuntime["projectMarketplace"]>[];
  }> {
    await this.bootstrap();
    return {
      marketplaces: [...this.registry.values()]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((marketplace) => this.projectMarketplace(marketplace)),
    };
  }

  /** 单市场投影：清单条目 + 安装状态（台账按 marketplaceId 匹配）；清单现读失败降级空投影。 */
  private projectMarketplace(marketplace: KnownMarketplace): {
    id: string;
    source: { path: string };
    name?: string;
    addedAt: number;
    pluginCount: number;
    plugins: Array<{
      name: string;
      version: string;
      description: string;
      displayName?: string;
      category?: string;
      source: string;
      installed: { version: string; dir: string } | null;
    }>;
    lastError: string | null;
  } {
    let entries: MarketplaceManifest["plugins"] = [];
    let lastError: string | null = null;
    try {
      const manifest = this.readManifestSync(marketplace.source.path);
      entries = manifest.plugins;
    } catch (reason: unknown) {
      lastError = reason instanceof Error ? reason.message : String(reason);
      this.diag(`marketplace "${marketplace.id}" 清单现读失败（降级空投影）`, reason);
    }
    return {
      id: marketplace.id,
      source: marketplace.source,
      ...(marketplace.name !== undefined && { name: marketplace.name }),
      addedAt: marketplace.addedAt,
      pluginCount: entries.length,
      plugins: entries.map((entry) => {
        const installed = this.ledger.get(entry.name);
        const installedHere =
          installed !== undefined && installed.marketplaceId === marketplace.id
            ? { version: installed.version, dir: installed.dir }
            : null;
        return {
          name: entry.name,
          version: entry.version,
          description: entry.description,
          ...(entry.displayName !== undefined && { displayName: entry.displayName }),
          ...(entry.category !== undefined && { category: entry.category }),
          source: entry.source,
          installed: installedHere,
        };
      }),
      lastError,
    };
  }

  /** marketplace.install：注册市场 → 安装副本 → 种子 → 台账 → 插件域 attach（受理状态快照返回）。 */
  private async install(marketplaceId: string, plugin: string): Promise<{
    name: string;
    marketplaceId: string;
    version: string;
    dir: string;
    status: PluginStatus;
  }> {
    await this.bootstrap();
    const marketplace = this.registry.get(marketplaceId);
    if (marketplace === undefined) {
      throw marketplaceError("NOT_FOUND", `marketplace not found: ${marketplaceId}`);
    }
    let manifest: MarketplaceManifest;
    try {
      manifest = this.readManifestSync(marketplace.source.path);
    } catch (reason: unknown) {
      throw marketplaceError("INVALID", `marketplace manifest unreadable at ${marketplace.source.path}: ${reason instanceof Error ? reason.message : String(reason)}`);
    }
    const entry = manifest.plugins.find((item) => item.name === plugin);
    if (entry === undefined) {
      throw marketplaceError("NOT_FOUND", `plugin "${plugin}" not found in marketplace "${marketplaceId}"`);
    }
    // 清单 source 子目录解析：resolve 级必须落在市场根内（realpath 级防护在树遍历中逐条目执行）
    const marketplaceRoot = resolve(marketplace.source.path);
    const pluginRoot = resolve(marketplaceRoot, entry.source);
    if (!isPathInside(marketplaceRoot, pluginRoot)) {
      throw marketplaceError("INVALID", `entry source escapes marketplace root: ${entry.source}`);
    }
    if (!(await isDirectory(pluginRoot))) {
      throw marketplaceError("INVALID", `plugin source directory missing: ${pluginRoot}`);
    }
    // 逃逸防护（T6.1 验收项）：插件树内 symlink/junction 解析越界即拒绝并审计
    try {
      await assertPluginTreeContainment(pluginRoot);
    } catch (reason: unknown) {
      if (reason instanceof MarketplaceEscapeError) {
        this.diag(`marketplace escape blocked（审计）: ${reason.offendingPath}`, reason);
        throw marketplaceError("ESCAPE_BLOCKED", reason.message);
      }
      throw marketplaceError("INVALID", `plugin tree walk failed: ${reason instanceof Error ? reason.message : String(reason)}`);
    }
    // 插件本体清单一致性：plugin.json 合法 + name 一致 + 与市场登记版本一致（双在时）
    try {
      const pluginManifest = await readPluginManifest(pluginRoot);
      if (pluginManifest.name !== entry.name) {
        throw marketplaceError("INVALID", `plugin.json name "${pluginManifest.name}" does not match marketplace entry "${entry.name}"`);
      }
      if (pluginManifest.version !== undefined && pluginManifest.version !== entry.version) {
        throw marketplaceError("INVALID", `plugin.json version "${pluginManifest.version}" does not match marketplace entry version "${entry.version}"`);
      }
    } catch (reason: unknown) {
      if (reason instanceof RpcCallError) {
        throw reason;
      }
      throw marketplaceError("INVALID", `plugin manifest invalid at ${pluginRoot}: ${reason instanceof Error ? reason.message : String(reason)}`);
    }
    const sourceHash = await hashPluginTree(pluginRoot);
    const versionDir = join(this.cacheRoot, marketplaceId, plugin, entry.version);
    if (await isDirectory(versionDir)) {
      // 已有安装副本：双段种子校验——副本哈希须等于种子（副本被篡改 → 拒绝），源哈希须等于种子
      // （同版本源漂移 → 拒绝）；双一致即幂等。复位路径 = 卸载后重装。
      const seed = await loadJsonFile<MarketplaceSeedFile>(join(versionDir, MARKETPLACE_SEED_FILE), (raw) =>
        marketplaceSeedFileSchema.parse(raw),
      );
      if (seed === null) {
        throw marketplaceError("SEED_MISMATCH", `installed copy seed missing/corrupt at ${versionDir}（卸载后重装以复位）`);
      }
      const targetHash = await hashPluginTree(versionDir); // 种子文件自身不参与哈希（walker 跳过）
      if (targetHash !== seed.hash) {
        throw marketplaceError("SEED_MISMATCH", `installed copy content drifts from seed at ${versionDir}（卸载后重装以复位）`);
      }
      if (sourceHash !== seed.hash) {
        throw marketplaceError("SEED_MISMATCH", `marketplace source content differs from installed seed for ${marketplaceId}/${plugin}@${entry.version}（卸载后重装以复位）`);
      }
    } else {
      await mkdir(versionDir, { recursive: true });
      const { files } = await copyPluginTree(pluginRoot, versionDir);
      const seed: MarketplaceSeedFile = {
        version: 1,
        hash: sourceHash,
        marketplace: marketplaceId,
        plugin: entry.name,
        pluginVersion: entry.version,
        source: marketplace.source.path,
      };
      await persistJson(join(versionDir, MARKETPLACE_SEED_FILE), seed);
      this.diag(`marketplace install: ${marketplaceId}/${plugin}@${entry.version}（${String(files)} files, sha256 ${sourceHash.slice(0, 12)}…）`);
    }
    await this.pruneSiblingVersions(marketplaceId, plugin, entry.version);
    this.ledger.set(entry.name, {
      marketplaceId,
      plugin: entry.name,
      version: entry.version,
      dir: versionDir,
      seedHash: sourceHash,
      installedAt: Date.now(),
    });
    await this.persistLedger();
    let status: PluginStatus;
    try {
      status = await this.options.plugins.attachExternal({ name: entry.name, dir: versionDir });
    } catch (reason: unknown) {
      // 名称冲突（plugins 目录已发布同名插件）等装配拒绝：回滚台账保持一致
      this.ledger.delete(entry.name);
      await this.persistLedger();
      if (reason instanceof RpcCallError) {
        throw marketplaceError("INVALID", `marketplace install rejected: ${reason.message}`);
      }
      throw reason;
    }
    return { name: entry.name, marketplaceId, version: entry.version, dir: versionDir, status };
  }

  /** marketplace.uninstall：detach + 安装副本删除 + 台账移除（停用名单由 detachExternal 同步清除）。 */
  private async uninstall(marketplaceId: string, plugin: string): Promise<{ removed: true }> {
    await this.bootstrap();
    const record = this.ledger.get(plugin);
    if (record === undefined || record.marketplaceId !== marketplaceId) {
      throw marketplaceError("NOT_FOUND", `installed plugin "${plugin}" not found in marketplace "${marketplaceId}"`);
    }
    await this.options.plugins.detachExternal(plugin).catch((reason: unknown) => {
      this.diag(`marketplace uninstall: detach "${plugin}" failed（继续文件清理）`, reason);
    });
    await rm(record.dir, { recursive: true, force: true });
    this.ledger.delete(plugin);
    await this.persistLedger();
    return { removed: true };
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  /** 市场清单现读（strict schema；add 路径用 async 态、list/install 路径用同步抛错态）。 */
  private async readManifest(root: string): Promise<MarketplaceManifest> {
    let raw: string;
    try {
      raw = await readFile(join(root, "marketplace.json"), "utf8");
    } catch (reason: unknown) {
      throw marketplaceError("INVALID", `marketplace.json unreadable at ${root}: ${String(reason)}`);
    }
    const parsed = marketplaceManifestSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw marketplaceError("INVALID", `marketplace.json invalid at ${root}: ${detail}`);
    }
    return parsed.data;
  }

  /** 同步抛错版清单读取（list/install 低频控制面同 skill/profile 目录同步 IO 口径）。 */
  private readManifestSync(root: string): MarketplaceManifest {
    const raw = readFileSync(join(root, "marketplace.json"), "utf8");
    return marketplaceManifestSchema.parse(JSON.parse(raw));
  }

  /** 版本目录收尾：清理同插件其余版本目录（台账只保单版本；目录不存在静默）。 */
  private async pruneSiblingVersions(marketplaceId: string, plugin: string, keepVersion: string): Promise<void> {
    const pluginDir = join(this.cacheRoot, marketplaceId, plugin);
    let versions: string[];
    try {
      versions = (await readdir(pluginDir)).filter((name) => name !== keepVersion);
    } catch {
      return;
    }
    for (const version of versions) {
      await rm(join(pluginDir, version), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async persistRegistry(): Promise<void> {
    await persistJson(this.registryPath, {
      version: 1,
      marketplaces: [...this.registry.values()].sort((a, b) => a.id.localeCompare(b.id)),
    });
  }

  private async persistLedger(): Promise<void> {
    await persistJson(this.ledgerPath, {
      version: 1,
      installed: [...this.ledger.values()].sort((a, b) => a.plugin.localeCompare(b.plugin)),
    });
  }

  /** 控制面方法表（06 §2.10 v1.14；形态对齐 plugin-runtime.methods）。 */
  methods(register: (method: string, handler: (params: unknown) => Promise<unknown>) => unknown): Record<string, unknown> {
    return {
      "marketplace.add": register("marketplace.add", async (params) => {
        const { id, source } = params as { id: string; source: { path: string } };
        return { marketplace: await this.add(id, source) };
      }),
      "marketplace.list": register("marketplace.list", async () => this.list()),
      "marketplace.install": register("marketplace.install", async (params) => {
        const { marketplaceId, plugin } = params as { marketplaceId: string; plugin: string };
        return this.install(marketplaceId, plugin);
      }),
      "marketplace.uninstall": register("marketplace.uninstall", async (params) => {
        const { marketplaceId, plugin } = params as { marketplaceId: string; plugin: string };
        return this.uninstall(marketplaceId, plugin);
      }),
    };
  }

  /** 优雅停机收敛（无长驻资源：就绪门等待即可，风格同 memory 域 dispose 最小实现）。 */
  async dispose(): Promise<void> {
    await this.bootstrap();
  }

  private diag(message: string, err?: unknown): void {
    const sink = this.options.onDiagnostic ?? ((text: string, error?: unknown) => console.error(`[raincode/server] ${text}`, error ?? ""));
    sink(message, err);
  }
}
