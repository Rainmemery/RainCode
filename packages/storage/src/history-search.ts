/**
 * 会话历史检索（T5.3，05-database §3.12/§5.4）：part 级 trigram FTS（文本块 + 工具名）。
 *
 * 索引形态（versioned 增量迁移，02 §7「检索结果与模型所见一致」的真源面）：
 * - history_parts/history_fts 为派生索引，正文真源仍是各会话 events.jsonl（05 §1.2）；
 * - 检索前对目标 workspace 的全部会话做**增量回填**：自 settings 键 history.idx.<sessionId>
 *   记录的上次扫描字节偏移续扫新增 message 行（部分尾行不推进偏移），插入缺失 part；
 * - INDEX_VERSION 变更（未来索引口径调整）→ 旧 part 整会话删除重扫；INSERT OR IGNORE +
 *   UNIQUE(session_id, seq, part_index) 使重扫/并发回填天然幂等；
 * - 触发器同步 FTS 倒排（同 memory_fts §5.3 形态），本仓库是唯一写入方。
 *
 * 查询形态（05 §5.4）：查询按空白切词、每词包双引号 phrase（内部引号双写转义，防 FTS5
 * 语法注入）、词间 OR——多词查询召回部分匹配并由 bm25 排序，再经**相对分数地板**裁剪：
 * 3x 过取样后仅保留 |bm25| ≥ top×0.15 的命中（BM25 绝对阈值随语料尺寸漂移不可用，
 * MiMo-Code 调研经验）；<3 code point 或 FTS 空结果 → LIKE 兜底（ts DESC，同 memory 召回口径）。
 */
import { open } from "node:fs/promises";
import type { MessageRecord } from "@raincode/shared";
import type { SqliteDatabase } from "./db.js";
import { parseLine } from "./jsonl-lines.js";
import { sessionPaths } from "./paths.js";
import type { SessionsRepo } from "./sessions-repo.js";
import type { SettingsRepo } from "./settings-repo.js";

/** 索引口径版本（变更即全量重扫；进度 JSON 的 v 字段）。 */
export const HISTORY_INDEX_VERSION = 1;

/** 增量进度 settings 键前缀（值 JSON：{v, offset}）。 */
const PROGRESS_KEY_PREFIX = "history.idx.";

/** 相对分数地板：保留 |bm25| ≥ top×0.15 的命中（调研 §2.1 MiMo 经验值）。 */
export const RELATIVE_SCORE_FLOOR = 0.15;

/** FTS 过取样倍数（先取 limit×3 候选再按地板裁剪）。 */
const OVERSAMPLE_FACTOR = 3;

/** 检索缺省/上限（session_search 工具与未来 RPC 共用）。 */
export const HISTORY_SEARCH_DEFAULT_LIMIT = 8;
const HISTORY_SEARCH_MAX_LIMIT = 50;

export type HistoryPartKind = "text" | "tool";

export interface HistorySearchHit {
  sessionId: string;
  seq: number;
  role: string;
  kind: HistoryPartKind;
  /** 命中正文（text：块正文；tool：工具名）。 */
  content: string;
  ts: number;
  /** 相对分（|bm25| / top|bm25|，1.0 = 最优）；LIKE 兜底命中无 bm25 → null。 */
  score: number | null;
}

export interface HistorySearchOptions {
  limit?: number;
  /**
   * 排除会话（session_search 传入当前会话 id）：当前会话全文已在模型上下文中，检索只面向
   * 历史会话——自指命中（当前输入本身匹配查询）会以短文本优势占据 top 位，属纯噪声。
   * 已知取舍：compact 后同会话早期原文不再可经本 API 召回（摘要保留要点，M6 可议开关）。
   */
  excludeSessionId?: string;
}

function isEnoent(reason: unknown): boolean {
  return reason instanceof Error && (reason as NodeJS.ErrnoException).code === "ENOENT";
}

interface IndexProgress {
  v: number;
  offset: number;
}

function parseProgress(raw: string | null): IndexProgress {
  if (raw === null) {
    return { v: 0, offset: 0 };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as IndexProgress).v === "number" &&
      typeof (parsed as IndexProgress).offset === "number"
    ) {
      return parsed as IndexProgress;
    }
  } catch {
    // 损坏进度按未索引处理：自 0 重扫，OR IGNORE 幂等去重
  }
  return { v: 0, offset: 0 };
}

