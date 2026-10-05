/**
 * Storage 端口门面：唯一持久化出口（04-architecture §2.4 铁律 2）。
 * - 同步 SQLite（better-sqlite3 + WAL）与同步 fs 内核之上提供全异步端口（walking skeleton 约定）；
 * - 数据根：RAINCODE_HOME 覆盖 → 缺省 ~/.raincode（05 §2.1）；workspace 打开即登记（§3.1）；
 * - 会话创建 = sessions 行 + 会话目录 + JSONL 头行（02 §1.2.2 C1）；
 * - append / checkpoint 经单写者 SessionStream；checkpoint 落盘后回写 sessions 投影列（§4.3）；
 * - resume 走 checkpoint O(1) 定位 + 增量重放，并对账回写（§4.4 第 6 步）。
 */
import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import type { MessageRecord } from "@raincode/shared";
import { openDatabase, type SqliteDatabase } from "./db.js";
import { StorageError } from "./errors.js";
import { HistorySearchRepo, type HistorySearchHit, type HistorySearchOptions } from "./history-search.js";
import { HEADER_EVENT_NAME, JSONL_SCHEMA_VERSION, RAINCODE_VERSION, type CheckpointState } from "./jsonl-lines.js";
import { replaySessionFile, repairDanglingTail, scanTailState, type ResumeReplay } from "./jsonl-resume.js";
import { SessionStream, type AppendResult, type CheckpointResult } from "./jsonl-stream.js";
import { canonicalWorkspacePath, computeWorkspaceHash, resolveDataRoot, sessionPaths } from "./paths.js";
import { ApprovalsRepo } from "./approvals-repo.js";
import { DecisionsRepo } from "./decisions-repo.js";
import { MemoryRepo } from "./memory-repo.js";
import { RulesRepo } from "./rules-repo.js";
import { SessionsRepo, type SessionCreateInput, type SessionMeta } from "./sessions-repo.js";
import { SettingsRepo } from "./settings-repo.js";

export interface WorkspaceInfo {
  hash: string;
  rootPath: string;
  name: string;
  createdAt: number;
  lastOpenedAt: number;
}

export interface StorageOpenOptions {
  /** 显式数据根；缺省按 RAINCODE_HOME → ~/.raincode 解析（测试注入用）。 */
  dataRoot?: string;
  /** 环境变量来源（缺省 process.env；测试隔离 RAINCODE_HOME 用）。 */
  env?: NodeJS.ProcessEnv;
}

export interface SessionResume extends ResumeReplay {
  sessionId: string;
}

export interface AppendOptions {
  /** 调用方持有的压缩代次；小于会话当前值的写入被拒绝（05 §4.3 第 5 点）。 */
  epoch?: number;
}

export interface CheckpointOptions extends AppendOptions {}

export class Storage {
  readonly dataRoot: string;
  readonly sessions: SessionsRepo;
  /** 权限规则真源（scope=project/global；session 规则驻内存，02 §6.2）。 */
  readonly permissionRules: RulesRepo;
  /** 三态判定审计（append-only，05 §3.8）。 */
  readonly permissionDecisions: DecisionsRepo;
  /** 审批单未决态真源（05 §3.7）。 */
  readonly approvals: ApprovalsRepo;
  /** 会话记忆条目真源（05 §3.9；召回默认集语义见 memory-repo）。 */
  readonly memory: MemoryRepo;
  /** 运行期 KV（05 §3.11；含记忆抽取幂等键 memory.extracted.<sessionId>）。 */
  readonly settings: SettingsRepo;
  /** 会话历史检索（T5.3：part 级 FTS 派生索引 + 增量回填；正文真源仍是 events.jsonl）。 */
  readonly history: HistorySearchRepo;

  private readonly db: SqliteDatabase;
  private readonly streams = new Map<string, SessionStream>();
  /** 关闭栅栏（T4.2）：close 发起后 openSessionStream 不再开新流，迟到写入类型化拒绝。 */
  private closing = false;
  private closePromise: Promise<void> | null = null;

  private constructor(db: SqliteDatabase, dataRoot: string) {
    this.db = db;
    this.dataRoot = dataRoot;
    this.sessions = new SessionsRepo(db);
    this.permissionRules = new RulesRepo(db);
    this.permissionDecisions = new DecisionsRepo(db);
    this.approvals = new ApprovalsRepo(db);
    this.memory = new MemoryRepo(db);
    this.settings = new SettingsRepo(db);
    this.history = new HistorySearchRepo(db, dataRoot, this.sessions, this.settings);
  }

