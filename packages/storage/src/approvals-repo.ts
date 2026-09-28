/**
 * ApprovalsRepo：approvals 表薄 repo 层（05-database §3.7 DDL 逐字段对齐）。
 * 审批单未决态真源：pending 行由审批超时器置 expired（120s，02 §6.4）；
 * 恢复会话时未决审批重新弹出（02 §6.4，经 listPending 供 snapshot.pendingApprovals）。
 */
import type { SqliteDatabase } from "./db.js";

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "cancelled";
export type ApprovalResponse = "allow" | "deny" | "always";

/** approvals 行投影（camelCase，与表列一一对应，05 §3.7）。 */
export interface ApprovalRow {
  grantId: string;
  sessionId: string;
  workspaceId: string;
  toolName: string;
  /** 审批时归一化输入快照（approve-what-runs；已脱敏 JSON 字符串）。 */
  inputSnapshot: string;
  status: ApprovalStatus;
  response: ApprovalResponse | null;
  timeoutAt: number;
  createdAt: number;
  respondedAt: number | null;
}

export interface ApprovalCreateInput {
  grantId: string;
  sessionId: string;
  workspaceId: string;
  toolName: string;
  inputSnapshot: string;
  timeoutAt: number;
  ts?: number;
}

export interface ApprovalResolveInput {
  status: Exclude<ApprovalStatus, "pending">;
  response: ApprovalResponse | null;
  respondedAt?: number;
}

const ROW_COLUMNS = [
  "grant_id AS grantId",
  "session_id AS sessionId",
  "workspace_id AS workspaceId",
  "tool_name AS toolName",
  "input_snapshot AS inputSnapshot",
  "status",
  "response",
  "timeout_at AS timeoutAt",
  "created_at AS createdAt",
  "responded_at AS respondedAt",
].join(", ");

function mapRow(row: Record<string, unknown>): ApprovalRow {
  return {
    grantId: row["grantId"] as string,
    sessionId: row["sessionId"] as string,
    workspaceId: row["workspaceId"] as string,
    toolName: row["toolName"] as string,
    inputSnapshot: row["inputSnapshot"] as string,
    status: row["status"] as ApprovalStatus,
    response: (row["response"] as ApprovalResponse | null) ?? null,
    timeoutAt: row["timeoutAt"] as number,
    createdAt: row["createdAt"] as number,
    respondedAt: (row["respondedAt"] as number | null) ?? null,
  };
}

export class ApprovalsRepo {
  constructor(private readonly db: SqliteDatabase) {}

  async create(input: ApprovalCreateInput): Promise<void> {
    const ts = input.ts ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO approvals (grant_id, session_id, workspace_id, tool_name, input_snapshot, status, response, timeout_at, created_at, responded_at)
         VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, ?, NULL)`,
      )
      .run(input.grantId, input.sessionId, input.workspaceId, input.toolName, input.inputSnapshot, input.timeoutAt, ts);
  }

  async get(grantId: string): Promise<ApprovalRow | null> {
    const row = this.db.prepare(`SELECT ${ROW_COLUMNS} FROM approvals WHERE grant_id = ?`).get(grantId) as
      | Record<string, unknown>
      | undefined;
    return row ? mapRow(row) : null;
  }

  /** 终态收敛：approved/denied/expired/cancelled（幂等——重复收敛仅更新已 pending 行）。 */
  async resolve(grantId: string, patch: ApprovalResolveInput): Promise<void> {
    this.db
      .prepare(
        `UPDATE approvals SET status = ?, response = ?, responded_at = ? WHERE grant_id = ? AND status = 'pending'`,
      )
      .run(patch.status, patch.response, patch.respondedAt ?? Date.now(), grantId);
  }

  /** 未决审批（02 §6.4：恢复会话时重新弹出的数据源）。 */
  async listPending(filter: { sessionId?: string } = {}): Promise<ApprovalRow[]> {
    const where = ["status = 'pending'"];
    const params: string[] = [];
    if (filter.sessionId !== undefined) {
      where.push("session_id = ?");
      params.push(filter.sessionId);
    }
    const sql = `SELECT ${ROW_COLUMNS} FROM approvals WHERE ${where.join(" AND ")} ORDER BY created_at ASC`;
    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map(mapRow);
  }
}
