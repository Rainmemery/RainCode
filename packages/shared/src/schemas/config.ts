import { z } from "zod";
import { ruleBehaviorSchema } from "./common.js";

/**
 * config 域（06-api-spec §2.3 / 04-architecture §5）。
 * - Provider 四要素：baseURL / apiKeyRef / model / maxContextTokens（AC-4）；
 * - config.json 文档 schema（04 §5.2 结构示意的 P0 子集）：读路径 strip、写路径 strict（未知字段拒绝，
 *   明文 apiKey 字段因此在写 config.json 时天然被拒，04 §5.1/§5.3）；
 * - 方法 schema：config.get / config.set / config.providers.list / add / remove / switch
 *   （07 §2.1 P0 清单 + T2.6 switch 补齐，06 §2.3）。
 */

/** Provider 输入形态（04 §5.2：apiKey 只存引用 apiKeyRef，null 表示本地 Provider 无凭据）。 */
export const providerInputSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  baseURL: z.string().min(1),
  model: z.string().min(1),
  maxContextTokens: z.number().int().positive(),
  apiKeyRef: z.string().nullable().optional(),
  // AC-10 费用估算单价（USD/百万 token；optional 兼容旧 config.json——旧文档无此字段照常读写，06 §7.1）
  inputPricePerMtok: z.number().positive().optional(),
  outputPricePerMtok: z.number().positive().optional(),
});
export type ProviderInput = z.infer<typeof providerInputSchema>;

/** Provider 生效视图（06 §2.3 config.providers.list 返回项；永不含明文 key，04 §5.3）。 */
export const providerInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  baseURL: z.string(),
  model: z.string(),
  maxContextTokens: z.number(),
  apiKeyRef: z.string().nullable().optional(),
  apiKeyConfigured: z.boolean(),
  // AC-10 费用估算单价（USD/百万 token；session.usage costEstimateUsd 的取数口径）
  inputPricePerMtok: z.number().positive().optional(),
  outputPricePerMtok: z.number().positive().optional(),
});
export type ProviderInfo = z.infer<typeof providerInfoSchema>;

/**
 * providers.add 入参（06 §2.3 provider + 本波扩展：可选明文 apiKey）。
 * 明文 key 仅在服务端内存使用并写入独立本地密钥文件（04 §5.3 降级路径），config.json 只落
 * apiKeyRef 引用；响应/日志/审计永不含明文。apiKey 与 apiKeyRef 互斥。
 */
export const providerAddInputSchema = providerInputSchema.extend({
  apiKey: z.string().min(1).optional(),
});
export type ProviderAddInput = z.infer<typeof providerAddInputSchema>;

/**
 * 沙箱执行域配置（M3 T3.1/T3.2 / 02 §5.3 Executor 扩展点）。
 * executor 期望执行环境：local（缺省）/ docker（容器级 fs+网络隔离）/ wsl（Linux 环境隔离）/
 * ssh（T3.2 ES-5 远程工作区，本地审计保留）；不可用时工厂回退 local 并告警（02 §5.4），
 * kind 标记保证 UI 展示真实执行环境。
 * docker：仅挂载 workspace（fs 隔离），network 缺省 none（容器无外网）；wsl：环境隔离非安全边界；
 * ssh：命令在远端主机执行，workspaceRoot 映射远端路径（ssh.remoteWorkspaceRoot）。
 */
export const sandboxConfigSchema = z.object({
  executor: z.enum(["local", "docker", "wsl", "ssh"]),
  image: z.string().optional(),
  network: z.enum(["none", "bridge"]).optional(),
  wslDistro: z.string().optional(),
  /** ssh 执行域连接参数（executor=ssh 时必填；远端 workspace 根路径映射，审计记录仍落本地）。 */
  ssh: z
    .object({
      host: z.string().min(1),
      user: z.string().optional(),
      port: z.number().int().positive().optional(),
      identityFile: z.string().optional(),
      /** 远端 workspace 根绝对路径（POSIX；本地 workspaceRoot 与之一一映射）。 */
      remoteWorkspaceRoot: z.string().min(1),
    })
    .optional(),
});
export type SandboxConfig = z.infer<typeof sandboxConfigSchema>;

/**
 * 沙箱 enforcement 自报（T5.2）：执行域对「已放行操作」的边界强度。绝对边界（fs 独占挂载 +
 * 缺省断网）方可自报 full；应用层约束（路径守卫/审批前置）与环境隔离（WSL 发行版 fs 完整可见、
 * /mnt/* 主机盘可达）一律 partial——02 §5.1「约束非隔离」口径 + dsh 纪律「绝对边界不得当作 full」。
 */
