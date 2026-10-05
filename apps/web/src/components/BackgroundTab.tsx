/**
 * 右栏上下文面板 · 后台任务 Tab（polish-ui-states-and-runtime 轮 B1；03 §6.1 第 4 Tab，cyan 工具调用模块色；双端同构）：
 * `tool.background.list / kill / output` 三方法投影——状态灯五态 + 等宽 command + 相对时间 + exitCode；
 * Running 行「终止」（kill）；行展开产出 tail（truncated 提示）；存在 Running 时 2s 轮询 + 「刷新」。
 * 口径注记：registry 全局共享（06 §2.7），此处列出全部后台任务，不做按会话过滤的假 UI。
 * 本组件仅在 Tab 激活且面板未折叠时挂载（折叠由 ContextRail 替换 → 卸载即清定时器，无泄漏）。
 */
import { useCallback, useEffect, useState } from "react";
import { RpcCallError } from "@raincode/rpc/web";
import type {
  BackgroundTaskInfo,
  ToolBackgroundKillResult,
  ToolBackgroundListResult,
  ToolBackgroundOutputResult,
} from "@raincode/shared";
import { backgroundStatusView, isRunning, sortTasks } from "../background-view.js";
import { rpcCall } from "../state.js";
import { relativeTime } from "./SessionRow.js";
import { StatusBanner } from "./StatusBanner.js";

/** 运行中任务存在且本 Tab 可见时的轮询周期（B1）。 */
const POLL_INTERVAL_MS = 2000;
/** 行展开读取产出的 tail 行数（06 §2.7 tool.background.output）。 */
const OUTPUT_TAIL_LINES = 200;

const ROW_BUTTON_CLASS =
  "h-5 shrink-0 rounded-sm border border-border-strong px-1.5 text-2xs text-mid transition-colors duration-fast hover:bg-hover disabled:opacity-50";

interface OutputState {
  output: string;
  truncated: boolean;
}

function errText(err: unknown): string {
  return err instanceof RpcCallError ? `${err.code}: ${err.message}` : String(err);
}

export function BackgroundTab(): JSX.Element {
  const [tasks, setTasks] = useState<BackgroundTaskInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [outputs, setOutputs] = useState<Record<string, OutputState>>({});
  const [outputLoadingId, setOutputLoadingId] = useState<string | null>(null);
  const [busyKillId, setBusyKillId] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      // 不传 sessionId：registry 全局共享，展示全量（06 §2.7 口径注记，禁做按会话过滤的假 UI）
      const result = await rpcCall<ToolBackgroundListResult>("tool.background.list", {});
      setTasks(sortTasks(result.tasks));
      setError(null);
    } catch (err) {
      setError(errText(err));
      setTasks((prev) => prev ?? []); // 首拉失败：结束骨架态，落一行错误（不吞）
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 条件轮询：仅当存在 Running 任务时置定时器（本组件挂载即 Tab 激活且面板未折叠），否则清空
  const hasRunning = tasks?.some((task) => isRunning(task.status)) ?? false;
  useEffect(() => {
    if (!hasRunning) return;
    const timer = window.setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [hasRunning, refresh]);

  /** 行点击：展开/收起产出，首次展开经 tool.background.output 拉取 tail。 */
  function toggleOutput(task: BackgroundTaskInfo): void {
    if (expandedId === task.taskId) {
      setExpandedId(null);
      return;
    }
    setExpandedId(task.taskId);
    if (outputs[task.taskId] !== undefined || outputLoadingId === task.taskId) return;
    setOutputLoadingId(task.taskId);
    void rpcCall<ToolBackgroundOutputResult>("tool.background.output", { taskId: task.taskId, tail: OUTPUT_TAIL_LINES })
      .then((result) =>
        setOutputs((prev) => ({ ...prev, [task.taskId]: { output: result.output, truncated: result.truncated } })),
      )
      .catch(() => setOutputs((prev) => ({ ...prev, [task.taskId]: { output: "", truncated: false } })))
      .finally(() => setOutputLoadingId((cur) => (cur === task.taskId ? null : cur)));
  }

  async function kill(taskId: string): Promise<void> {
    setBusyKillId(taskId);
    try {
      await rpcCall<ToolBackgroundKillResult>("tool.background.kill", { taskId });
      await refresh();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusyKillId(null);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <button type="button" className={ROW_BUTTON_CLASS} onClick={() => void refresh()} title="重新拉取后台任务列表">
          刷新
        </button>
        <span className="min-w-0 flex-1" />
        {tasks !== null && <span className="shrink-0 text-2xs text-faint">{tasks.length} 项</span>}
      </div>
      {/* 数据口径注记（06 §2.7：registry 全局共享，非会话级） */}
      <p className="text-2xs text-faint">registry 全局共享：列出全部后台任务（不按会话过滤）。</p>
      {error !== null && <StatusBanner tone="danger" text={error} onDismiss={() => setError(null)} />}
      {tasks === null ? (
        <div className="flex flex-col gap-1.5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton h-8 rounded-md" />
          ))}
        </div>
      ) : tasks.length === 0 ? (
        <div className="px-1 py-1 text-2xs text-faint">暂无后台任务（会话中以 runInBackground 发起的命令在此呈现）</div>
      ) : (
        <div className="flex flex-col gap-1">
          {tasks.map((task) => {
            const meta = backgroundStatusView(task.status);
            const expanded = expandedId === task.taskId;
            const output = outputs[task.taskId];
            const hasExitCode = task.exitCode !== undefined && task.exitCode !== null;
            return (
              <div key={task.taskId} className="rounded-md border border-border-faint bg-card">
                <div className="flex items-center gap-2 px-2 py-1.5">
                  <button
                    type="button"
                    data-row-activate
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    onClick={() => toggleOutput(task)}
                    title={hasExitCode ? `${task.command} · exit ${String(task.exitCode)}` : task.command}
                  >
                    <span className={meta.dot} title={meta.label} />
                    <span className="mono min-w-0 flex-1 truncate text-2xs text-hi">{task.command}</span>
                    <span className={`shrink-0 text-2xs ${meta.textClass}`}>{meta.label}</span>
                    <span className="shrink-0 text-2xs text-faint">{relativeTime(task.startedAt)}</span>
                    {hasExitCode && <span className="shrink-0 text-2xs text-faint">exit {String(task.exitCode)}</span>}
                    <span
                      className={`shrink-0 text-2xs text-faint transition-transform duration-med ${expanded ? "rotate-90" : ""}`}
                    >
                      ▸
                    </span>
                  </button>
                  {isRunning(task.status) && (
                    <button
                      type="button"
                      className={ROW_BUTTON_CLASS}
                      disabled={busyKillId === task.taskId}
                      onClick={() => void kill(task.taskId)}
                      title="终止后台任务（tool.background.kill）"
                    >
                      终止
                    </button>
                  )}
                </div>
                {expanded && (
                  <div className="border-t border-border-faint px-2 py-1.5">
                    {outputLoadingId === task.taskId && output === undefined ? (
                      <div className="skeleton h-6 rounded-md" />
                    ) : output !== undefined && output.output.length > 0 ? (
                      <>
                        <pre className="mono max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-raised px-2 py-1.5 text-2xs leading-relaxed text-mid">
                          {output.output}
                        </pre>
                        {output.truncated && <div className="mt-1 text-2xs text-warn">输出已截断（仅显示末尾 tail）</div>}
                      </>
                    ) : (
                      <div className="text-2xs text-faint">暂无产出</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
