/**
 * 会话列表过滤纯函数（UI 管理面板深化轮）：子会话识别 + 归档/子会话双开关过滤。
 * 与 Web 端同构镜像（同一状态形状、同一过滤语义）；Sidebar 渲染链 =
 * 检索行（服务端 keyword）→ filterSessionRows → groupSessions 分组。纯函数便于单测驱动。
 */

/** 子会话识别：subagent 派生的会话标题统一带 [subagent:...] 前缀。 */
export function isSubsessionSession(title: string): boolean {
  return title.startsWith("[subagent:");
}

/**
 * 会话行过滤：归档行（state === "Archived"）仅 showArchived 开启时出现；
 * 子会话仅 showSubsessions 开启时出现。state 缺省（旧服务端无该字段）按未归档处理不丢行。
 */
export function filterSessionRows<T extends { title: string; state?: string }>(
  rows: T[],
  opts: { showArchived: boolean; showSubsessions: boolean },
): T[] {
  return rows.filter((row) => {
    if (!opts.showArchived && row.state === "Archived") return false;
    if (!opts.showSubsessions && isSubsessionSession(row.title)) return false;
    return true;
  });
}
