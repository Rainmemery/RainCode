/**
 * LlmClient 组装（ProviderRuntimeConfig → LlmPort）。
 * 从 agent-service 拆出（单文件 ≤500 行治理，风格同 session-support）：构造与 llmFor 缓存路径共用。
 */
import { LlmClient } from "@raincode/llm";
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
