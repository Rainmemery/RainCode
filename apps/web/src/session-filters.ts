/**
 * 会话列表过滤纯函数（ui-panel-deepening 轮）：归档态与子会话的显隐口径。
 * 与桌面端同构镜像（同一状态形状、同一判定语义）：子会话 = title 以 [subagent: 前缀开头的
 * 派生会话；归档态 = session.list 行 state === "Archived"。纯函数，node 单测直跑。
 */

/** 子会话标题前缀（subagent 派发会话命名约定，与桌面端同口径）。 */
const SUBSESSION_PREFIX = "[subagent:";

/** 子会话判定：title 以 [subagent: 开头即视为子代理派生会话。 */
export function isSubsessionSession(title: string): boolean {
  return title.startsWith(SUBSESSION_PREFIX);
}

export interface SessionFilterOptions {
  showArchived: boolean;
  showSubsessions: boolean;
}

/**
 * 会话列表过滤（默认隐藏归档态与子会话，开关放行）：
 * - state === "Archived" 且未开启 showArchived → 滤除（state 缺省按 Active 处理）；
 * - isSubsessionSession(title) 且未开启 showSubsessions → 滤除。
 * 纯函数，入参顺序保持（session.list 已按 lastActiveAt 降序，分组渲染依赖该顺序）。
 */
export function filterSessionRows<T extends { title: string; state?: string }>(
  rows: T[],
  opts: SessionFilterOptions,
): T[] {
  return rows.filter((row) => {
    if (!opts.showArchived && row.state === "Archived") return false;
    if (!opts.showSubsessions && isSubsessionSession(row.title)) return false;
    return true;
  });
}
