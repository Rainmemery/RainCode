/**
 * 子代理呈现与列表工具纯函数（refine-ui-context-panel 轮，自 session-view 拆分以满足
 * architecture 500 行治理；03 §6.1 右栏子代理 Tab + §6.1 第 4 条进度卡 + 会话时间分组）。
 * 与 Web 端 apps/web/src/subagent-view.ts 同构镜像（同一状态形状、同一事件语义）。
 */

/**
 * 子代理派发记录（refine-ui-context-panel 轮；06 §3.2 C 组 subagent.* 事件投影）：
 * 供右栏子代理 Tab 与 ChatFlow 进度卡共用。sessionId 为 spawned 事件到达时的活跃会话
 * （协议事件不带 sessionId 的归属口径）；终态后 summary/turnsUsed 由 completed 收束。
 */
export interface SubagentRecord {
  subagentId: string;
  sessionId: string | null;
  profileName: string;
  taskPreview: string;
  status: "Pending" | "Running" | "Completed" | "Failed" | "Stopped";
  stage: string | null;
  summary: string | null;
  startedAt: number;
  completedAt: number | null;
  turnsUsed: number | null;
}

/** spawned 事件合法状态子集（06 §3.2：受理含排队，仅 Pending/Running）；非法回退 Running。 */
const SPAWNED_STATUS = new Set(["Pending", "Running"]);
/** completed 事件合法终态子集；其余整体忽略。 */
const COMPLETED_STATUS = new Set(["Completed", "Failed", "Stopped"]);

/**
 * 全局子代理事件归并（subagent.* 不带 sessionId，06 §3.2 C 组；归属=事件到达时活跃会话）。
 * spawned：upsert by subagentId（新记录追加尾部，同 id 更新不重复）；
 * progress：按 subagentId 找到才更新 stage/summary（字符串才写），找不到忽略；
 * completed：终态才写、summary 覆盖、completedAt/turnsUsed 收束；其他事件名或
 * subagentId 非字符串原样返回。纯函数（refine-ui-context-panel 轮）。
 */
export function applySubagentEvent(
  state: { activeId: string | null; subagents: SubagentRecord[] },
  name: string,
  payload: Record<string, unknown>,
): { activeId: string | null; subagents: SubagentRecord[] } {
  const subagentId = payload["subagentId"];
  if (typeof subagentId !== "string") return state;
  const subagents = [...state.subagents];
  const idx = subagents.findIndex((record) => record.subagentId === subagentId);
  const ts = typeof payload["ts"] === "number" ? payload["ts"] : Date.now();

  if (name === "subagent.spawned") {
    const statusRaw = typeof payload["status"] === "string" ? payload["status"] : "";
    const status = SPAWNED_STATUS.has(statusRaw) ? (statusRaw as SubagentRecord["status"]) : "Running";
    const fields = {
      sessionId: state.activeId,
      profileName: typeof payload["profileName"] === "string" ? payload["profileName"] : "",
      taskPreview: typeof payload["taskPreview"] === "string" ? payload["taskPreview"] : "",
      status,
      startedAt: ts,
    };
    if (idx >= 0) {
      // 同 id 重复 spawned（重连补推）：原位更新，不重复追加
      subagents[idx] = { ...subagents[idx]!, ...fields };
    } else {
      subagents.push({
        subagentId,
        ...fields,
        stage: null,
        summary: null,
        completedAt: null,
        turnsUsed: null,
      });
    }
    return { activeId: state.activeId, subagents };
  }

  if (name === "subagent.progress") {
    if (idx < 0) return state;
    const row = subagents[idx]!;
    subagents[idx] = {
      ...row,
      ...(typeof payload["stage"] === "string" && { stage: payload["stage"] }),
      ...(typeof payload["summary"] === "string" && { summary: payload["summary"] }),
    };
    return { activeId: state.activeId, subagents };
  }

  if (name === "subagent.completed") {
    if (idx < 0) return state;
    const statusRaw = typeof payload["status"] === "string" ? payload["status"] : "";
    if (!COMPLETED_STATUS.has(statusRaw)) return state;
    const row = subagents[idx]!;
    subagents[idx] = {
      ...row,
      status: statusRaw as SubagentRecord["status"],
      ...(typeof payload["summary"] === "string" && { summary: payload["summary"] }),
      completedAt: ts,
      ...(typeof payload["turnsUsed"] === "number" && { turnsUsed: payload["turnsUsed"] }),
    };
    return { activeId: state.activeId, subagents };
  }

  return state;
}

/**
 * 会话列表时间分组（refine-ui-context-panel 轮 §6.1：今天 / 昨天 / 更早三组标题）。
 * 本地时区自然日（toDateString 比较）；组内保持入参顺序（服务端 lastActiveAt 降序）。纯函数。
 */
export function groupSessions<T extends { lastActiveAt: number }>(
  rows: T[],
  now: number,
): { today: T[]; yesterday: T[]; earlier: T[] } {
  const todayKey = new Date(now).toDateString();
  const yesterdayKey = new Date(now - 86_400_000).toDateString();
  const today: T[] = [];
  const yesterday: T[] = [];
  const earlier: T[] = [];
  for (const row of rows) {
    const dayKey = new Date(row.lastActiveAt).toDateString();
    if (dayKey === todayKey) today.push(row);
    else if (dayKey === yesterdayKey) yesterday.push(row);
    else earlier.push(row);
  }
  return { today, yesterday, earlier };
}

/** context 用量阈值分档（03 §7 状态表 / §5.1 CLI「ctx N%」同构）：>95 红、>80 琥珀、否则默认。 */
export function ctxLevel(pct: number): "ok" | "warn" | "danger" {
  if (pct > 95) return "danger";
  if (pct > 80) return "warn";
  return "ok";
}
