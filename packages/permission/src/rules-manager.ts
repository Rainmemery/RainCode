/**
 * RulesManager：规则管理（session 驻内存 / project、global 走 SQLite permission_rules）。
 * 「始终允许」从审批选项落库为对应 scope 规则（02 §6.2 审批闭环 allow-always 分支）；
 * removeRule 即时生效（02 §6.4 误授权撤销入口）。
 *
 * 偏差注记：matchType 为任务交付扩展字段（02 §6.3 / 05 §3.6 未定义）；
 * DDL 逐字段对齐优先，非 wildcard matchType 仅会话内存态保真，落库规则按 wildcard 求值。
 */
import { ulid } from "@raincode/storage";
import type { PermissionRule, RuleBehavior, RuleScope } from "@raincode/shared";
import { StorageError } from "@raincode/storage";
import type { PermissionRuleRow, RulesRepo, RuleSource } from "@raincode/storage";
import { PC_ERROR_CODES, PermissionError } from "./errors.js";
import type { RuleMatchType } from "@raincode/shared";

export interface RuleAddInput {
  scope: RuleScope;
  tool: string;
  pattern?: string | null;
  matchType?: RuleMatchType;
  behavior: RuleBehavior;
  source: RuleSource;
  /** scope=session 必填（会话规则的归属会话）。 */
  sessionId?: string;
  /** scope=project 缺省时取管理器默认工作区（server 注入首个会话的 workspaceHash）。 */
  workspaceId?: string | null;
  ts?: number;
}

export interface RulesManagerOptions {
  repo: RulesRepo;
  /** project 规则的默认工作区解析（缺省无上下文 → project 规则拒绝新增）。 */
  defaultWorkspaceId?: () => string | null;
  onDiagnostic?: (message: string, err?: unknown) => void;
}

export class RulesManager {
  /** sessionId → 会话规则（内存态，会话期有效，02 §6.2 判定链第 3 级载体）。 */
  private readonly sessionRules = new Map<string, PermissionRule[]>();

  constructor(private readonly options: RulesManagerOptions) {}

  async addRule(input: RuleAddInput): Promise<PermissionRule> {
    if ((input.pattern !== undefined && input.pattern !== null) && input.tool !== "bash") {
      // 非 bash 工具误配 bash 语法规则 → 规则校验期拒绝（02 §6.4）
      throw new PermissionError(
        PC_ERROR_CODES.RULE_INVALID,
        `pattern is only meaningful for the bash evaluator (tool=${input.tool})`,
      );
    }
    if (input.matchType === "regex" && input.pattern !== undefined && input.pattern !== null) {
      try {
        void new RegExp(input.pattern);
      } catch (reason: unknown) {
        throw new PermissionError(
          PC_ERROR_CODES.RULE_INVALID,
          `invalid regex pattern: ${String(reason instanceof Error ? reason.message : reason)}`,
        );
      }
    }

    if (input.scope === "session") {
      if (input.sessionId === undefined || input.sessionId.length === 0) {
        throw new PermissionError(PC_ERROR_CODES.RULE_INVALID, "session rules require a sessionId");
      }
      return this.addSessionRule(input);
    }
    const scope: "project" | "global" = input.scope === "global" ? "global" : "project";
    return this.addPersistedRule({ ...input, scope });
  }

  /** 先查会话内存，再查 SQLite（project/global）；均无 → PC_RULE_NOT_FOUND。 */
  async removeRule(id: string): Promise<void> {
    for (const rules of this.sessionRules.values()) {
      const index = rules.findIndex((rule) => rule.id === id);
      if (index >= 0) {
        rules.splice(index, 1);
        return;
      }
    }
    const removed = await this.options.repo.remove(id);
    if (!removed) {
      throw new PermissionError(PC_ERROR_CODES.RULE_NOT_FOUND, `permission rule not found: ${id}`);
    }
  }