  /** 打开全局单库：连接 PRAGMA + 迁移在 TUI ready 前同步完成（05 §6，NFR-1）。 */
  static async open(options: StorageOpenOptions = {}): Promise<Storage> {
    const dataRoot = options.dataRoot ?? resolveDataRoot(options.env ?? process.env);
    return new Storage(openDatabase(dataRoot), dataRoot);
  }

  /** 打开即登记 workspace：upsert + last_opened_at 刷新（05 §3.1）。 */
  async ensureWorkspace(workspaceRoot: string): Promise<WorkspaceInfo> {
    const rootPath = canonicalWorkspacePath(workspaceRoot);
    const hash = computeWorkspaceHash(rootPath);
    const ts = Date.now();
    const name = basename(workspaceRoot);
    this.db
      .prepare(
        `INSERT INTO workspaces (hash, root_path, name, created_at, last_opened_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(hash) DO UPDATE SET last_opened_at = excluded.last_opened_at`,
      )
      .run(hash, rootPath, name, ts, ts);
    const row = this.db
      .prepare(
        `SELECT hash, root_path AS rootPath, name, created_at AS createdAt, last_opened_at AS lastOpenedAt
         FROM workspaces WHERE hash = ?`,
      )
      .get(hash) as WorkspaceInfo | undefined;
    if (!row) {
      throw new StorageError("WORKSPACE_NOT_FOUND", `workspace upsert failed: ${rootPath}`);
    }
    return row;
  }

  /** 创建会话：sessions 行 + 会话目录 + JSONL 头行（头行携带 schemaVersion + epoch，05 §4.2/§4.3）。 */
  async createSession(input: SessionCreateInput & { workspaceRoot?: string }): Promise<SessionMeta> {
    const meta = await this.sessions.create(input);
    const paths = sessionPaths(this.dataRoot, meta.workspaceId, meta.id);
    await mkdir(paths.dir, { recursive: true });
    const root = input.workspaceRoot ?? this.getWorkspaceRoot(meta.workspaceId) ?? "";
    // 头行 = 首条 event 行（seq 1）：schemaVersion 与 epoch 显式落盘，epoch 单调合并的文件内起点
    const header = {
      v: JSONL_SCHEMA_VERSION,
      type: "event",
      seq: 1,
      ts: meta.createdAt,
      name: HEADER_EVENT_NAME,
      payload: {
        schemaVersion: JSONL_SCHEMA_VERSION,
        epoch: 0,
        workspaceHash: meta.workspaceId,
        root,
        raincodeVersion: RAINCODE_VERSION,
      },
    };
    await writeFile(paths.eventsFile, `${JSON.stringify(header)}\n`, { flag: "ax" });
    return meta;
  }

  /** 打开（或复用）会话追加流：残尾修复 → 尾部扫描续写位 → epoch 守卫取 max(库内, 文件内)。 */
  async openSessionStream(sessionId: string): Promise<SessionStream> {
    if (this.closing) {
      throw new StorageError("STORAGE_CLOSED", `storage is closing; session stream unavailable: ${sessionId}`);
    }
    const existing = this.streams.get(sessionId);
    if (existing) {
      return existing;
    }
    const meta = await this.getExistingSession(sessionId);
    const paths = sessionPaths(this.dataRoot, meta.workspaceId, sessionId);
    await repairDanglingTail(paths.eventsFile); // 05 §4.5：半行残尾另存截去，保证后续追加行完整
    const tail = await scanTailState(paths.eventsFile);
    const stream = await SessionStream.open(paths.eventsFile, {
      lastSeq: tail.lastSeq,
      epoch: Math.max(meta.epoch, tail.epoch),
    });
    this.streams.set(sessionId, stream);
    return stream;
  }

  /** 追加消息定稿行（message）；旧 epoch 写入被拒绝并计数，不落盘。 */
  async appendMessage(sessionId: string, message: MessageRecord, options: AppendOptions = {}): Promise<AppendResult> {
    const stream = await this.openSessionStream(sessionId);
    return stream.appendMessage(message, options);
  }

  /** 追加非消息类持久事件行（event）：审批、模式切换、压缩报告等（05 §4.2）。 */
  async appendEvent(
    sessionId: string,
    name: string,
    payload: unknown,
    options: AppendOptions = {},
  ): Promise<AppendResult> {
    const stream = await this.openSessionStream(sessionId);
    return stream.appendEvent(name, payload, options);
  }

