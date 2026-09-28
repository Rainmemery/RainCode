/**
 * @novacode/server —— Agent Service 唯一组装点（04-architecture §2.1 / ADR-06）。
 *
 * 本包唯一 publicEntrypoint（architecture/policy.yaml）。
 * 职责：装配 agent-core + llm + storage 为 Agent Service、方法表（06 §2）、会话事件流出口；
 * 只做组装与协议暴露，不实现领域逻辑；transport 由端层注入（不选择传输载体）。
 */

export { AgentService } from "./agent-service.js";
export type {
  AgentServiceOptions,
  PermissionConfig,
  ProviderRuntimeConfig,
  ToolRuntimeConfig,
} from "./agent-service.js";

export { PermissionRuntime } from "./permission-runtime.js";
export type {
  PermissionPolicy,
  PermissionRuntimeOptions,
} from "./permission-runtime.js";

export { createAgentServiceNode } from "./node.js";
export type { AgentServiceNode, AgentServiceNodeOptions } from "./node.js";

export { resolveProviderConfig, DEFAULT_MAX_CONTEXT_TOKENS } from "./provider-config.js";
export type {
  ProviderCliArgs,
  ResolvedProviderConfig,
  ResolveProviderOptions,
} from "./provider-config.js";
