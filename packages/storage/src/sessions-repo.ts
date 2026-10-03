/**
 * SessionsRepo：sessions 表薄 repo 层（05-database §3.3 DDL 逐字段对齐）。
 * 同步 SQLite 内核、对外一律 async（04 §2.1）；SQL 全部收敛在本包内（04 §2.4 铁律 2）。
 * 列投影经 SQL 别名映射为 camelCase；CHECK 约束保证枚举值合法，读取侧仅做类型收窄。
 */
import type { CollaborationMode } from "@raincode/shared";
import type { SqliteDatabase } from "./db.js";
import { ulid } from "./ulid.js";

export type SessionKind = "main" | "subagent";
export type SessionStatus = "active" | "archived";

/** sessions 行投影（camelCase，与表列一一对应，05 §3.3）。 */
export interface SessionMeta {
  id: string;
  workspaceId: string;
  kind: SessionKind;
  parentSessionId: string | null;
  title: string;
  preview: string;
  status: SessionStatus;
  mode: CollaborationMode;
  messageCount: number;
  checkpointOffset: number;
  epoch: number;
  turnsCount: number;
  inputTokens: number;
  outputTokens: number;
  createdAt: number;
  lastActiveAt: number;
  archivedAt: number | null;
}

export interface SessionCreateInput {
  /** 所属 workspace（须先经 Storage.ensureWorkspace 登记，FK 约束）。 */
  workspaceHash: string;
  /** 缺省生成 session_<ulid>。 */
  id?: string;
  kind?: SessionKind;
  parentSessionId?: string | null;
  title?: string;
  mode?: CollaborationMode;
  ts?: number;
}

export interface SessionListFilter {
  workspaceHash?: string;
  status?: SessionStatus;
  limit?: number;
}

/** 可更新投影列（id/workspace_id/kind/parent_session_id/created_at 不可变）。 */
export interface SessionMetaPatch {
  title?: string;
  preview?: string;
  status?: SessionStatus;
  mode?: CollaborationMode;
  messageCount?: number;
  checkpointOffset?: number;
  epoch?: number;
  turnsCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  lastActiveAt?: number;
  archivedAt?: number | null;
}

const ROW_COLUMNS = [
  "id",
  "workspace_id AS workspaceId",
  "kind",
  "parent_session_id AS parentSessionId",
  "title",
  "preview",
  "status",
  "mode",
  "message_count AS messageCount",
  "checkpoint_offset AS checkpointOffset",
  "epoch",
  "turns_count AS turnsCount",
  "input_tokens AS inputTokens",
  "output_tokens AS outputTokens",
  "created_at AS createdAt",
  "last_active_at AS lastActiveAt",
  "archived_at AS archivedAt",
].join(", ");

function mapRow(row: Record<string, unknown>): SessionMeta {
  return {
    id: row["id"] as string,
    workspaceId: row["workspaceId"] as string,
    kind: row["kind"] as SessionKind,
    parentSessionId: (row["parentSessionId"] as string | null) ?? null,
    title: row["title"] as string,
    preview: row["preview"] as string,
    status: row["status"] as SessionStatus,
    mode: row["mode"] as CollaborationMode,
    messageCount: row["messageCount"] as number,
    checkpointOffset: row["checkpointOffset"] as number,
    epoch: row["epoch"] as number,
    turnsCount: row["turnsCount"] as number,
    inputTokens: row["inputTokens"] as number,
    outputTokens: row["outputTokens"] as number,
    createdAt: row["createdAt"] as number,
    lastActiveAt: row["lastActiveAt"] as number,
    archivedAt: (row["archivedAt"] as number | null) ?? null,
  };
}

export class SessionsRepo {
  constructor(private readonly db: SqliteDatabase) {}

  async create(input: SessionCreateInput): Promise<SessionMeta> {
    const ts = input.ts ?? Date.now();
    const id = input.id ?? `session_${ulid(ts)}`;
    this.db
      .prepare(
        `INSERT INTO sessions
           (id, workspace_id, kind, parent_session_id, title, preview, status, mode, created_at, last_active_at)
         VALUES (?, ?, ?, ?, ?, '', 'active', ?, ?, ?)`,
      )
      .run(
        id,
        input.workspaceHash,
        input.kind ?? "main",
        input.parentSessionId ?? null,
        input.title ?? "",
        input.mode ?? "normal",
        ts,
        ts,
      );
    const created = await this.get(id);
    if (!created) {
      throw new Error(`[INTERNAL] session create failed: ${id}`);
    }
    return created;
  }

  /** 按 last_active_at 倒序（走 ix_sessions_ws_active 索引序）。 */
  async list(filter: SessionListFilter = {}): Promise<SessionMeta[]> {
    const where: string[] = [];
    const params: Array<string | number | null> = [];
    if (filter.workspaceHash !== undefined) {
      where.push("workspace_id = ?");
      params.push(filter.workspaceHash);
    }
    if (filter.status !== undefined) {
      where.push("status = ?");
      params.push(filter.status);
    }
    const limit = filter.limit !== undefined ? ` LIMIT ${Math.trunc(filter.limit)}` : "";
    const sql = `SELECT ${ROW_COLUMNS} FROM sessions${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY last_active_at DESC${limit}`;
    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map(mapRow);
  }

  async get(id: string): Promise<SessionMeta | null> {
    const row = this.db.prepare(`SELECT ${ROW_COLUMNS} FROM sessions WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? mapRow(row) : null;
  }

  /** usage 原子累计（05 §1.2 投影列）：SQL 侧自增——相邻 turn 快速收束时并发读改写会丢失更新（T2.6/AC-10）。
   * turns_count 同语句自增（completed turn 每回合恰一次 recordUsage；T4.5 首跑发现此前恒为 0）。 */
  async accumulateUsage(id: string, inputDelta: number, outputDelta: number): Promise<void> {
    this.db
      .prepare(
        "UPDATE sessions SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, turns_count = turns_count + 1 WHERE id = ?",
      )
      .run(inputDelta, outputDelta, id);
  }

  async updateMeta(id: string, patch: SessionMetaPatch): Promise<void> {
    const assignments: Array<[string, string | number | null | undefined]> = [
      ["title", patch.title],
      ["preview", patch.preview],
      ["status", patch.status],
      ["mode", patch.mode],
      ["message_count", patch.messageCount],
      ["checkpoint_offset", patch.checkpointOffset],
      ["epoch", patch.epoch],
      ["turns_count", patch.turnsCount],
      ["input_tokens", patch.inputTokens],
      ["output_tokens", patch.outputTokens],
      ["last_active_at", patch.lastActiveAt],
      ["archived_at", patch.archivedAt],
    ];
    const sets: string[] = [];
    const params: Array<string | number | null> = [];
    for (const [column, value] of assignments) {
      if (value !== undefined) {
        sets.push(`${column} = ?`);
        params.push(value);
      }
    }
    if (sets.length === 0) {
      return;
    }
    params.push(id);
    this.db.prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  }
}
