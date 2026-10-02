/**
 * 会话域支撑函数（从 agent-service 拆出，单文件 ≤500 行治理）：
 * SessionTurnLoop 构造（create/resume 共用）、session.snapshot 投影、session.list 查询、
 * usage 回写与 rpc seq 续起点、活跃会话表条目类型。全部为无状态纯函数，依赖经参数注入（04 §2.4 铁律 4）。
 */
import { RpcCallError, type RpcServiceBinding } from "@raincode/rpc";
import type {
  CollaborationMode,
  MessageRecord,
  SessionListParams,
  SessionListResult,
  SessionSnapshotPayload,
  SessionSummary,
} from "@raincode/shared";
import type { BackgroundTaskRegistry } from "@raincode/tools";
import { stat } from "node:fs/promises";
import { StorageError, type SessionResume, type Storage } from "@raincode/storage";
import { computeWorkspaceHash } from "@raincode/storage";
import { SessionTurnLoop } from "@raincode/agent-core";
import type { CompactionOptions, LlmPort, SessionEventPublisher, ToolPhaseDeps, TurnOutcome } from "@raincode/agent-core";
import { memoryLoopEnhancements, type MemoryRuntime } from "./memory-runtime.js";

/** AgentService 活跃会话表条目（agent-service.sessions 与 session-domain 共用同一形态）。 */
export interface SessionEntry {
  loop: SessionTurnLoop;
  llm: LlmPort | null;
  providerId: string;
  workspaceHash: string;
  mode: CollaborationMode;
  workspaceRoot: string;
  /** 最近一次 submit 的 turn 终态句柄（archive / shutdown / fork 的等待点）。 */
  pending: Promise<TurnOutcome> | null;
}

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
  /** resume 场景的压缩代次起点（文件内最大 epoch）。 */
  initialEpoch?: number;
  /** turn 内模型轮次上限（02 §1.2.1：缺省 32；子代理按 profile.maxTurns 传入）。 */
  maxRoundsPerTurn?: number;
  /** auto-compact 选项（contextWindowTokens 已由 server 按 Provider maxContextTokens 补齐）。 */
  compaction?: CompactionOptions;
  /** compact 提交前记忆抽取钩子（02 §7.2；透传 CompactionDeps.onBeforeReplace，失败不阻塞替换）。 */
  compactionOnBeforeReplace?: (prefix: MessageRecord[]) => Promise<void>;
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
    ...(deps.initialEpoch !== undefined && { initialEpoch: deps.initialEpoch }),
    ...(deps.maxRoundsPerTurn !== undefined && { maxRoundsPerTurn: deps.maxRoundsPerTurn }),
    ...(deps.compaction !== undefined && { compaction: deps.compaction }),
    ...(deps.compactionOnBeforeReplace !== undefined && { compactionOnBeforeReplace: deps.compactionOnBeforeReplace }),
    onDiagnostic: (message, err) => console.error(`[raincode/server] ${message}`, err ?? ""),
  });
}

/** 会话事件出口（agent-service.publisher 拆分，单文件 ≤500 行治理）：binding 缺席时丢弃并告警（06 §3.3）。 */
export function eventPublisher(binding: RpcServiceBinding | null): SessionEventPublisher {
  return (event) => {
    if (!binding) {
      console.error("[raincode/server] event dropped: no transport attached", event.name);
      return;
    }
    binding.publish(event);
  };
}

/** session.compact（06 §2.1）：手动压缩受理即返；无可摘要前缀 → INVALID_PARAMS。 */
export async function compactSession(entry: { loop: SessionTurnLoop }): Promise<unknown> {
  const ticket = entry.loop.compact();
  if (ticket === null) {
    throw new RpcCallError("INVALID_PARAMS", "nothing to compact: history is within the retention zone");
  }
  return { compactionId: ticket.compactionId, epoch: ticket.epoch, alreadyRunning: ticket.alreadyRunning };
}

