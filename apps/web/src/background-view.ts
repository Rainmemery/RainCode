/**
 * 后台任务视图纯函数（polish-ui-states-and-runtime 轮 B1；双端同构）：
 * `tool.background.list` 五态状态灯映射（dot / label / textClass）与排序（Running 优先、最近启动优先）。
 * 纯函数、无 DOM 依赖，node 单测直跑（与 desktop 同 API）。
 */
import type { BackgroundTaskInfo } from "@raincode/shared";

/** 后台任务状态（`BackgroundTaskInfo.status` 取值）。 */
export type BackgroundStatus = BackgroundTaskInfo["status"];

/** 单态呈现：状态灯类 + 中文文案 + 文字色类（仅用既有 `dot dot-*` 语义 token）。 */
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

/** 五态状态灯映射（06 §2.7 status 枚举全集）；状态不得仅用颜色表达，label 与状态灯同现。 */
export function backgroundStatusView(status: BackgroundStatus): BackgroundStatusView {
  return STATUS_VIEW[status];
}

/** 别名（与 desktop 同构镜像的兼容出口，语义同 backgroundStatusView）。 */
export const statusView = backgroundStatusView;

/** 是否运行中（轮询与「终止」按钮的判定依据）。 */
export function isRunning(status: BackgroundStatus): boolean {
  return status === "Running";
}

/** 排序：Running 置顶，同组内 `startedAt` 倒序（最近启动在前）；返回新数组，不修改入参。 */
export function sortTasks(tasks: readonly BackgroundTaskInfo[]): BackgroundTaskInfo[] {
  return [...tasks].sort((a, b) => {
    const ar = isRunning(a.status) ? 0 : 1;
    const br = isRunning(b.status) ? 0 : 1;
    if (ar !== br) return ar - br;
    return b.startedAt - a.startedAt;
  });
}
