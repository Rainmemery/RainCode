/**
 * 后台任务 registry（02-module-design §5.3 BackgroundTaskRegistry 最小实现）。
 *
 * 状态机（02 §5.2 B1–B6）：Starting → Running → Completed / Failed / Timeout / Killed。
 * 产出经环形缓冲驻留内存（磁盘不落地），可经 readOutput 读取；所有权校验本波以
 * registry 单例持有为准（跨会话 kill 校验随权限链波次补齐）。会话归档前的任务
 * 提示/移交属 server/session 生命周期波次。
 */
import { killProcessTree, type ExecRequest, type SpawnHandle } from "./local-executor.js";
import { LocalExecutor, type Executor } from "./executor.js";
import type { BackgroundTaskInfo } from "@raincode/shared";

export type KillOutcomeReason = "not_found" | "not_running" | "ownership_rejected" | "terminated";

export interface KillOutcome {
  taskId: string;
  ok: boolean;
  reason?: KillOutcomeReason;
}

export interface BackgroundTask {
  readonly info: BackgroundTaskInfo;
  /** 读取任务产出（环形缓冲内容；tail 按行取尾）。 */
  readOutput(opts?: { tail?: number }): Promise<{ output: string; truncated: boolean }>;
}

interface TaskEntry {
  info: BackgroundTaskInfo;
  handle: SpawnHandle | null;
  command: string;
}

export class BackgroundTaskRegistry {
  private readonly tasks = new Map<string, TaskEntry>();
  private nextId = 0;
  /** 执行域（M3 T3.1）：后台任务与前台 bash 同域投递；缺省 local。 */
  private readonly executor: Executor;

  constructor(options: { executor?: Executor } = {}) {
    this.executor = options.executor ?? new LocalExecutor();
  }

  /** 启动后台任务：登记 Running 后 fire-and-forget；退出时按 exitCode/超时/kill 归档状态。 */
  start(req: ExecRequest): BackgroundTask {
    this.nextId += 1;
    const taskId = `task_${String(this.nextId).padStart(6, "0")}`;
    const entry: TaskEntry = {
      info: { taskId, command: req.command, status: "Running", startedAt: Date.now(), exitCode: null },
      handle: null,
      command: req.command,
    };
    this.tasks.set(taskId, entry);

    const handle = this.executor.spawn(req);
    entry.handle = handle;
    void handle.exit.then(({ exitCode, timedOut, killed }) => {
      entry.info = {
        ...entry.info,
        status: killed ? "Killed" : timedOut ? "Timeout" : exitCode === 0 ? "Completed" : "Failed",
        exitCode,
      };
    });

    return {
      info: entry.info,
      readOutput: (opts) => this.readOutput(taskId, opts),
    };
  }

  /** 终止任务（幂等：not_found / not_running 不报错，02 §5.4）。 */
  async kill(taskId: string): Promise<KillOutcome> {
    const entry = this.tasks.get(taskId);
    if (entry === undefined) {
      return { taskId, ok: false, reason: "not_found" };
    }
    if (entry.info.status !== "Running" || entry.handle === null) {
      return { taskId, ok: false, reason: "not_running" };
    }
    const pid = entry.handle.pid;
    if (pid === null) {
      return { taskId, ok: false, reason: "not_running" };
    }
    const ok = await killProcessTree(pid);
    if (ok) {
      entry.info = { ...entry.info, status: "Killed" };
    }
    return { taskId, ok, reason: ok ? "terminated" : "not_running" };
  }

  list(filter?: { sessionId?: string }): BackgroundTaskInfo[] {
    void filter; // 会话级过滤随任务归属波次补齐（当前 registry 全局共享）
    return [...this.tasks.values()].map((entry) => entry.info);
  }

  async readOutput(
    taskId: string,
    opts?: { tail?: number },
  ): Promise<{ output: string; truncated: boolean }> {
    const entry = this.tasks.get(taskId);
    const handle = entry?.handle;
    if (handle === null || handle === undefined) {
      return { output: "", truncated: false };
    }
    const stdout = handle.stdout();
    const stderr = handle.stderr();
    const combined = stderr.length > 0 ? `${stdout}\n--- stderr ---\n${stderr}` : stdout;
    const tail = opts?.tail;
    if (tail === undefined || tail <= 0) {
      return { output: combined, truncated: handle.truncated() };
    }
    const lines = combined.split("\n");
    const kept = lines.slice(Math.max(lines.length - tail, 0));
    return { output: kept.join("\n"), truncated: lines.length > tail || handle.truncated() };
  }
}
