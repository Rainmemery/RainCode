/**
 * RulesRepo：permission_rules 表薄 repo 层（05-database §3.6 DDL 逐字段对齐）。
 * 同步 SQLite 内核、对外一律 async（04 §2.1）；SQL 全部收敛在本包内（04 §2.4 铁律 2）。
 * 只承载 scope=project/global（session 规则驻内存不入库，02 §6.2 / 05 §9 差异 4）。
 */
import type { RuleBehavior } from "@raincode/shared";
import type { SqliteDatabase } from "./db.js";
import { StorageError } from "./errors.js";
import { ulid } from "./ulid.js";

export type PersistedRuleScope = "project" | "global";
export type RuleSource = "user" | "allow-always" | "import";

/** permission_rules 行投影（camelCase，与表列一一对应，05 §3.6）。 */
export interface PermissionRuleRow {
  id: string;
  scope: PersistedRuleScope;
  /** project 必填；global 为 null（CHECK ((scope='project') = (workspace_id IS NOT NULL))）。 */
  workspaceId: string | null;
  tool: string;
  /** null = 匹配该工具全部调用。 */
  pattern: string | null;
  behavior: RuleBehavior;
  source: RuleSource;
  createdAt: number;
}

export interface RuleAddInput {
  scope: PersistedRuleScope;
  /** project 必填；global 传 null。 */
  workspaceId: string | null;
  tool: string;
  pattern?: string | null;
  behavior: RuleBehavior;
  source: RuleSource;
  ts?: number;
}

export interface RuleListFilter {
  scope?: PersistedRuleScope;
  /** project 规则的 workspace 过滤；global 规则忽略该条件。 */
  workspaceId?: string | null;
  tool?: string;
}

const ROW_COLUMNS = [
  "id",
  "scope",
  "workspace_id AS workspaceId",
  "tool",
  "pattern",
  "behavior",
  "source",
  "created_at AS createdAt",
].join(", ");

function mapRow(row: Record<string, unknown>): PermissionRuleRow {
  return {
    id: row["id"] as string,
    scope: row["scope"] as PersistedRuleScope,
    workspaceId: (row["workspaceId"] as string | null) ?? null,
    tool: row["tool"] as string,
    pattern: (row["pattern"] as string | null) ?? null,
    behavior: row["behavior"] as RuleBehavior,
    source: row["source"] as RuleSource,
    createdAt: row["createdAt"] as number,
  };
}

export class RulesRepo {
  constructor(private readonly db: SqliteDatabase) {}

  async add(input: RuleAddInput): Promise<PermissionRuleRow> {
    const ts = input.ts ?? Date.now();
    const id = `rule_${ulid(ts)}`;
    try {
      this.db
        .prepare(
          `INSERT INTO permission_rules (id, scope, workspace_id, tool, pattern, behavior, source, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.scope,
          input.workspaceId,
          input.tool,
          input.pattern ?? null,
          input.behavior,
          input.source,
          ts,
        );
    } catch (reason: unknown) {
      // ux_rules_scope 唯一冲突：同 scope+workspace+tool+pattern 规则已存在（05 §3.6 防重复）
      if (reason instanceof Error && reason.message.includes("UNIQUE")) {
        throw new StorageError(
          "PERM_RULE_CONFLICT",
          `permission rule already exists: scope=${input.scope} tool=${input.tool} pattern=${String(input.pattern ?? "")}`,
        );
      }
      throw reason;
    }
    const created = await this.get(id);
    if (!created) {
      throw new Error(`[INTERNAL] permission rule insert failed: ${id}`);
    }
    return created;
  }

  /** 精确过滤（scope / workspaceId / tool 独立 AND 组合；组合查询由调用方分次或叠加）。 */
  async list(filter: RuleListFilter = {}): Promise<PermissionRuleRow[]> {
    const where: string[] = [];
    const params: Array<string | number | null> = [];
    if (filter.scope !== undefined) {
      where.push("scope = ?");
      params.push(filter.scope);
    }
    if (filter.workspaceId !== undefined) {
      where.push("workspace_id = ?");
      params.push(filter.workspaceId);
    }
    if (filter.tool !== undefined) {
      where.push("tool = ?");
      params.push(filter.tool);
    }
    const sql = `SELECT ${ROW_COLUMNS} FROM permission_rules${
      where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""
    } ORDER BY created_at ASC`;
    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map(mapRow);
  }

  async get(id: string): Promise<PermissionRuleRow | null> {
    const row = this.db.prepare(`SELECT ${ROW_COLUMNS} FROM permission_rules WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? mapRow(row) : null;
  }

  /** 即时生效（02 §6.4：allow-always 误授权的撤销入口）。返回是否存在。 */
  async remove(id: string): Promise<boolean> {
    const result = this.db.prepare("DELETE FROM permission_rules WHERE id = ?").run(id);
    return result.changes > 0;
  }
}
