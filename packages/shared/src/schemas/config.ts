import { z } from "zod";

/**
 * config 域共享结构（06-api-spec §2.3 / 04-architecture §5.2）。
 * 本波仅落地 Provider 配置 schema（四要素：baseURL / apiKeyRef / model / maxContextTokens，AC-4）；
 * config.get / config.set / providers.* 方法 schema 与 ConfigDocument 随后续波次补充。
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
