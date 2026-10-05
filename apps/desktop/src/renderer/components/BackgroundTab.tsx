/**
 * 上下文面板 · 后台任务 Tab（polish-ui-states-and-runtime Task 4.2；03-ui-design §6.1 第 4 Tab，
 * cyan 工具调用模块色）：`tool.background.list` 行（状态灯五态 / 等宽 command / startedAt / exitCode）
 * + Running 行「终止」（`tool.background.kill`）+ 行展开 `tool.background.output { taskId, tail: 200 }`
 * （truncated 提示）+ 「刷新」+ 首载 `.skeleton` + 空态一行。
 * 数据口径注记：后台任务 registry 全局共享（06 §2.7 / server 源码注记），本面板展示**全部**后台任务，
 * 不做按会话过滤的假 UI（`sessionId` 入参刻意不传）。
 * 轮询生命周期：仅当存在 Running 任务 **且** 本 Tab 已挂载（激活）**且** 面板未折叠时，2s 轮询；
 * 任一条件不成立即清空 interval，无泄漏定时器（ContextPanel 激活时条件渲染本组件，折叠时整面板卸载）。
 */
import { memo, useCallback, useEffect, useState } from "react";
import type { BackgroundTaskInfo } from "@raincode/shared";
import { isRunning, sortTasks, backgroundStatusView } from "../background-view.js";
import { rpcCall, useDesktop } from "../store.js";

const POLL_MS = 2000;
const OUTPUT_TAIL = 200;

interface OutputResult {
  output: string;
  truncated: boolean;
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

/** 后台任务行（memo）：状态灯 + 等宽 command 截断 + 状态文案 + startedAt + exitCode；Running 行带「终止」。 */
const TaskRow = memo(function TaskRow({
  task,
  onKill,
}: {
  task: BackgroundTaskInfo;
  onKill: (taskId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [output, setOutput] = useState<OutputResult | null>(null);
  const view = backgroundStatusView(task.status);

  // 展开时拉取产出 tail（tool.background.output）；失败回落空产出，不阻塞行交互
  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    setOutput(null);
    void rpcCall<OutputResult>("tool.background.output", { taskId: task.taskId, tail: OUTPUT_TAIL })
      .then((result) => {
        if (!cancelled) setOutput(result);
      })
      .catch(() => {
        if (!cancelled) setOutput({ output: "", truncated: false });
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, task.taskId]);

  return (
    <div className="border-b border-border-faint last:border-b-0">
      <div className="flex h-8 items-center gap-2 px-1">
        <span className={view.dot} title={view.label} />
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          title={expanded ? "收起产出" : "展开产出"}
        >
          <span className="mono min-w-0 flex-1 truncate text-2xs text-hi" title={task.command}>
            {task.command}
          </span>
          <span className={`shrink-0 text-2xs ${view.textClass}`}>{view.label}</span>
          <span className="shrink-0 text-2xs text-faint">{relativeTime(task.startedAt)}</span>
          <span className="shrink-0 text-2xs text-faint">
            {typeof task.exitCode === "number" ? `exit ${String(task.exitCode)}` : "—"}
          </span>
          <span className={`shrink-0 text-2xs text-faint transition-transform duration-med ${expanded ? "rotate-90" : ""}`}>
            ▸
          </span>
        </button>
        {isRunning(task.status) && (
          <button
            type="button"
            onClick={() => onKill(task.taskId)}
            className="h-6 shrink-0 rounded border border-danger px-2 text-2xs text-danger transition-colors duration-fast hover:bg-hover"
            title="经 tool.background.kill 终止该任务"
          >
            终止
          </button>
        )}
      </div>
      {expanded && (
        <div className="px-1 pb-2">
          {output === null ? (
            <div className="skeleton h-10 w-full" />
          ) : (
            <>
              {output.truncated && (
                <div className="mb-1 text-2xs text-warn">产出已截断（仅显示最后 {OUTPUT_TAIL} 行）</div>
              )}
              <pre className="mono max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-md bg-raised px-2 py-1.5 text-2xs leading-relaxed text-mid">
                {output.output === "" ? "（暂无产出）" : output.output}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
});

/** 后台任务 Tab：全量任务列表 + 刷新 + Running 存在且可见时 2s 轮询。 */
export function BackgroundTab() {
  const collapsed = useDesktop((s) => s.contextPanelCollapsed);
  const [tasks, setTasks] = useState<BackgroundTaskInfo[] | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      // 口径：registry 全局共享，不传 sessionId（06 §2.7；避免按会话过滤的假 UI）
      const result = await rpcCall<{ tasks: BackgroundTaskInfo[] }>("tool.background.list", {});
      setTasks(result.tasks);
    } catch {
      // 静默：面板为附加信息，失败回落空态（避免骨架常驻）
      setTasks((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const hasRunning = tasks !== null && tasks.some((task) => isRunning(task.status));
  // 轮询条件：存在 Running 任务 + 本 Tab 已挂载（激活）+ 面板未折叠；否则清空 interval
  useEffect(() => {
    if (collapsed || !hasRunning) return;
    const timer = setInterval(() => {
      void refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [collapsed, hasRunning, refresh]);

  /** 终止任务（useCallback 稳定引用，保住 TaskRow 的 memo）：受理后刷新；失败静默由轮询收敛。 */
  const onKill = useCallback(
    (taskId: string): void => {
      setBusy(true);
      void rpcCall("tool.background.kill", { taskId })
        .then(() => refresh())
        .catch(() => undefined)
        .finally(() => setBusy(false));
    },
    [refresh],
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-2xs text-faint">后台任务 registry 全局共享 · 列出全部任务（06 §2.7）</span>
        <button
          type="button"
          disabled={busy}
          onClick={() => void refresh()}
          className="ml-auto h-6 shrink-0 rounded border border-border-strong px-2 text-2xs text-mid transition-colors duration-fast hover:bg-hover disabled:opacity-50"
        >
          刷新
        </button>
      </div>
      {tasks === null ? (
        <div className="flex flex-col gap-1.5">
          {[0, 1, 2].map((row) => (
            <div key={row} className="skeleton h-7 w-full" />
          ))}
        </div>
      ) : tasks.length === 0 ? (
        <div className="text-2xs text-faint">暂无后台任务（bash 工具 runInBackground 启动的进程在此呈现）</div>
      ) : (
        <div>
          {sortTasks(tasks).map((task) => (
            <TaskRow key={task.taskId} task={task} onKill={onKill} />
          ))}
        </div>
      )}
    </div>
  );
}