/** 查询 → FTS5 match 串：按空白切词、逐词 phrase 转义、词间 OR；全空白 → null。 */
export function toHistoryFtsQuery(query: string): string | null {
  const words = query.split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) {
    return null;
  }
  return words.map((word) => `"${word.replaceAll('"', '""')}"`).join(" OR ");
}

/** LIKE 模式转义：\ % _ 前置反斜杠（同 memory-repo 口径）。 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** message 行 → 索引 part 列表（文本块 + tool_call 名；tool_result/reasoning/空文本不入索引）。 */
export function historyPartsOfMessage(message: MessageRecord): Array<{ kind: HistoryPartKind; content: string }> {
  const parts: Array<{ kind: HistoryPartKind; content: string }> = [];
  if (typeof message.content === "string") {
    if (message.content.trim().length > 0) {
      parts.push({ kind: "text", content: message.content });
    }
    return parts;
  }
  for (const block of message.content) {
    if (block.type === "text" && block.text.trim().length > 0) {
      parts.push({ kind: "text", content: block.text });
    } else if (block.type === "tool_call" && block.name.length > 0) {
      parts.push({ kind: "tool", content: block.name });
    }
  }
  return parts;
}

/** 单会话增量扫描结果。 */
interface SessionScan {
  lines: string[];
  nextOffset: number;
}

/**
 * 自 offset 增量读取完整行（Buffer 层 0x0A 分界，多字节安全；未完尾行不推进偏移）。
 * 文件缺失 → null（跳过）；文件短于记录偏移（外部截断）→ 自 0 重扫（幂等去重兜底）。
 */
async function scanEventsFileFrom(file: string, offset: number): Promise<SessionScan | null> {
  let handle;
  try {
    handle = await open(file, "r");
  } catch (reason: unknown) {
    if (isEnoent(reason)) {
      return null;
    }
    throw reason;
  }
  try {
    const size = (await handle.stat()).size;
    const start = size < offset ? 0 : offset;
    if (size <= start) {
      return { lines: [], nextOffset: start };
    }
    const chunk = Buffer.alloc(size - start);
    await handle.read(chunk, 0, chunk.length, start);
    const lines: string[] = [];
    let consumed = 0;
    for (;;) {
      const nl = chunk.indexOf(0x0a, consumed);
      if (nl < 0) {
        break;
      }
      lines.push(chunk.subarray(consumed, nl).toString("utf8"));
      consumed = nl + 1;
    }
    return { lines, nextOffset: start + consumed };
  } finally {
    await handle.close();
  }
}

