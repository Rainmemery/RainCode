/**
 * LlmClient 组装（ProviderRuntimeConfig → LlmPort）。
 * 从 agent-service 拆出（单文件 ≤500 行治理，风格同 session-support）：构造与 llmFor 缓存路径共用。
 */
import { LlmClient } from "@raincode/llm";
import { RpcCallError } from "@raincode/rpc";
import type { LlmPort } from "@raincode/agent-core";

/** LlmClient 运行时入参（agent-service ProviderRuntimeConfig 的结构投影；apiKey 为明文，绝不落日志）。 */
export interface LlmClientRuntime {
  id?: string;
  name: string;
  baseURL: string;
  model: string;
  apiKey?: string | null;
  maxContextTokens?: number;
}

/** Provider 运行时配置 → LLM 客户端（maxContextTokens 缺省 32768，与既有装配口径一致）。 */
export function buildLlmClient(runtime: LlmClientRuntime): LlmPort {
  return new LlmClient({
    provider: {
      id: runtime.id,
      name: runtime.name,
      baseURL: runtime.baseURL,
      model: runtime.model,
      maxContextTokens: runtime.maxContextTokens ?? 32768,
      apiKeyRef: null,
    },
    apiKey: runtime.apiKey ?? null,
  });
}

// ---------------------------------------------------------------------------
// Provider → LLM 客户端解析（agent-service llmFor/llmForModel 下沉，≤500 治理）
// ---------------------------------------------------------------------------

/** 解析依赖注入（agent-service 内存缓存与 config 域查询的结构投影）。 */
export interface LlmProviderResolverDeps {
  /** 主 Provider id（CLI 直传 provider 场景）。 */
  primaryProviderId: string | undefined;
  /** 主客户端（未配置 Provider 时为 null）。 */
  primary: LlmPort | null;
  /** 按 providerId 的客户端缓存（懒构建）。 */
  cache: Map<string, LlmPort>;
  /** config 域 activeProviderId（AC-11 缺省绑定源）。 */
  activeProviderId: string | undefined;
  /** 按模型名反查 Provider（子代理 profile.model 匹配）。 */
  findProviderByModel: (model: string) => { id: string } | undefined;
  /** providerId → 运行时配置（未知 id → null）。 */
  providerRuntime: (id: string) => LlmClientRuntime | null;
}

/** session.create.providerId → LLM 客户端（AC-11：缺省绑定 activeProviderId，主 Provider 回退兼容）。 */
export function resolveLlmForProvider(
  deps: LlmProviderResolverDeps,
  providerId: string | undefined,
): LlmPort | null {
  const requested = providerId === undefined ? deps.activeProviderId : providerId;
  if (requested === undefined || requested === null || requested === deps.primaryProviderId) return deps.primary;
  const cached = deps.cache.get(requested);
  if (cached !== undefined) return cached;
  const runtime = deps.providerRuntime(requested);
  if (runtime === null) {
    throw new RpcCallError("CONFIG_PROVIDER_NOT_FOUND", `provider not found: ${requested}`);
  }
  const client = buildLlmClient(runtime);
  deps.cache.set(requested, client);
  return client;
}

/** 子代理 profile.model（模型名）→ LLM 客户端（02 §4.3）：缺省/同主模型 → 主客户端。 */
export function resolveLlmForModel(
  deps: LlmProviderResolverDeps,
  model: string | undefined,
  providerModel: string | undefined,
): LlmPort | null {
  if (model === undefined || model === providerModel) return deps.primary;
  const match = deps.findProviderByModel(model);
  if (match === undefined) {
    throw new RpcCallError("CONFIG_PROVIDER_NOT_FOUND", `no provider serves model: ${model}`);
  }
  return resolveLlmForProvider(deps, match.id);
}
