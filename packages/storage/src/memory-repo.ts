/**
 * MemoryRepo：memory_entries 表薄 repo 层（05-database §3.9 DDL 逐字段对齐；§5.4 召回 SQL 语义）。
 * - 跨项目串味防线（02 §7.4）：业务查询强制带 workspaceId 过滤；唯一例外是 list() 管理视图
 *   （06 §2.6 memory.entries.list 面向管理 UI，workspaceId 缺省 = 跨 workspace 全量）；
 * - 召回默认集：status='active' AND confidence>=0.6（02 §7.4 幻觉防线，05 §5.4）；
 * - 管理视图不过滤 confidence/status（与召回默认集区分，06 §2.6 语义）。
 */
import type { MemoryEntry, MemoryKind, MemorySource } from "@raincode/shared";
import type { SqliteDatabase } from "./db.js";
import { ulid } from "./ulid.js";

/** 召回默认集置信度阈值（02 §7.4：confidence < 0.6 不入召回默认集）。 */
export const MEMORY_RECALL_MIN_CONFIDENCE = 0.6;

/** list 分页缺省/上限（06 §2.0：limit 默认 50、上限 200）。 */
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;

/** memory_entries 行投影（camelCase，与表列一一对应，05 §3.9）；MemoryEntry 类型复用 @raincode/shared。 */

/** 新条目入参；id 由 repo 生成（entry_${ulid}，与 rules-repo 同约定）。 */
export interface NewMemoryEntry {
  workspaceId: string;
  kind: MemoryKind;
  /** 单句要点 ≤200 字（截断由调用方负责，DDL CHECK 兜底拒绝）。 */
  content: string;
  refs?: string[];
  /** 缺省 1.0（05 §3.9 列默认值）；抽取路径的 0.8 缺省由调用方定。 */
  confidence?: number;
  source: MemorySource;
  ts?: number;
}

export interface MemoryListFilter {
  kind?: MemoryKind;
  source?: MemorySource;
  /** lastSeenAt 起始（含）。 */
  since?: number;
  /** keyset 分页游标（encodeCursor 产物；非法值按无游标处理回第一页）。 */
  cursor?: string;
  limit?: number;
}

const ROW_COLUMNS = [
  "id",
  "workspace_id AS workspaceId",
  "kind",
  "content",
  "refs_json AS refsJson",
  "confidence",
  "source",
  "status",
  "superseded_by AS supersededBy",
  "created_at AS createdAt",
  "last_seen_at AS lastSeenAt",
].join(", ");

/** JOIN memory_fts 用的带别名列投影（memory_fts 同名 content 列需消歧义）。 */
const FTS_ROW_COLUMNS = ROW_COLUMNS.split(", ")
  .map((col) => `e.${col}`)
  .join(", ");

function mapRow(row: Record<string, unknown>): MemoryEntry {
  let refs: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row["refsJson"] as string);
    if (Array.isArray(parsed)) {
      refs = parsed.filter((item): item is string => typeof item === "string");
    }
  } catch {
    // refs_json 损坏按缺省 [] 处理（列 NOT NULL DEFAULT '[]'，正常不可达）
  }
  return {
    id: row["id"] as string,
    workspaceId: row["workspaceId"] as string,
    kind: row["kind"] as MemoryKind,
    content: row["content"] as string,
    refs,
    confidence: row["confidence"] as number,
    source: row["source"] as MemorySource,
    status: row["status"] as MemoryEntry["status"],
    supersededBy: (row["supersededBy"] as string | null) ?? null,
    createdAt: row["createdAt"] as number,
    lastSeenAt: row["lastSeenAt"] as number,
  };
}

