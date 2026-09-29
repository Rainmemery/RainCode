/**
 * 内置工具装配（02 §2.3 清单 P0 子集）：read / write / edit / glob / grep / bash /
 * todo_write / todo_read（web_fetch / ask_user_question 属 P1，随后续波次）。
 * 全部 async、可取消、路径经 path-guard 校验；metadata 按 02 §2.3 逐个标注。
 */
import { ToolRegistry } from "./registry.js";
import { BackgroundTaskRegistry } from "./sandbox/background.js";
import { TodoStore } from "./todo-store.js";
import { readTool } from "./handlers/read.js";
import { writeTool } from "./handlers/write.js";
import { editTool } from "./handlers/edit.js";
import { globTool } from "./handlers/glob.js";
import { grepTool } from "./handlers/grep.js";
import { bashTool } from "./handlers/bash.js";
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

export function createBuiltinTools(options: CreateBuiltinToolsOptions = {}): BuiltinToolSet {
  const background = new BackgroundTaskRegistry();
  const todos = new TodoStore(options.todoStateDir ?? null);
  const registry = new ToolRegistry();
  registry.register(readTool);
  registry.register(writeTool);
  registry.register(editTool);
  registry.register(globTool);
  registry.register(grepTool);
  registry.register(bashTool);
  registry.register(createTodoWriteTool(todos));
  registry.register(createTodoReadTool(todos));
  return { registry, background, todos };
}
