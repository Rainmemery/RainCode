/**
 * AgentService 装配配置类型（从 agent-service.ts 拆出，单文件 ≤500 行治理）。
 * 纯类型文件：Provider / 工具 / 权限三域的装配入参；公开面经 agent-service re-export 保持不变。
 */
import type { Executor, ToolRegistry } from "@raincode/tools";
import type { PermissionPolicy, PermissionRuntimeOptions } from "./permission-runtime.js";

/** Provider 运行时配置（apiKey 已由调用方解析为明文注入；绝不落日志）。 */
export interface ProviderRuntimeConfig {
  id?: string;
  name: string;
  baseURL: string;
  model: string;
  apiKey?: string | null;
  maxContextTokens?: number;
}

/** 工具系统装配：approval 为 default-allow 策略的测试审批实现（normal 走 PermissionRuntime）。 */
export interface ToolRuntimeConfig {
  /** 仅 default-allow 策略生效（normal 策略下忽略，走真实权限链）。 */
  approval?: "always-allow" | "always-deny";
  registry?: ToolRegistry;
  /** 沙箱执行域（M3 T3.1：node.ts 按 config.json sandbox.executor 解析注入；缺省 local）。 */
  executor?: Executor;
}

/** 权限域装配（06 §2.2；策略模式：default-allow[仅开发] / normal[默认]）。 */
export interface PermissionConfig extends PermissionRuntimeOptions {
  policy: PermissionPolicy;
}
