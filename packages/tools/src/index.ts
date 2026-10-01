/**
 * @raincode/tools —— 工具调用系统（04-architecture §2.1）。
 *
 * 本包唯一 publicEntrypoint（architecture/policy.yaml）；依赖方向 tools→shared。
 * 职责（02-module-design §2 / §5）：工具契约与注册表、执行器、内置工具集、进程级沙箱。
 * 不做权限判定（消费 agent-core/permission 注入的三态结果）、不驱动调用循环（Agent Core 职责）。
 */

// 契约与注册表
export type {
  Tool,
  ToolCallRequest,
  ToolDescriptor,
  ToolExecutionContext,
  ToolMetadata,
  ToolOutput,
  ToolProgressEvent,
  ToolResult,
  ToolSource,
} from "./tool.js";
export { ToolRegistry } from "./registry.js";
export { ToolExecutor, ToolExecutionError } from "./executor.js";
export type { ToolExecutorOptions, ToolRunContext } from "./executor.js";

// 内置工具与装配
export { createBuiltinTools } from "./builtins.js";
export type { BuiltinToolSet, CreateBuiltinToolsOptions } from "./builtins.js";
export { readTool } from "./handlers/read.js";
export { writeTool } from "./handlers/write.js";
export { editTool } from "./handlers/edit.js";
export { globTool } from "./handlers/glob.js";
export { grepTool } from "./handlers/grep.js";
export { createBashTool, bashTool } from "./handlers/bash.js";
export { webFetchTool, htmlToText } from "./handlers/web-fetch.js";
export { askUserTool } from "./handlers/ask-user.js";
export { createTodoReadTool, createTodoWriteTool } from "./handlers/todo.js";
export { TodoStore } from "./todo-store.js";

// SSRF 守卫（02 §2.4；web_fetch 强制底线，单测断言用）
export { assertPublicHttpUrl } from "./ssrf.js";
export type { SsrfLookupDeps } from "./ssrf.js";
export type { AskUserAnswer, AskUserRequest } from "./tool.js";

// 沙箱（02 §5）
export { execLocal, killProcessTree, resolveShell, spawnLocal } from "./sandbox/local-executor.js";
export type {
  ExecRequest,
  ExecResult,
  ResolvedShell,
  ShellKind,
  SpawnHandle,
} from "./sandbox/local-executor.js";
export { BackgroundTaskRegistry } from "./sandbox/background.js";
export type { BackgroundTask, KillOutcome, KillOutcomeReason } from "./sandbox/background.js";
export { DockerExecutor, LocalExecutor, WslExecutor, resolveSandboxExecutor } from "./sandbox/executor.js";
export type {
  Executor,
  ExecutorKind,
  ExecutorTransport,
  ResolvedSandboxExecutor,
  SandboxProbes,
} from "./sandbox/executor.js";

// 路径守卫与投影工具
export { guardPath, normalizeForGuard } from "./path-guard.js";
export type { PathGuardVerdict, PathPolicyHook } from "./path-guard.js";
export { zodToJsonSchema } from "./json-schema.js";
export { OutputRingBuffer, truncateToByteBudget } from "./truncate.js";
