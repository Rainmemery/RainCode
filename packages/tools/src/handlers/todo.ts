/**
 * todo_write / todo_read 工具（02 §2.3 清单）：会话任务清单的覆盖式更新与读取。
 * 状态存内存并持久化到 <workspaceRoot>/.raincode/todos/<sessionKey>.json
 * （选型「内存 + 会话目录 todo.json」；ctx.workspaceRoot 由执行 ctx 提供，见 todo-store.ts）。
 * 元数据：write → scope=workspace / low risk / needsApproval=false（会话内低风险清单）。
 */
import { join } from "node:path";
import { z } from "zod";
import type { Tool, ToolOutput, ToolExecutionContext } from "../tool.js";
import type { TodoStore } from "../todo-store.js";

const todoItemSchema = z.object({
  content: z.string().min(1),
  status: z.enum(["pending", "in_progress", "completed"]),
  activeForm: z.string().optional(),
});

/** 会话 todo.json 目录（workspace 级，随 sessionKey 分文件）。 */
function todoDir(ctx: ToolExecutionContext): { stateDir: string } {
  return { stateDir: join(ctx.workspaceRoot, ".raincode", "todos") };
}

export function createTodoWriteTool(store: TodoStore): Tool<{ todos: Array<z.infer<typeof todoItemSchema>> }> {
  return {
    name: "todo_write",
    description:
      "Replace the session task list (todo) with the given items. Pass the full list every time; " +
      "each item has content and a status (pending / in_progress / completed).",
    parametersSchema: z.object({
      todos: z.array(todoItemSchema).max(50).describe("Complete replacement task list"),
    }),
    metadata: {
      readOnly: false,
      destructive: false,
      sideEffectScope: "workspace",
      riskLevel: "low",
      needsApproval: false,
    },
    async execute(
      input: { todos: Array<{ content: string; status: "pending" | "in_progress" | "completed"; activeForm?: string }> },
      ctx: ToolExecutionContext,
    ): Promise<ToolOutput<{ count: number }>> {
      await store.set(ctx.sessionKey, input.todos, todoDir(ctx));
      return {
        data: { count: input.todos.length },
        content: `todo list updated: ${String(input.todos.length)} item(s)`,
      };
    },
  };
}

export function createTodoReadTool(store: TodoStore): Tool<Record<string, never>> {
  return {
    name: "todo_read",
    description: "Read the current session task list (todo items with statuses).",
    parametersSchema: z.object({}),
    metadata: {
      readOnly: true,
      destructive: false,
      sideEffectScope: "none",
      riskLevel: "low",
      needsApproval: false,
    },
    async execute(
      _input: Record<string, never>,
      ctx: ToolExecutionContext,
    ): Promise<ToolOutput<{ items: Awaited<ReturnType<TodoStore["get"]>> }>> {
      const items = await store.get(ctx.sessionKey, todoDir(ctx));
      if (items.length === 0) {
        return { data: { items }, content: "(empty todo list)" };
      }
      const lines = items.map((item, index) => {
        const marker = item.status === "completed" ? "[x]" : item.status === "in_progress" ? "[~]" : "[ ]";
        const label = item.activeForm ?? item.content;
        return `${String(index + 1)}. ${marker} ${label}`;
      });
      return { data: { items }, content: lines.join("\n") };
    },
  };
}