  /** 列出规则：会话（全部内存规则）+ project/global（P0 单工作区场景跨 workspace 全量）。 */
  async listRules(filter: { scope?: RuleScope; tool?: string } = {}): Promise<PermissionRule[]> {
    const result: PermissionRule[] = [];
    if (filter.scope === undefined || filter.scope === "session") {
      for (const rules of this.sessionRules.values()) {
        for (const rule of rules) {
          if (filter.tool === undefined || rule.tool === filter.tool) {
            result.push(rule);
          }
        }
      }
    }
    if (filter.scope === undefined || filter.scope === "project" || filter.scope === "global") {
      const rows = await this.options.repo.list({
        ...(filter.scope !== undefined && { scope: filter.scope }),
        ...(filter.tool !== undefined && { tool: filter.tool }),
      });
      for (const row of rows) {
        result.push(rowToRule(row));
      }
    }
    return result.sort((a, b) => a.createdAt - b.createdAt);
  }

  /** 判定链第 3 级数据源：会话内存规则。 */
  sessionRulesOf(sessionId: string): PermissionRule[] {
    return this.sessionRules.get(sessionId) ?? [];
  }

  /** 判定链第 4/5 级数据源：SQLite 持久规则。 */
  async persistedRules(scope: "project" | "global", workspaceId: string | null): Promise<PermissionRule[]> {
    const rows = await this.options.repo.list({
      scope,
      ...(scope === "project" && workspaceId !== null && { workspaceId }),
    });
    return rows.map(rowToRule);
  }

  /** 会话结束归档时的内存清理钩子（server 会话关闭时调用）。 */
  dropSession(sessionId: string): void {
    this.sessionRules.delete(sessionId);
  }

  // ---------------------------------------------------------------------------

  private addSessionRule(input: RuleAddInput): PermissionRule {
    const bucket = this.sessionRules.get(input.sessionId!) ?? [];
    const existing = bucket.find(
      (rule) =>
        rule.tool === input.tool &&
        rule.pattern === (input.pattern ?? null) &&
        (rule.matchType ?? "wildcard") === (input.matchType ?? "wildcard") &&
        rule.behavior === input.behavior,
    );
    if (existing !== undefined) {
      return existing; // 幂等：同键会话规则复用
    }
    const rule: PermissionRule = {
      id: `rule_${ulid(input.ts ?? Date.now())}`,
      scope: "session",
      tool: input.tool,
      pattern: input.pattern ?? null,
      ...(input.matchType !== undefined && { matchType: input.matchType }),
      behavior: input.behavior,
      source: input.source,
      createdAt: input.ts ?? Date.now(),
    };
    bucket.push(rule);
    this.sessionRules.set(input.sessionId!, bucket);
    return rule;
  }

  private async addPersistedRule(
    input: Omit<RuleAddInput, "scope"> & { scope: "project" | "global" },
  ): Promise<PermissionRule> {
    let workspaceId: string | null = null;
    if (input.scope === "project") {
      workspaceId = input.workspaceId ?? this.options.defaultWorkspaceId?.() ?? null;
      if (workspaceId === null) {
        throw new PermissionError(
          PC_ERROR_CODES.RULE_INVALID,
          "project rules require a workspace context (create a session first)",
        );
      }
    }
    try {
      const row = await this.options.repo.add({
        scope: input.scope,
        workspaceId,
        tool: input.tool,
        pattern: input.pattern ?? null,
        behavior: input.behavior,
        source: input.source,
        ...(input.ts !== undefined && { ts: input.ts }),
      });
      return rowToRule(row);
    } catch (reason: unknown) {
      if (reason instanceof StorageError && reason.code === "PERM_RULE_CONFLICT") {
        // 唯一索引冲突 → 幂等返回既有规则（同键规则复用，05 §3.6 ux_rules_scope）
        const rows = await this.options.repo.list({
          scope: input.scope,
          tool: input.tool,
        });
        const match = rows.find((row) => row.pattern === (input.pattern ?? null));
        if (match !== undefined) {
          return rowToRule(match);
        }
      }
      throw reason;
    }
  }
}

function rowToRule(row: PermissionRuleRow): PermissionRule {
  return {
    id: row.id,
    scope: row.scope,
    tool: row.tool,
    pattern: row.pattern,
    behavior: row.behavior,
    source: row.source,
    createdAt: row.createdAt,
  };
}
