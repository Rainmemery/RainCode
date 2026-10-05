/**
 * 后台任务视图纯函数（polish-ui-states-and-runtime Task 4.1；03-ui-design §6.1 右栏第 4 Tab）：
 * 五态状态灯映射（Running 青脉冲 / Completed 绿 / Failed 红 / Timeout 琥珀 / Killed 灰）、
 * isRunning 判定与列表排序（Running 置顶，其余按 startedAt 倒序）。纯函数（不依赖 DOM / React），
 * 与 Web 端 background-view 同构镜像（同 API / 同语义）。
 */
import type { BackgroundTaskInfo } from "@raincode/shared";

export type BackgroundStatus = BackgroundTaskInfo["status"];

/** 单态呈现：状态灯类 + 中文文案 + 文字色类（全部为既有语义 token 类）。 */
export interface BackgroundStatusView {
  dot: string;
  label: string;
  textClass: string;
}

const STATUS_VIEW: Record<BackgroundStatus, BackgroundStatusView> = {
  Running: { dot: "dot dot-run", label: "运行中", textClass: "text-cyan" },
  Completed: { dot: "dot dot-ok", label: "已完成", textClass: "text-ok" },
  Failed: { dot: "dot dot-err", label: "失败", textClass: "text-danger" },
  Timeout: { dot: "dot dot-warn", label: "超时", textClass: "text-warn" },
  Killed: { dot: "dot dot-idle", label: "已终止", textClass: "text-faint" },
};

/** 五态状态灯映射（06 §2.7 status 枚举全集）。 */
export function backgroundStatusView(status: BackgroundStatus): BackgroundStatusView {
  return STATUS_VIEW[status];
}

/** 别名（与 Web 端命名对齐的兼容出口，语义同 backgroundStatusView）。 */
export const statusView = backgroundStatusView;

/** 是否运行中（轮询与「终止」按钮的判定依据）。 */
export function isRunning(status: BackgroundStatus): boolean {
  return status === "Running";
}

/** 排序：Running 置顶，同组内 startedAt 倒序（最近启动在前）；返回新数组，不修改入参。 */
export function sortTasks(tasks: readonly BackgroundTaskInfo[]): BackgroundTaskInfo[] {
  return [...tasks].sort((a, b) => {
    const aRank = isRunning(a.status) ? 0 : 1;
    const bRank = isRunning(b.status) ? 0 : 1;
    if (aRank !== bRank) return aRank - bRank;
    return b.startedAt - a.startedAt;
  });
}