/** session.snapshot 投影（06 §3.2）：messages 仅含末尾 checkpoint 之后的尾部增量（NFR-5）；
 * history 为可选全量消息（冷重建 / renderer 刷新，v1.3；缺省省略守住快照最小投影）；
 * 内存态新会话增量为空（端层被认为已跟进 lastSeq）；pendingApprovals 为会话未决审批补推（02 §6.4）。 */
export async function buildSessionSnapshot(input: {
  storage: Storage;
  sessionId: string;
  lastSeq: number;
  phase: SessionSnapshotPayload["phase"];
  model: string;
  activeProviderId: string;
  maxContextTokens: number;
  messages?: MessageRecord[];
  history?: MessageRecord[];
  pendingApprovals?: SessionSnapshotPayload["pendingApprovals"];
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
    messages: input.messages ?? [],
    ...(input.history !== undefined && { history: input.history }),
    pendingApprovals: input.pendingApprovals ?? [],
  };
}

/** session.resume 主流程（agent-service 委托；方法族拆分 06 §5，单文件 ≤500 行治理）：
 * 存在性/归档校验 → replay 冷恢复 → loop 装配（initialHistory + seq/epoch 续起点）→
 * 快照组装（messages=尾部增量 NFR-5 / history=全量 v1.3 冷重建 / pendingApprovals 补推）。 */
