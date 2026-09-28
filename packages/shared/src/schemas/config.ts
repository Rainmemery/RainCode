import { z } from "zod";
import { ruleBehaviorSchema } from "./common.js";

/**
 * config 域（06-api-spec §2.3 / 04-architecture §5）。
 * - Provider 四要素：baseURL / apiKeyRef / model / maxContextTokens（AC-4）；
 * - config.json 文档 schema（04 §5.2 结构示意的 P0 子集）：读路径 strip、写路径 strict（未知字段拒绝，
 *   明文 apiKey 字段因此在写 config.json 时天然被拒，04 §5.1/§5.3）；
 * - 方法 schema：config.get / config.set / config.providers.list / add / remove（07 §2.1 P0 清单）。
 */

/** Provider 输入形态（04 §5.2：apiKey 只存引用 apiKeyRef，null 表示本地 Provider 无凭据）。 */
export const providerInputSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  baseURL: z.string().min(1),
  model: z.string().min(1),
  maxContextTokens: z.number().int().positive(),
  apiKeyRef: z.string().nullable().optional(),
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

/** config.json 读路径文档（strip：未知字段忽略，出参宽松演进，06 §5）。 */
export const configDocumentSchema = z.object({
  configVersion: z.number().int(),
  providers: z.array(providerInputSchema).optional(),
  activeProviderId: z.string().optional(),
  permissions: z.object({ defaultBehavior: ruleBehaviorSchema.optional() }).optional(),
  compaction: z.object({ thresholdRatio: z.number(), keepRecentCount: z.number().int() }).optional(),
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
// config.providers.list / add / remove（06 §2.3；switch 属 P1 不在本波）
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