  /**
   * 追加 checkpoint 行（fsync 断电级持久点），并把最近 checkpoint 行起始偏移 / epoch /
   * messageCount / last_active_at 对账回写 sessions 投影列（05 §4.3、§1.2「checkpoint_offset / epoch
   * 是 sessions 被写入最频繁的两个投影列」）。
   */
  async writeCheckpoint(
    sessionId: string,
    state: CheckpointState,
    options: CheckpointOptions = {},
  ): Promise<CheckpointResult> {
    const stream = await this.openSessionStream(sessionId);
    const result = await stream.writeCheckpoint(state, options);
    if (result.accepted) {
      await this.sessions.updateMeta(sessionId, {
        checkpointOffset: result.lineStartOffset,
        epoch: result.epoch,
        messageCount: state.messageCount,
        lastActiveAt: Date.now(),
      });
    }
    return result;
  }

  /**
   * 恢复重放（05 §4.4）：checkpoint_offset O(1) 定位校验 → 增量重放（不可用退尾部扫描/全量）→
   * 悬挂 tool_call 内存态补齐 → 对账回写 checkpoint_offset / epoch / message_count。
   */
  async resumeSession(sessionId: string): Promise<SessionResume> {
    const meta = await this.getExistingSession(sessionId);
    const paths = sessionPaths(this.dataRoot, meta.workspaceId, sessionId);
    const replay = await replaySessionFile(paths.eventsFile, {
      checkpointOffset: meta.checkpointOffset,
      epoch: meta.epoch,
      includeHistory: true,
    });
    await this.sessions.updateMeta(sessionId, {
      messageCount: replay.messageCount,
      checkpointOffset: replay.checkpoint?.offset ?? 0,
      epoch: Math.max(meta.epoch, replay.epoch),
      lastActiveAt: Date.now(),
    });
    return { sessionId, ...replay };
  }

  /**
   * 会话历史检索（T5.3）：part 级 FTS（文本块 + 工具名），检索前对本 workspace 全部会话
   * 增量回填索引；相对分数地板 + LIKE 兜底语义见 history-search.ts（05 §5.4）。
   */
  async searchHistory(
    workspaceId: string,
    query: string,
    options: HistorySearchOptions = {},
  ): Promise<HistorySearchHit[]> {
    return this.history.search(workspaceId, query, options);
  }

  /** 会话 events.jsonl 绝对路径（诊断/测试用）。 */
  async sessionEventsFile(sessionId: string): Promise<string> {
    const meta = await this.getExistingSession(sessionId);
    return sessionPaths(this.dataRoot, meta.workspaceId, sessionId).eventsFile;
  }

  /**
   * 会话所属 workspace 根路径（05 §3.1 workspaces 表投影）。
   * 工具执行 ctx.workspaceRoot 的数据源（resume 重建会话时无法从调用方取得 root，经此处回查）。
   */
  async workspaceRootOf(sessionId: string): Promise<string | null> {
    const meta = await this.sessions.get(sessionId);
    if (meta === null) {
      return null;
    }
    return this.getWorkspaceRoot(meta.workspaceId);
  }

  /**
   * workspace hash → 根路径（05 §3.1 workspaces 表投影；增量挂载）。
   * memory.promote 由条目反查 MEMORY.md 文件真源位置（条目只携带 workspaceId=hash）。
   */
  async workspaceRootByHash(workspaceHash: string): Promise<string | null> {
    return this.getWorkspaceRoot(workspaceHash);
  }

  async eventsFileSize(sessionId: string): Promise<number> {
    const eventsFile = await this.sessionEventsFile(sessionId);
    try {
      return (await stat(eventsFile)).size;
    } catch {
      return 0;
    }
  }

  /** 关闭全部追加流与数据库（单写者句柄随生命周期释放，05 §4.3 第 1 点）。
   * T4.2：先设关闭栅栏（openSessionStream 不再开新流——旧行为会在 close 窗口重开句柄泄漏），
   * 再逐流排空在途写后释放句柄（SessionStream.close 联动），幂等（重复调用复用同一 promise）。 */
  close(): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      for (const stream of this.streams.values()) {
        await stream.close();
      }
      this.streams.clear();
      this.db.close();
    })();
    return this.closePromise;
  }

  private async getExistingSession(sessionId: string): Promise<SessionMeta> {
    const meta = await this.sessions.get(sessionId);
    if (!meta) {
      throw new StorageError("SESSION_NOT_FOUND", `session not found: ${sessionId}`);
    }
    return meta;
  }

  private getWorkspaceRoot(hash: string): string | null {
    const row = this.db.prepare("SELECT root_path FROM workspaces WHERE hash = ?").get(hash) as
      | { root_path: string }
      | undefined;
    return row?.root_path ?? null;
  }
}