/** LIKE 模式转义：\ % _ 前置反斜杠，配合 ESCAPE '\' 按字面量匹配。 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** keyset 游标：base64url(lastSeenAt:id)；id 为 ULID 不含 ':'，按首个 ':' 切分。 */
function encodeCursor(entry: MemoryEntry): string {
  return Buffer.from(`${entry.lastSeenAt}:${entry.id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { lastSeenAt: number; id: string } | null {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const idx = raw.indexOf(":");
    if (idx <= 0) {
      return null;
    }
    const lastSeenAt = Number(raw.slice(0, idx));
    const id = raw.slice(idx + 1);
    if (!Number.isFinite(lastSeenAt) || id === "") {
      return null;
    }
    return { lastSeenAt, id };
  } catch {
    return null;
  }
}

export class MemoryRepo {
  constructor(private readonly db: SqliteDatabase) {}

  /** 插入条目：id 在此处生成；refs JSON 序列化；status 缺省 active（05 §3.9）。 */
  async insert(entry: NewMemoryEntry): Promise<MemoryEntry> {
    const ts = entry.ts ?? Date.now();
    const id = `entry_${ulid(ts)}`;
    this.db
      .prepare(
        `INSERT INTO memory_entries
           (id, workspace_id, kind, content, refs_json, confidence, source, status, superseded_by, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?)`,
      )
      .run(
        id,
        entry.workspaceId,
        entry.kind,
        entry.content,
        JSON.stringify(entry.refs ?? []),
        entry.confidence ?? 1.0,
        entry.source,
        ts,
        ts,
      );
    const created = await this.get(id);
    if (!created) {
      throw new Error(`[INTERNAL] memory entry insert failed: ${id}`);
    }
    return created;
  }

  async get(id: string): Promise<MemoryEntry | null> {
    const row = this.db.prepare(`SELECT ${ROW_COLUMNS} FROM memory_entries WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? mapRow(row) : null;
  }

  /** 重复确认：仅刷新 last_seen_at（02 §7.3 淘汰依据）。 */
  async touch(id: string, lastSeenAt: number): Promise<void> {
    this.db.prepare("UPDATE memory_entries SET last_seen_at = ? WHERE id = ?").run(lastSeenAt, id);
  }

  /** 矛盾标记：旧者置 superseded 并回链新者（02 §7.4「新者保留并标记 superseded」）。 */
  async supersede(oldId: string, byId: string): Promise<void> {
    this.db
      .prepare("UPDATE memory_entries SET status = 'superseded', superseded_by = ? WHERE id = ?")
      .run(byId, oldId);
  }

  /**
   * 精确去重：归一化后完全相等的 active 条目（新取 last_seen_at 最新者）。
   * 比对口径依赖调用方：抽取路径统一 normalizeMemoryContent 后入库与查询。
   */
  async findByContent(workspaceId: string, normalizedContent: string): Promise<MemoryEntry | null> {
    const row = this.db
      .prepare(
        `SELECT ${ROW_COLUMNS} FROM memory_entries
         WHERE workspace_id = ? AND content = ? AND status = 'active'
         ORDER BY last_seen_at DESC, id DESC LIMIT 1`,
      )
      .get(workspaceId, normalizedContent) as Record<string, unknown> | undefined;
    return row ? mapRow(row) : null;
  }

  /**
   * 矛盾检测候选：同 workspace 同 kind 的 active 条目中与给定内容互含（任一方向包含）者。
   * SQL 侧仅作粗筛（content 列含 LIKE 通配符时可能过匹配，不漏配），精确判定由调用方
   * 用字符串 includes 复核（02 §7.4 归一化互含）。
   */
  async findSimilar(
    workspaceId: string,
    kind: MemoryKind,
    normalizedContent: string,
    excludeId?: string,
  ): Promise<MemoryEntry[]> {
    const where = [
      "workspace_id = ?",
      "kind = ?",
      "status = 'active'",
      "(content LIKE '%' || ? || '%' ESCAPE '\\' OR ? LIKE '%' || content || '%')",
    ];
    const params: string[] = [workspaceId, kind, escapeLike(normalizedContent), normalizedContent];
    if (excludeId !== undefined) {
      where.push("id != ?");
      params.push(excludeId);
    }
    const rows = this.db
      .prepare(`SELECT ${ROW_COLUMNS} FROM memory_entries WHERE ${where.join(" AND ")}`)
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map(mapRow);
  }

  /**
   * FTS 召回（05 §5.4 第一条 SQL）：trigram 倒排 + bm25 排序 + 默认召回集过滤。
   * matchQuery 须由调用方安全化为 phrase 查询（整串包双引号 + 内部引号双写）。
   */
  async searchFts(
    workspaceId: string,
    matchQuery: string,
    kind?: MemoryKind,
    limit = 10,
  ): Promise<MemoryEntry[]> {
    const where = ["memory_fts MATCH ?", "e.workspace_id = ?", "e.status = 'active'", "e.confidence >= ?"];
    const params: Array<string | number> = [matchQuery, workspaceId, MEMORY_RECALL_MIN_CONFIDENCE];
    if (kind !== undefined) {
      where.push("e.kind = ?");
      params.push(kind);
    }
    params.push(limit);
    const rows = this.db
      .prepare(
        `SELECT ${FTS_ROW_COLUMNS}
         FROM memory_fts f
         JOIN memory_entries e ON e.rowid = f.rowid
         WHERE ${where.join(" AND ")}
         ORDER BY bm25(memory_fts)
         LIMIT ?`,
      )
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map(mapRow);
  }

  /** LIKE 兜底（05 §5.4 第二条 SQL）：短查询（<3 字符）或 FTS 空结果时启用，last_seen_at DESC。 */
  async searchLike(
    workspaceId: string,
    query: string,
    kind?: MemoryKind,
    limit = 10,
  ): Promise<MemoryEntry[]> {
    const where = [
      "workspace_id = ?",
      "status = 'active'",
      "confidence >= ?",
      "content LIKE '%' || ? || '%' ESCAPE '\\'",
    ];
    const params: Array<string | number> = [workspaceId, MEMORY_RECALL_MIN_CONFIDENCE, escapeLike(query)];
    if (kind !== undefined) {
      where.push("kind = ?");
      params.push(kind);
    }
    params.push(limit);
    const rows = this.db
      .prepare(
        `SELECT ${ROW_COLUMNS} FROM memory_entries
         WHERE ${where.join(" AND ")}
         ORDER BY last_seen_at DESC
         LIMIT ?`,
      )
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map(mapRow);
  }

  /**
   * 管理分页（06 §2.6 memory.entries.list）：不过滤 confidence/status；
   * workspaceId 缺省 = 跨 workspace 全量；keyset 游标 (last_seen_at, id) DESC。
   */
  async list(
    workspaceId?: string,
    filter: MemoryListFilter = {},
  ): Promise<{ items: MemoryEntry[]; nextCursor?: string }> {
    const limit = Math.min(Math.max(filter.limit ?? DEFAULT_PAGE_LIMIT, 1), MAX_PAGE_LIMIT);
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (workspaceId !== undefined) {
      where.push("workspace_id = ?");
      params.push(workspaceId);
    }
    if (filter.kind !== undefined) {
      where.push("kind = ?");
      params.push(filter.kind);
    }
    if (filter.source !== undefined) {
      where.push("source = ?");
      params.push(filter.source);
    }
    if (filter.since !== undefined) {
      where.push("last_seen_at >= ?");
      params.push(filter.since);
    }
    const cursor = filter.cursor !== undefined ? decodeCursor(filter.cursor) : null;
    if (cursor) {
      where.push("(last_seen_at < ? OR (last_seen_at = ? AND id < ?))");
      params.push(cursor.lastSeenAt, cursor.lastSeenAt, cursor.id);
    }
    const whereSql = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT ${ROW_COLUMNS} FROM memory_entries${whereSql}
         ORDER BY last_seen_at DESC, id DESC LIMIT ?`,
      )
      .all(...params, limit + 1) as Array<Record<string, unknown>>;
    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map(mapRow);
    const last = items[items.length - 1];
    return { items, nextCursor: hasMore && last ? encodeCursor(last) : undefined };
  }
}
