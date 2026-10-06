import { z } from "zod";
import { pluginStatusSchema } from "./plugin.js";

/**
 * marketplace 域（T6.1，06-api-spec §2.10 / v1.14 additive）：插件市场的分发面。
 *
 * 形态（ZCode 实证格式字段子集，M6 排期调研报告 §1.3）：市场清单 marketplace.json
 * （`{name, version, plugins[]}` 字段子集 name/version/source/description/displayName/category，
 * 呈现层 i18n/icon/examplePrompts 不做）+ 已知市场注册表 marketplaces.json（source=path 本地
 * 目录源先行，url/github 形态预留不实现）+ 安装布局 `<dataRoot>/marketplaces/cache/<marketplaceId>/
 * <plugin>/<version>/`（安装副本；ZCode「源/市场缓存副本/安装副本」三分离中市场缓存副本属远端
 * 源拉取缓存，path 源即本地目录，随 url/github 源顺延）+ 内容寻址种子 .zcode-plugin-seed.json。
 * 只放 schema、纯类型、常量，禁止业务行为（04 §2.4 铁律 2）；运行时装配在 server marketplace-runtime。
 */

// ---------------------------------------------------------------------------
// 错误码常量（06 §4.3 段 15）
// ---------------------------------------------------------------------------

export const MARKETPLACE_ERROR_CODES = {
  /** 未知市场 id 或市场中无该插件（marketplace.install/uninstall；06 §4.3 MARKETPLACE_NOT_FOUND）。 */
  NOT_FOUND: "MARKETPLACE_NOT_FOUND",
  /** 市场/插件清单非法、source 越界、版本号非法、插件名冲突、未支持的源形态。 */
  INVALID: "MARKETPLACE_INVALID",
  /** 安装副本内容与种子记录不一致（目标目录被篡改或种子缺失——卸载后重装恢复）。 */
  SEED_MISMATCH: "MARKETPLACE_SEED_MISMATCH",
  /** symlink/junction 逃逸：插件树内条目 realpath 解析后落在插件根之外，拒绝安装（T6.1 防护）。 */
  ESCAPE_BLOCKED: "MARKETPLACE_ESCAPE_BLOCKED",
} as const;
export type MarketplaceErrorCode = (typeof MARKETPLACE_ERROR_CODES)[keyof typeof MARKETPLACE_ERROR_CODES];

// ---------------------------------------------------------------------------
// 文件格式 schema（marketplace.json / marketplaces.json / installed.json / seed）
// ---------------------------------------------------------------------------

/** 已知市场源（v1.14 仅 path 本地目录源；url/github 形态预留，schema 收窄以免假支持）。 */
export const marketplaceSourceSchema = z.strictObject({
  /** 市场根目录绝对路径（根内须有 marketplace.json）。 */
  path: z.string().min(1),
});
export type MarketplaceSource = z.infer<typeof marketplaceSourceSchema>;

/** 市场清单条目（marketplace.json plugins[] 项；source 为相对市场根的插件子目录）。 */
export const marketplaceEntrySchema = z.strictObject({
  /** 插件名（[a-z0-9-]+，与 plugin.json name 一致；即缓存目录名与插件命名空间）。 */
  name: z.string().regex(/^[a-z0-9-]+$/),
  /** 市场登记版本（安装目录版本段；与 plugin.json version 同时存在时须一致）。 */
  version: z.string().regex(/^[A-Za-z0-9._+-]+$/),
  /** 插件源子目录（相对市场根，解析后必须落在市场根内）。 */
  source: z.string().min(1),
  description: z.string().min(1),
  /** 呈现层可选字段（字段子集内；i18n/icon/examplePrompts 不做）。 */
  displayName: z.string().min(1).optional(),
  category: z.string().min(1).optional(),
});
export type MarketplaceEntry = z.infer<typeof marketplaceEntrySchema>;

/** 市场清单（marketplace.json，市场根目录内；strict 解析拒绝未知字段）。 */
export const marketplaceManifestSchema = z.strictObject({
  name: z.string().min(1),
  version: z.string().min(1),
  plugins: z.array(marketplaceEntrySchema),
});
export type MarketplaceManifest = z.infer<typeof marketplaceManifestSchema>;

/** 已知市场注册表条目（<dataRoot>/marketplaces.json marketplaces[] 项）。 */
export const knownMarketplaceSchema = z.object({
  /** 市场 id（[a-z0-9-]+，即缓存目录段——防路径逃逸）。 */
  id: z.string().regex(/^[a-z0-9-]+$/),
  source: marketplaceSourceSchema,
  name: z.string().optional(),
  description: z.string().optional(),
  /** 注册时刻（epoch 毫秒）。 */
  addedAt: z.number().int(),
});
export type KnownMarketplace = z.infer<typeof knownMarketplaceSchema>;

