/**
 * 内置工具装配（02 §2.3 清单）：read / write / edit / glob / grep / bash / todo_write / todo_read +
 * P1 波次（T2.7）web_fetch / ask_user_question。
 * 全部 async、可取消、路径经 path-guard 校验（web_fetch 走 SSRF 守卫）；metadata 按 02 §2.3 逐个标注。
 */
import { ToolRegistry } from "./registry.js";
import { BackgroundTaskRegistry } from "./sandbox/background.js";
import type { Executor } from "./sandbox/executor.js";
import { TodoStore } from "./todo-store.js";
import { readTool } from "./handlers/read.js";
import { writeTool } from "./handlers/write.js";
import { editTool } from "./handlers/edit.js";
import { globTool } from "./handlers/glob.js";
import { grepTool } from "./handlers/grep.js";
import { createBashTool } from "./handlers/bash.js";
import { webFetchTool } from "./handlers/web-fetch.js";
import { askUserTool } from "./handlers/ask-user.js";
import { createTodoWriteTool, createTodoReadTool } from "./handlers/todo.js";

export interface BuiltinToolSet {
  registry: ToolRegistry;
  /** bash 后台任务 registry（tool.background.* 方法共享同一单例）。 */
  background: BackgroundTaskRegistry;
  /** 会话 todo 状态（session.snapshot.todoState 数据源预留）。 */
  todos: TodoStore;
}

export interface CreateBuiltinToolsOptions {
  /**
   * todo 持久化目录回退（缺省 null）；实际持久化目录优先取执行 ctx 的
   * `<workspaceRoot>/.raincode/todos`（见 handlers/todo.ts），此选项仅作显式覆盖。
   */
  todoStateDir?: string | null;
}

export interface CreateBuiltinToolsOptions {
  /**
   * todo 持久化目录回退（缺省 null）；实际持久化目录优先取执行 ctx 的
   * `<workspaceRoot>/.raincode/todos`（见 handlers/todo.ts），此选项仅作显式覆盖。
   */
  todoStateDir?: string | null;
  /** 沙箱执行域（M3 T3.1：server 按 config.json sandbox 解析注入；缺省 local）。 */
  executor?: Executor;
}

export function createBuiltinTools(options: CreateBuiltinToolsOptions = {}): BuiltinToolSet {
  const background = new BackgroundTaskRegistry(
    options.executor !== undefined ? { executor: options.executor } : {},
  );
  const todos = new TodoStore(options.todoStateDir ?? null);
  const registry = new ToolRegistry();
  registry.register(readTool);
  registry.register(writeTool);
  registry.register(editTool);
  registry.register(globTool);
  registry.register(grepTool);
  registry.register(createBashTool(options.executor !== undefined ? { executor: options.executor } : {}));
  registry.register(webFetchTool);
  registry.register(askUserTool);
  registry.register(createTodoWriteTool(todos));
  registry.register(createTodoReadTool(todos));
  return { registry, background, todos };
}