export class HistorySearchRepo {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly dataRoot: string,
    private readonly sessions: SessionsRepo,
    private readonly settings: SettingsRepo,
  ) {}

  /** 单会话已索引 part 数（诊断/测试断言增量不重复）。 */
  async partCount(sessionId: string): Promise<number> {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM history_parts WHERE session_id = ?")
      .get(sessionId) as { n: number };
    return row.n;
  }

  /**
   * 目标 workspace 全部会话增量回填后检索（part 级 FTS + 分数地板；<3 字/空结果 LIKE 兜底）。
   * 无命中返回空数组，不注入占位文本（同 memory 召回口径 02 §7.4）。
   */
  async search(workspaceId: string, query: string, opts: HistorySearchOptions = {}): Promise<HistorySearchHit[]> {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      return [];
    }
    const limit = Math.min(Math.max(opts.limit ?? HISTORY_SEARCH_DEFAULT_LIMIT, 1), HISTORY_SEARCH_MAX_LIMIT);
    await this.catchUpWorkspace(workspaceId);

    const matchQuery = toHistoryFtsQuery(trimmed);
    if (matchQuery !== null && Array.from(trimmed).length >= 3) {
      const hits = await this.searchFts(workspaceId, matchQuery, limit, opts.excludeSessionId);
      if (hits.length > 0) {
        return hits;
      }
    }
    return this.searchLike(workspaceId, trimmed, limit, opts.excludeSessionId);
  }

  /** 增量回填：workspace 全部会话自记录偏移续扫（INDEX_VERSION 变更整会话重扫）。 */
  private async catchUpWorkspace(workspaceId: string): Promise<void> {
    const metas = await this.sessions.list({ workspaceHash: workspaceId });
    for (const meta of metas) {
      await this.catchUpSession(workspaceId, meta.id);
    }
  }

  private async catchUpSession(workspaceId: string, sessionId: string): Promise<void> {
    const key = `${PROGRESS_KEY_PREFIX}${sessionId}`;
    const progress = parseProgress(await this.settings.get(key));
    const stale = progress.v !== HISTORY_INDEX_VERSION;
    const file = sessionPaths(this.dataRoot, workspaceId, sessionId).eventsFile;
    const scan = await scanEventsFileFrom(file, stale ? 0 : progress.offset);
    if (scan === null) {
      return; // 事件文件缺失（外部清理）：跳过，不推进进度
    }
    if (scan.lines.length === 0 && !stale) {
      return; // 无新字节：零写入快路径
    }
    if (stale) {
      this.db.prepare("DELETE FROM history_parts WHERE session_id = ?").run(sessionId);
    }
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO history_parts (session_id, workspace_id, seq, part_index, kind, role, content, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const apply = this.db.transaction((lines: string[]) => {
      for (const raw of lines) {
        const parsed = parseLine(raw);
        if (!parsed.ok || parsed.line.type !== "message") {
          continue;
        }
        const { message, seq, ts } = parsed.line;
        const parts = historyPartsOfMessage(message);
        parts.forEach((part, partIndex) => {
          insert.run(sessionId, workspaceId, seq, partIndex, part.kind, message.role, part.content, ts);
        });
      }
    });
    apply(scan.lines);
    await this.settings.set(key, JSON.stringify({ v: HISTORY_INDEX_VERSION, offset: scan.nextOffset } satisfies IndexProgress));
  }

  /** FTS 检索：3x 过取样 → 相对分数地板裁剪（|bm25| ≥ top×0.15）→ 截断 limit。 */
  private async searchFts(
    workspaceId: string,
    matchQuery: string,
    limit: number,
    excludeSessionId?: string,
  ): Promise<HistorySearchHit[]> {
    const where = ["history_fts MATCH ?", "p.workspace_id = ?"];
    const params: Array<string | number> = [matchQuery, workspaceId];
    if (excludeSessionId !== undefined) {
      where.push("p.session_id != ?");
      params.push(excludeSessionId);
    }
    params.push(limit * OVERSAMPLE_FACTOR);
    const rows = this.db
      .prepare(
        `SELECT p.session_id AS sessionId, p.seq, p.role, p.kind, p.content, p.ts,
                bm25(history_fts) AS bm25
         FROM history_fts f
         JOIN history_parts p ON p.id = f.rowid
         WHERE ${where.join(" AND ")}
         ORDER BY bm25
         LIMIT ?`,
      )
      .all(...params) as Array<Record<string, unknown>>;
    if (rows.length === 0) {
      return [];
    }
    const top = Math.abs(rows[0]!["bm25"] as number);
    const floor = top * RELATIVE_SCORE_FLOOR;
    const hits: HistorySearchHit[] = [];
    for (const row of rows) {
      if (hits.length >= limit) {
        break;
      }
      const magnitude = Math.abs(row["bm25"] as number);
      if (magnitude < floor) {
        continue;
      }
      hits.push({
        sessionId: row["sessionId"] as string,
        seq: row["seq"] as number,
        role: row["role"] as string,
        kind: row["kind"] as HistoryPartKind,
        content: row["content"] as string,
        ts: row["ts"] as number,
        score: top > 0 ? magnitude / top : 1,
      });
    }
    return hits;
  }

  /** LIKE 兜底（05 §5.4 第二条 SQL 同口径）：短查询或 FTS 空结果，ts DESC。 */
  private async searchLike(
    workspaceId: string,
    query: string,
    limit: number,
    excludeSessionId?: string,
  ): Promise<HistorySearchHit[]> {
    const where = ["workspace_id = ?", "content LIKE '%' || ? || '%' ESCAPE '\\'"];
    const params: Array<string | number> = [workspaceId, escapeLike(query)];
    if (excludeSessionId !== undefined) {
      where.push("session_id != ?");
      params.push(excludeSessionId);
    }
    params.push(limit);
    const rows = this.db
      .prepare(
        `SELECT session_id AS sessionId, seq, role, kind, content, ts
         FROM history_parts
         WHERE ${where.join(" AND ")}
         ORDER BY ts DESC, id DESC
         LIMIT ?`,
      )
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      sessionId: row["sessionId"] as string,
      seq: row["seq"] as number,
      role: row["role"] as string,
      kind: row["kind"] as HistoryPartKind,
      content: row["content"] as string,
      ts: row["ts"] as number,
      score: null,
    }));
  }
}
