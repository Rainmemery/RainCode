/**
 * 会话域支撑函数（从 agent-service 拆出，单文件 ≤500 行治理）：
 * SessionTurnLoop 构造（create/resume 共用）、session.snapshot 投影、session.list 查询、
 * usage 回写与 rpc seq 续起点。全部为无状态纯函数，依赖经参数注入（04 §2.4 铁律 4）。
 */
import { RpcCallError } from "@novacode/rpc";
import type {
  CollaborationMode,
  MessageRecord,
  SessionListParams,
  SessionListResult,
  SessionSnapshotPayload,
  SessionSummary,
} from "@novacode/shared";
import type { BackgroundTaskRegistry } from "@novacode/tools";
import type { SessionResume, Storage } from "@novacode/storage";
import { computeWorkspaceHash } from "@novacode/storage";
import { SessionTurnLoop } from "@novacode/agent-core";
import type { LlmPort, SessionEventPublisher, ToolPhaseDeps } from "@novacode/agent-core";

/** SessionTurnLoop 构造依赖（agent-service 组装后注入；create/resume 两个入口共用）。 */
export interface SessionLoopDeps {
  sessionId: string;
  mode: CollaborationMode;
  /** null = 未配置 Provider（turn 以 LLM_NOT_CONFIGURED 失败收束）。 */
  llm: LlmPort | null;
  storage: Storage;
  publish: SessionEventPublisher;
  systemPrompt?: string;
  tools: ToolPhaseDeps & { background: BackgroundTaskRegistry };
  workspaceRoot: string;
  workspaceId: string;
  initialHistory?: MessageRecord[];
  initialEventSeq?: number;
}

export function createSessionLoop(deps: SessionLoopDeps): SessionTurnLoop {
  return new SessionTurnLoop({
    sessionId: deps.sessionId,
    mode: deps.mode,
    llm: deps.llm,
    storage: deps.storage,
    publish: deps.publish,
    ...(deps.systemPrompt !== undefined && { systemPrompt: deps.systemPrompt }),
    tools: deps.tools,
    workspaceRoot: deps.workspaceRoot,
    workspaceId: deps.workspaceId,
    ...(deps.initialHistory !== undefined && { initialHistory: deps.initialHistory }),
    ...(deps.initialEventSeq !== undefined && { initialEventSeq: deps.initialEventSeq }),
    onDiagnostic: (message, err) => console.error(`[novacode/server] ${message}`, err ?? ""),
  });
}

/** session.snapshot 投影（06 §3.2；内存态会话增量消息为空，端层被认为已跟进 lastSeq）。 */
export async function buildSessionSnapshot(input: {
  storage: Storage;
  sessionId: string;
  lastSeq: number;
  phase: SessionSnapshotPayload["phase"];
  model: string;
  activeProviderId: string;
  maxContextTokens: number;
}): Promise<SessionSnapshotPayload> {
  const { storage } = input;
  const meta = await storage.sessions.get(input.sessionId);
  return {
    lastSeq: input.lastSeq,
    phase: input.phase,
    model: input.model,
    activeProviderId: input.activeProviderId,
    contextUsage: {
      tokens: (meta?.inputTokens ?? 0) + (meta?.outputTokens ?? 0),
      maxTokens: input.maxContextTokens,
    },
    messages: [],
    pendingApprovals: [],
  };
}

/** session.list（06 §2.1）：默认视图只含 Active（归档经 filter.state="Archived" 查询）。 */
export async function listSessions(input: {
  storage: Storage;
  params: SessionListParams;
  providerModel: string;
  maxContextTokens: number;
}): Promise<SessionListResult> {
  const { storage, params } = input;
  const filter = params.filter;
  const rows = await storage.sessions.list({
    // 未指定 workspace 过滤时回退默认 workspace（与权限域 defaultWorkspace 同一判定域）
    ...(filter?.workspaceRoot !== undefined
      ? { workspaceHash: computeWorkspaceHash(filter.workspaceRoot) }
      : {}),
    status: filter?.state !== undefined ? (filter.state === "Active" ? "active" : "archived") : "active",
  });
  const keyword = filter?.keyword?.toLowerCase();
  const filtered = keyword
    ? rows.filter(
        (row) => row.title.toLowerCase().includes(keyword) || row.preview.toLowerCase().includes(keyword),
      )
    : rows;

  const limit = params.page?.limit ?? 50;
  const offset = parseCursor(params.page?.cursor);
  const paged = filtered.slice(offset, offset + limit);
  const items: SessionSummary[] = paged.map((row) => ({
    id: row.id,
    title: row.title,
    state: row.status === "active" ? "Active" : "Archived",
    createdAt: row.createdAt,
    lastActiveAt: row.lastActiveAt,
    model: input.providerModel,
    contextUsage: {
      tokens: row.inputTokens + row.outputTokens,
      maxTokens: input.maxContextTokens,
    },
  }));
  return {
    items,
    ...(offset + limit < filtered.length && { nextCursor: `o${String(offset + limit)}` }),
  };
}

/** turn 结果的旁路消费：usage 累计进 sessions 投影列（session.list contextUsage 数据源）。 */
export async function recordUsage(
  storage: Storage,
  sessionId: string,
  usage: { inputTokens: number; outputTokens: number },
): Promise<void> {
  const meta = await storage.sessions.get(sessionId);
  if (!meta) return;
  await storage.sessions.updateMeta(sessionId, {
    inputTokens: meta.inputTokens + usage.inputTokens,
    outputTokens: meta.outputTokens + usage.outputTokens,
  });
}

/** resume 场景 rpc seq 续起点：持久事件行（含 JSONL 头行 seq=1）与 checkpoint 的最大行号。 */
export function seedEventSeq(replay: SessionResume): number {
  let max = 1; // 头行恒为 seq 1（05 §4.2）
  for (const event of replay.events) {
    max = Math.max(max, event.seq);
  }
  if (replay.checkpoint) {
    max = Math.max(max, replay.checkpoint.seq);
  }
  return max;
}

/** 简单偏移游标：`o<number>`；非法/缺省回退 0（06 §2.0 分页约定的最小落地）。 */
export function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined || !cursor.startsWith("o")) return 0;
  const parsed = Number.parseInt(cursor.slice(1), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

/** 归档阻塞检查：存在运行中后台任务且未 force → SESSION_BACKGROUND_TASKS（details 附 taskIds）。 */
export function assertNoRunningBackgroundTasks(
  tasks: Array<{ taskId: string; status: string }>,
  force: boolean | undefined,
): void {
  if (force === true) return;
  const running = tasks.filter((task) => task.status === "Running");
  if (running.length > 0) {
    throw new RpcCallError(
      "SESSION_BACKGROUND_TASKS",
      `archive blocked by ${String(running.length)} running background task(s)`,
      { taskIds: running.map((task) => task.taskId) },
    );
  }
}