export async function resumeSessionFlow(input: {
  storage: Storage;
  sessions: Map<string, SessionEntry>;
  llmFor(providerId: string | undefined): LlmPort | null;
  publishFactory(): SessionEventPublisher;
  toolDeps: ToolPhaseDeps & { background: BackgroundTaskRegistry };
  memory: MemoryRuntime | null;
  systemPrompt?: string;
  compaction?: CompactionOptions;
  providerId: string;
  providerModel: string;
  maxContextTokens: number;
  permissionPending(sessionId: string): SessionSnapshotPayload["pendingApprovals"];
  sessionId: string;
}): Promise<{ sessionId: string; snapshot: SessionSnapshotPayload }> {
  const existing = input.sessions.get(input.sessionId);
  if (existing) {
    // 幂等：会话已 Active 直接返回当前快照（06 §2.1）；history=loop 内存历史（renderer 刷新冷重建同语义）
    const snapshot = await buildSessionSnapshot({
      storage: input.storage, sessionId: input.sessionId, lastSeq: existing.loop.lastEventSeq,
      phase: existing.loop.phase, model: input.providerModel, activeProviderId: input.providerId,
      maxContextTokens: input.maxContextTokens, messages: existing.loop.getHistory(),
      pendingApprovals: input.permissionPending(input.sessionId),
    });
    return { sessionId: input.sessionId, snapshot };
  }
  const meta = await input.storage.sessions.get(input.sessionId);
  if (!meta) {
    throw new RpcCallError("SESSION_NOT_FOUND", `session not found: ${input.sessionId}`);
  }
  if (meta.status === "archived") {
    // 归档会话不可恢复（本波口径；06 §2.1 未定义归档恢复路径）
    throw new RpcCallError("SESSION_NOT_FOUND", `session is archived: ${input.sessionId}`);
  }
  let replay: SessionResume;
  try {
    replay = await input.storage.resumeSession(input.sessionId);
  } catch (reason: unknown) {
    if (reason instanceof StorageError && reason.code === "SESSION_NOT_FOUND") {
      throw new RpcCallError("SESSION_NOT_FOUND", `session not found: ${input.sessionId}`);
    }
    throw reason;
  }
  const workspaceRoot = (await input.storage.workspaceRootOf(meta.id)) ?? process.cwd();
  const llm = input.llmFor(undefined);
  const loop = createSessionLoop({
    sessionId: meta.id, mode: meta.mode, llm, storage: input.storage, publish: input.publishFactory(),
    ...((await memoryLoopEnhancements(input.memory, input.systemPrompt, workspaceRoot, meta.id, meta.workspaceId))),
    tools: input.toolDeps, workspaceRoot, workspaceId: meta.workspaceId,
    initialHistory: replay.history,
    initialEventSeq: seedEventSeq(replay),
    initialEpoch: replay.epoch,
    ...(input.compaction !== undefined && { compaction: input.compaction }),
  });
  const entry: SessionEntry = {
    loop, llm, providerId: input.providerId,
    workspaceHash: meta.workspaceId, mode: meta.mode, workspaceRoot, pending: null,
  };
  input.sessions.set(meta.id, entry);
  // 断线重连补推（06 §2.1/§3.4）：messages=尾部增量（NFR-5）；history=全量（v1.3 冷重建，桌面端首次打开/renderer 刷新）
  const snapshot = await buildSessionSnapshot({
    storage: input.storage, sessionId: meta.id, lastSeq: entry.loop.lastEventSeq,
    phase: entry.loop.phase, model: input.providerModel, activeProviderId: input.providerId,
    maxContextTokens: input.maxContextTokens, messages: replay.messages, history: replay.history,
    pendingApprovals: input.permissionPending(meta.id),
  });
  return { sessionId: meta.id, snapshot };
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

/** turn 结果的旁路消费：usage 累计进 sessions 投影列（session.list contextUsage / session.usage 数据源）。 */
export async function recordUsage(
  storage: Storage,
  sessionId: string,
  usage: { inputTokens: number; outputTokens: number },
): Promise<void> {
  const meta = await storage.sessions.get(sessionId);
  if (!meta) return;
  // 原子累计（SQL 侧自增）：相邻 turn 快速收束时，两个读改写并发会相互覆盖丢失更新（T2.6/AC-10 修复）
  await storage.sessions.accumulateUsage(sessionId, usage.inputTokens, usage.outputTokens);
}

/** resume 场景 rpc seq 续起点：持久事件行（含 JSONL 头行 seq=1）与 checkpoint 的最大行号。 */
/** workspaceRoot 存在性校验（06 §2.1：必须为已存在目录；只读探测不读写数据）。 */
export async function assertExistingWorkspace(workspaceRoot: string): Promise<void> {
  try {
    const info = await stat(workspaceRoot);
    if (!info.isDirectory()) throw new Error("not a directory");
  } catch {
    throw new RpcCallError("INVALID_PARAMS", "workspaceRoot must be an existing directory", {
      workspaceRoot,
    });
  }
}

/**
 * 活跃会话准入解析（agent-service requireActive 下沉，06 §2.1）：
 * 内存命中优先（Active 会话），落库存活兜底；archived → 只读拒绝，未知 → SESSION_NOT_FOUND。
 */
export async function requireActiveSession(
  sessions: Map<string, SessionEntry>,
  storage: Storage,
  sessionId: string,
): Promise<SessionEntry> {
  const entry = sessions.get(sessionId);
  if (entry) return entry;
  const meta = await storage.sessions.get(sessionId);
  if (meta?.status === "archived") {
    throw new RpcCallError("SESSION_ARCHIVED", `session is archived (read-only): ${sessionId}`);
  }
  throw new RpcCallError("SESSION_NOT_FOUND", `session not found or not resumed: ${sessionId}`);
}

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

/** auto-compact 选项组装（02 §1.2.5）：contextWindowTokens 由 Provider maxContextTokens 补齐。 */
export function buildCompactionOptions(
  raw: { thresholdRatio?: number; keepRecentCount?: number } | undefined,
  contextWindowTokens: number,
): CompactionOptions | undefined {
  if (raw === undefined) {
    return undefined;
  }
  return {
    contextWindowTokens,
    ...(raw.thresholdRatio !== undefined && { thresholdRatio: raw.thresholdRatio }),
    ...(raw.keepRecentCount !== undefined && { keepRecentCount: raw.keepRecentCount }),
  };
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
