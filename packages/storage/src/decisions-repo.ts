/**
 * DecisionsRepo：permission_decisions 表薄 repo 层（05-database §3.8 DDL 逐字段对齐）。
 * 追加型审计（append-only），无外键（审计生命周期独立于会话/workspace 清理）。
 */
import type { CollaborationMode } from "@raincode/shared";
import type { SqliteDatabase } from "./db.js";
import type { MatchedBy, PermissionDecision } from "@raincode/shared";

export type AuditMode = CollaborationMode;

/** permission_decisions 行投影（camelCase，与表列一一对应，05 §3.8）。 */
export interface PermissionDecisionRow {
  id: number;
  ts: number;
  sessionId: string;
  workspaceId: string;
  toolName: string;
  mode: AuditMode;
  decision: PermissionDecision;
  matchedBy: MatchedBy;
  ruleId: string | null;
  grantId: string | null;
  reason: string;
  inputDigest: string;
  respondLatencyMs: number | null;
  detailJson: string | null;
}

export interface DecisionAppendInput {
  ts?: number;
  sessionId: string;
  workspaceId: string;
  toolName: string;
  mode: AuditMode;
  decision: PermissionDecision;
  matchedBy: MatchedBy;
  ruleId?: string | null;
  grantId?: string | null;
  reason?: string;
  /** 已脱敏的归一化输入摘要（脱敏归 AuditLogger，repo 不二次处理）。 */
  inputDigest?: string;
  respondLatencyMs?: number | null;
  detailJson?: string | null;
}

export interface DecisionListFilter {
  sessionId?: string;
  toolName?: string;
  decision?: PermissionDecision;
  since?: number;
  limit?: number;
  offset?: number;
}

const ROW_COLUMNS = [
  "id",
  "ts",
  "session_id AS sessionId",
  "workspace_id AS workspaceId",
  "tool_name AS toolName",
  "mode",
  "decision",
  "matched_by AS matchedBy",
  "rule_id AS ruleId",
  "grant_id AS grantId",
  "reason",
  "input_digest AS inputDigest",
  "respond_latency_ms AS respondLatencyMs",
  "detail_json AS detailJson",
].join(", ");

function mapRow(row: Record<string, unknown>): PermissionDecisionRow {
  return {
    id: row["id"] as number,
    ts: row["ts"] as number,
    sessionId: row["sessionId"] as string,
    workspaceId: row["workspaceId"] as string,
    toolName: row["toolName"] as string,
    mode: row["mode"] as AuditMode,
    decision: row["decision"] as PermissionDecision,
    matchedBy: row["matchedBy"] as MatchedBy,
    ruleId: (row["ruleId"] as string | null) ?? null,
    grantId: (row["grantId"] as string | null) ?? null,
    reason: row["reason"] as string,
    inputDigest: row["inputDigest"] as string,
    respondLatencyMs: (row["respondLatencyMs"] as number | null) ?? null,
    detailJson: (row["detailJson"] as string | null) ?? null,
  };
}

export class DecisionsRepo {
  constructor(private readonly db: SqliteDatabase) {}

  /** 追加一条审计（append-only；rowid 自增主键）。 */
  async append(input: DecisionAppendInput): Promise<{ id: number }> {
    const ts = input.ts ?? Date.now();
    const result = this.db
      .prepare(
        `INSERT INTO permission_decisions
           (ts, session_id, workspace_id, tool_name, mode, decision, matched_by,
            rule_id, grant_id, reason, input_digest, respond_latency_ms, detail_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ts,
        input.sessionId,
        input.workspaceId,
        input.toolName,
        input.mode,
        input.decision,
        input.matchedBy,
        input.ruleId ?? null,
        input.grantId ?? null,
        input.reason ?? "",
        input.inputDigest ?? "",
        input.respondLatencyMs ?? null,
        input.detailJson ?? null,
        ts,
      );
    return { id: Number(result.lastInsertRowid) };
  }

  /** 按 ts 倒序（最新在前）；limit 缺省 50、上限 200（06 §2.0 分页约定）。 */
  async list(filter: DecisionListFilter = {}): Promise<PermissionDecisionRow[]> {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filter.sessionId !== undefined) {
      where.push("session_id = ?");
      params.push(filter.sessionId);
    }
    if (filter.toolName !== undefined) {
      where.push("tool_name = ?");
      params.push(filter.toolName);
    }
    if (filter.decision !== undefined) {
      where.push("decision = ?");
      params.push(filter.decision);
    }
    if (filter.since !== undefined) {
      where.push("ts >= ?");
      params.push(filter.since);
    }
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const offset = Math.max(filter.offset ?? 0, 0);
    const sql = `SELECT ${ROW_COLUMNS} FROM permission_decisions${
      where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""
    } ORDER BY ts DESC, id DESC LIMIT ${limit} OFFSET ${offset}`;
    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map(mapRow);
  }
}