/** 已知市场注册表文件形态（ZCode known_marketplaces.json 同构；version 为格式版本）。 */
export const marketplacesRegistryFileSchema = z.object({
  version: z.literal(1),
  marketplaces: z.array(knownMarketplaceSchema),
});
export type MarketplacesRegistryFile = z.infer<typeof marketplacesRegistryFileSchema>;

/** 安装种子（.zcode-plugin-seed.json，写入安装副本根；内容寻址校验记录）。 */
export const marketplaceSeedFileSchema = z.object({
  version: z.literal(1),
  /** 插件树内容哈希（sha256，marketplace-fs hashPluginTree 口径）。 */
  hash: z.string().min(1),
  marketplace: z.string().min(1),
  plugin: z.string().min(1),
  pluginVersion: z.string().min(1),
  /** 安装时市场源路径（诊断溯源用）。 */
  source: z.string().min(1),
});
export type MarketplaceSeedFile = z.infer<typeof marketplaceSeedFileSchema>;

/** 安装台账条目（<dataRoot>/marketplaces/installed.json installed[] 项——重启后重装配的事实源）。 */
export const marketplaceInstalledRecordSchema = z.object({
  marketplaceId: z.string().min(1),
  plugin: z.string().min(1),
  version: z.string().min(1),
  /** 安装副本绝对路径（缓存布局内）。 */
  dir: z.string().min(1),
  seedHash: z.string().min(1),
  installedAt: z.number().int(),
});
export type MarketplaceInstalledRecord = z.infer<typeof marketplaceInstalledRecordSchema>;

/** 安装台账文件形态。 */
export const marketplaceLedgerFileSchema = z.object({
  version: z.literal(1),
  installed: z.array(marketplaceInstalledRecordSchema),
});
export type MarketplaceLedgerFile = z.infer<typeof marketplaceLedgerFileSchema>;

// ---------------------------------------------------------------------------
// RPC：marketplace.add / list / install / uninstall（06 §2.10 v1.14 additive）
// ---------------------------------------------------------------------------

export const marketplaceAddParamsSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  source: marketplaceSourceSchema,
});
export type MarketplaceAddParams = z.infer<typeof marketplaceAddParamsSchema>;

export const marketplaceAddResultSchema = z.object({
  marketplace: knownMarketplaceSchema,
});
export type MarketplaceAddResult = z.infer<typeof marketplaceAddResultSchema>;

/** 市场清单摘要（marketplace.list 项；plugins 为清单条目 + 安装状态投影，逐次现读市场清单）。 */
export const marketplaceSummarySchema = z.object({
  id: z.string(),
  source: marketplaceSourceSchema,
  name: z.string().optional(),
  description: z.string().optional(),
  addedAt: z.number().int(),
  pluginCount: z.number().int().nonnegative(),
  plugins: z.array(
    z.object({
      name: z.string(),
      version: z.string(),
      description: z.string(),
      displayName: z.string().optional(),
      category: z.string().optional(),
      /** 清单内 source 子目录（原样投影）。 */
      source: z.string(),
      /** 已安装投影（安装台账匹配；null = 未安装）。 */
      installed: z
        .object({
          version: z.string(),
          dir: z.string(),
        })
        .nullable(),
    }),
  ),
  /** 市场清单现读失败时的降级诊断（plugins 为空数组；不阻塞其他市场投影）。 */
  lastError: z.string().nullable(),
});
export type MarketplaceSummary = z.infer<typeof marketplaceSummarySchema>;

export const marketplaceListParamsSchema = z.strictObject({});
export type MarketplaceListParams = z.infer<typeof marketplaceListParamsSchema>;

export const marketplaceListResultSchema = z.object({
  marketplaces: z.array(marketplaceSummarySchema),
});
export type MarketplaceListResult = z.infer<typeof marketplaceListResultSchema>;

export const marketplaceInstallParamsSchema = z.strictObject({
  marketplaceId: z.string().min(1),
  plugin: z.string().min(1),
});
export type MarketplaceInstallParams = z.infer<typeof marketplaceInstallParamsSchema>;

export const marketplaceInstallResultSchema = z.object({
  name: z.string(),
  marketplaceId: z.string(),
  version: z.string(),
  /** 安装副本绝对路径（缓存布局内）。 */
  dir: z.string(),
  /** 装配时点状态快照（active/disabled/failed）；加载失败经 plugin.status_changed 与 plugins.list 可查。 */
  status: pluginStatusSchema,
});
export type MarketplaceInstallResult = z.infer<typeof marketplaceInstallResultSchema>;

export const marketplaceUninstallParamsSchema = z.strictObject({
  marketplaceId: z.string().min(1),
  plugin: z.string().min(1),
});
export type MarketplaceUninstallParams = z.infer<typeof marketplaceUninstallParamsSchema>;

export const marketplaceUninstallResultSchema = z.object({
  removed: z.literal(true),
});
export type MarketplaceUninstallResult = z.infer<typeof marketplaceUninstallResultSchema>;