export const sandboxEnforcementSchema = z.enum(["full", "partial"]);
export type SandboxEnforcement = z.infer<typeof sandboxEnforcementSchema>;

/** config.json 读路径文档（strip：未知字段忽略，出参宽松演进，06 §5）。 */
export const configDocumentSchema = z.object({
  configVersion: z.number().int(),
  providers: z.array(providerInputSchema).optional(),
  activeProviderId: z.string().optional(),
  permissions: z.object({ defaultBehavior: ruleBehaviorSchema.optional() }).optional(),
  compaction: z.object({ thresholdRatio: z.number(), keepRecentCount: z.number().int() }).optional(),
  sandbox: sandboxConfigSchema.optional(),
});
export type ConfigDocument = z.infer<typeof configDocumentSchema>;

/** config.json 写路径文档（strict：未知字段拒绝，04 §5.1；明文 apiKey 字段被此处拒绝）。 */
export const configDocumentStrictSchema = z
  .object({
    configVersion: z.number().int(),
    providers: z.array(providerInputSchema.strict()).optional(),
    activeProviderId: z.string().optional(),
    permissions: z.object({ defaultBehavior: ruleBehaviorSchema.optional() }).strict().optional(),
    compaction: z.object({ thresholdRatio: z.number(), keepRecentCount: z.number().int() }).strict().optional(),
    sandbox: sandboxConfigSchema.strict().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// config.get / config.set（06 §2.3：生效视图读 + 按路径定点写，写后整体 strict 校验）
// ---------------------------------------------------------------------------

export const configGetParamsSchema = z.strictObject({
  path: z.string().min(1).optional(),
});
export type ConfigGetParams = z.infer<typeof configGetParamsSchema>;

/** config 为生效视图（或 path 定位到的子树，z.unknown 兼容子树/数组形态）。 */
export const configGetResultSchema = z.object({
  config: z.unknown(),
  configVersion: z.number().int(),
});
export type ConfigGetResult = z.infer<typeof configGetResultSchema>;

export const configSetParamsSchema = z.strictObject({
  path: z.string().min(1),
  value: z.unknown(),
});
export type ConfigSetParams = z.infer<typeof configSetParamsSchema>;

export const configSetResultSchema = z.object({
  config: z.unknown(),
  configVersion: z.number().int(),
});
export type ConfigSetResult = z.infer<typeof configSetResultSchema>;

// ---------------------------------------------------------------------------
// config.providers.list / add / remove / switch（06 §2.3；switch 已实现于 T2.6——运行时切换
// 活跃 Provider，只影响后续请求的客户端绑定，已建会话的 llm 绑定与历史不动，06 §2.3）
// ---------------------------------------------------------------------------

export const configProvidersListParamsSchema = z.strictObject({});
export type ConfigProvidersListParams = z.infer<typeof configProvidersListParamsSchema>;

export const configProvidersListResultSchema = z.object({
  providers: z.array(providerInfoSchema),
  activeProviderId: z.string().optional(),
});
export type ConfigProvidersListResult = z.infer<typeof configProvidersListResultSchema>;

export const configProvidersAddParamsSchema = z.strictObject({
  provider: providerAddInputSchema,
});
export type ConfigProvidersAddParams = z.infer<typeof configProvidersAddParamsSchema>;

export const configProvidersAddResultSchema = z.object({
  provider: providerInfoSchema,
});
export type ConfigProvidersAddResult = z.infer<typeof configProvidersAddResultSchema>;

export const configProvidersRemoveParamsSchema = z.strictObject({
  id: z.string(),
});
export type ConfigProvidersRemoveParams = z.infer<typeof configProvidersRemoveParamsSchema>;

export const configProvidersRemoveResultSchema = z.object({
  removed: z.boolean(),
});
export type ConfigProvidersRemoveResult = z.infer<typeof configProvidersRemoveResultSchema>;

/** 运行时切换活跃 Provider（06 §2.3 config.providers.switch，T2.6/AC-11）。 */
export const configProvidersSwitchParamsSchema = z.strictObject({
  providerId: z.string().min(1),
});
export type ConfigProvidersSwitchParams = z.infer<typeof configProvidersSwitchParamsSchema>;

export const configProvidersSwitchResultSchema = z.object({
  activeProviderId: z.string(),
});
export type ConfigProvidersSwitchResult = z.infer<typeof configProvidersSwitchResultSchema>;
