/**
 * 子代理呈现与列表工具纯函数（refine-ui-context-panel 轮，自 session-view 拆分以满足
 * architecture 500 行治理；03 §6.1 右栏子代理 Tab + §6.1 第 4 条进度卡 + 会话时间分组）。
 * 与桌面端 subagent-view 同构镜像（同一状态形状、同一事件语义）。
 */

/** 子代理派发记录（subagent.spawned/progress/completed 全局事件归并投影）。 */
export interface SubagentRecord {
  subagentId: string;
  /** spawned 事件到达时的活跃会话（协议事件不带 sessionId 的归属口径，06 §3.2 C 组）。 */
  sessionId: string | null;
  profileName: string;
  taskPreview: string;
  status: "Pending" | "Running" | "Completed" | "Failed" | "Stopped";
  /** 最近 progress 阶段（started/tool/done/failed）。 */
  stage: string | null;
  /** 最近 progress/completed 摘要。 */
  summary: string | null;
  startedAt: number;
  completedAt: number | null;
  turnsUsed: number | null;
}

const SUBAGENT_FINAL_STATUS = ["Completed", "Failed", "Stopped"] as const;
const SUBAGENT_SPAWN_STATUS = ["Pending", "Running"] as const;

/**
 * 全局子代理事件归并（subagent.* 不带 sessionId，06 §3.2 C 组；归属=事件到达时活跃会话）。
 * spawned 按 subagentId upsert（重派发更新原行，新记录追加尾部）；progress/completed 找不到
 * 记录整体忽略；未知事件名与缺 subagentId 原样返回。
 */
export function applySubagentEvent(
  state: { activeId: string | null; subagents: SubagentRecord[] },
  name: string,
  payload: Record<string, unknown>,
): { activeId: string | null; subagents: SubagentRecord[] } {
  if (name !== "subagent.spawned" && name !== "subagent.progress" && name !== "subagent.completed") {
    return state;
  }
  const subagentId = payload["subagentId"];
  if (typeof subagentId !== "string" || subagentId.length === 0) return state;
  const idx = state.subagents.findIndex((r) => r.subagentId === subagentId);
  const ts = typeof payload["ts"] === "number" ? payload["ts"] : Date.now();

  if (name === "subagent.spawned") {
    const statusRaw = typeof payload["status"] === "string" ? payload["status"] : "";
    const status = (SUBAGENT_SPAWN_STATUS as readonly string[]).includes(statusRaw)
      ? (statusRaw as SubagentRecord["status"])
      : "Running"; // 非法回退运行态（呈现侧不因脏数据静默丢行）
    const next: SubagentRecord = {
      subagentId,
      sessionId: state.activeId,
      profileName: typeof payload["profileName"] === "string" ? payload["profileName"] : "",
      taskPreview: typeof payload["taskPreview"] === "string" ? payload["taskPreview"] : "",
      status,
      stage: null,
      summary: null,
      startedAt: ts,
      completedAt: null,
      turnsUsed: null,
    };
    if (idx >= 0) {
      const subagents = [...state.subagents];
      subagents[idx] = { ...subagents[idx]!, ...next, startedAt: subagents[idx]!.startedAt };
      return { ...state, subagents };
    }
    return { ...state, subagents: [...state.subagents, next] };
  }

  if (idx < 0) return state; // 未跟踪的子代理（如重连前派发）：整体忽略
  const existing = state.subagents[idx]!;
  const subagents = [...state.subagents];
  if (name === "subagent.progress") {
    const stage = typeof payload["stage"] === "string" ? payload["stage"] : existing.stage;
    subagents[idx] = {
      ...existing,
      ...(stage !== null && { stage }),
      ...(typeof payload["summary"] === "string" && { summary: payload["summary"] }),
    };
    return { ...state, subagents };
  }
  // subagent.completed：终态校验（∈ Completed/Failed/Stopped 才收束）
  const statusRaw = typeof payload["status"] === "string" ? payload["status"] : "";
  if (!(SUBAGENT_FINAL_STATUS as readonly string[]).includes(statusRaw)) return state;
  subagents[idx] = {
    ...existing,
    status: statusRaw as SubagentRecord["status"],
    ...(typeof payload["summary"] === "string" && { summary: payload["summary"] }),
    completedAt: ts,
    ...(typeof payload["turnsUsed"] === "number" && { turnsUsed: payload["turnsUsed"] }),
  };
  return { ...state, subagents };
}

/**
 * 会话列表时间分组（03 §6.1：今天 / 昨天 / 更早，本地时区自然日 toDateString 比较）；
 * 各组内保持入参顺序（session.list 已按 lastActiveAt 降序）。纯函数便于单测。
 */
export function groupSessions<T extends { lastActiveAt: number }>(
  rows: T[],
  now: number,
): { today: T[]; yesterday: T[]; earlier: T[] } {
  const groups: { today: T[]; yesterday: T[]; earlier: T[] } = { today: [], yesterday: [], earlier: [] };
  const nowDay = new Date(now).toDateString();
  const yesterdayDay = new Date(now - 86_400_000).toDateString();
  for (const row of rows) {
    const day = new Date(row.lastActiveAt).toDateString();
    if (day === nowDay) groups.today.push(row);
    else if (day === yesterdayDay) groups.yesterday.push(row);
    else groups.earlier.push(row);
  }
  return groups;
}

/** context 用量阈值（03 §7 状态表；§5.1 CLI「ctx N%」同构）：>95% 红、>80% 琥珀、其余默认。 */
export function ctxLevel(pct: number): "ok" | "warn" | "danger" {
  if (pct > 95) return "danger";
  if (pct > 80) return "warn";
  return "ok";
}
