/**
 * TodoStore：会话内 todo 状态存取（02 §2.3 注：todo 状态存于会话内存并随事件落盘）。
 *
 * 实现选型（任务约定二选一）：**内存 Map + 持久化到会话目录 todo.json**——
 * 每个会话键一个文件 `<stateDir>/<sessionKey>.json`（stateDir 由装配方注入，
 * 缺省 `<workspaceRoot>/.raincode/todos/`），原子写（tmp + rename）；
 * 不走 packages/storage（避免工具包反向依赖存储实现，保持 tools→shared 单向依赖）。
 * stateDir 为 null 时退化为纯内存（测试用）。
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TodoItem } from "@raincode/shared";

export class TodoStore {
  private readonly state = new Map<string, TodoItem[]>();

  constructor(private readonly stateDir: string | null) {}

  async get(sessionKey: string, opts?: { stateDir?: string }): Promise<TodoItem[]> {
    const dir = opts?.stateDir ?? this.stateDir;
    const cached = this.state.get(sessionKey);
    if (cached !== undefined) {
      return cached;
    }
    if (dir === null) {
      return [];
    }
    try {
      const raw = await readFile(this.filePath(dir, sessionKey), "utf8");
      const parsed: unknown = JSON.parse(raw);
      const items = Array.isArray(parsed) ? (parsed as TodoItem[]) : [];
      this.state.set(sessionKey, items);
      return items;
    } catch {
      return [];
    }
  }

  async set(
    sessionKey: string,
    todos: TodoItem[],
    opts?: { stateDir?: string },
  ): Promise<void> {
    const dir = opts?.stateDir ?? this.stateDir;
    this.state.set(sessionKey, todos);
    if (dir === null) {
      return;
    }
    const target = this.filePath(dir, sessionKey);
    try {
      await mkdir(dirname(target), { recursive: true });
      const tmp = `${target}.tmp-${String(Date.now())}`;
      await writeFile(tmp, JSON.stringify(todos, null, 2), "utf8");
      await rename(tmp, target);
    } catch {
      // 持久化失败不阻断会话内存态（下次写入重试）
    }
  }

  private filePath(dir: string, sessionKey: string): string {
    // sessionKey 为受限字符集（sessionId 形如 session_<ulid>）；防路径拼接歧义
    const safe = sessionKey.replace(/[^A-Za-z0-9_-]/g, "_");
    return join(dir, `${safe}.json`);
  }
}
