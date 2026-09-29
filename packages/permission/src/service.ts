/**
 * PermissionService：五级判定链（02-module-design §6.2，首个命中生效）：
 *   1 工具 metadata（readOnly 快速通道 / bash 只读白名单）
 *   2 协作模式（plan 写类 deny / auto-accept workspace 内 allow）
 *   3 会话规则（内存）→ 4 项目规则 → 5 全局规则（层级内 deny > ask > allow，同行为取最新）
 *   兜底 default ask → ApprovalBroker 审批闭环（超时按 deny 收敛）。
 * bash 命令级求值：链式分段逐段匹配取最严；高危根命令禁止被通配规则 allow（02 §6.4）。
 */
import type {
  MatchedBy,
  PermissionDecision,
  PermissionRule,
  RuleScope,
  ToolMetadataSummary,
} from "@raincode/shared";
import { AuditLogger } from "./audit-logger.js";
import { BashRuleEvaluator } from "./bash-evaluator.js";
import { PC_ERROR_CODES, PermissionError } from "./errors.js";
import type { ApprovalBroker } from "./approval-broker.js";
import type { RulesManager } from "./rules-manager.js";
import type {
  ApprovalRespondInput,
  ApprovalResolution,
  BashCommandAnalysis,
  BashSegment,
  PermissionRequest,
  PermissionVerdict,
} from "./types.js";

export interface PermissionServiceOptions {
  rules: RulesManager;
  bash: BashRuleEvaluator;
  broker: ApprovalBroker;
  audit: AuditLogger;
  onDiagnostic?: (message: string, err?: unknown) => void;
}

interface PreliminaryVerdict {
  decision: PermissionDecision;
  matchedBy: MatchedBy;
  ruleId?: string;
  reason: string;
}

/** 判定链层级数据源（session → project → global 顺序）。 */
interface RuleLevel {
  level: MatchedBy;
  rules: PermissionRule[];
}

export class PermissionService {
  constructor(private readonly options: PermissionServiceOptions) {}

  private get bash(): BashRuleEvaluator {
    return this.options.bash;
  }

  /** 五级判定链（02 §6.2 evaluate）。 */
  async evaluate(req: PermissionRequest): Promise<PermissionVerdict> {
    const analysis =
      req.toolName === "bash" ? this.bash.parse(extractBashCommand(req.input) ?? "") : null;

    // L1 工具 metadata：readOnly 快速通道（02 §6.2「readOnly 走快速通道」）
    if (req.toolName === "bash") {
      if (analysis !== null && allReadonly(analysis)) {
        return this.finalize(req, {
          decision: "allow",
          matchedBy: "metadata",
          reason: "bash 只读命令白名单（全段只读，含 git status/log/diff、ls、cat 等）",
        });
      }
    } else if (req.metadata.readOnly && req.metadata.sideEffectScope === "none") {
      return this.finalize(req, {
        decision: "allow",
        matchedBy: "metadata",
        reason: "只读工具快速通道（readOnly && sideEffectScope=none）",
      });
    }

    // L2 协作模式（02 §6.2「plan 模式下写类一律 deny」）
    const modeVerdict = this.modeVerdict(req);
    if (modeVerdict !== null) {
      return this.finalize(req, modeVerdict);
    }

    // L3-L5 规则链（session → project → global，首个命中层级生效）
    const levels: RuleLevel[] = [
      { level: "session-rule", rules: this.options.rules.sessionRulesOf(req.sessionId) },
      {
        level: "project-rule",
        rules: await this.options.rules.persistedRules("project", req.workspaceId),
      },
      { level: "global-rule", rules: await this.options.rules.persistedRules("global", null) },
    ];
    const ruleVerdict =
      req.toolName === "bash" && analysis !== null
        ? this.bashRuleVerdict(levels, analysis)
        : this.plainRuleVerdict(levels, req.toolName);
    if (ruleVerdict !== null) {
      if (ruleVerdict.decision === "ask") {
        return this.askViaBroker(req, ruleVerdict, levels);
      }
      return this.finalize(req, ruleVerdict);
    }

    // 兜底 default ask（fail-safe，02 §6.2）
    return this.askViaBroker(
      req,
      {
        decision: "ask",
        matchedBy: "default",
        reason: bashInconclusive(analysis)
          ? "bash 命令解析不确定（变量展开/子 shell），宁严勿松默认 ask"
          : "未命中任何规则，默认 ask",
      },
      levels,
    );
  }

  /** 审批应答（06 §2.2 permission.respond）；always 按 scope 落规则（默认 project）。 */
  async respond(grantId: string, input: ApprovalRespondInput): Promise<{
    resolved: true;
    decision: "allow" | "deny";
    ruleId?: string;
  }> {
    const resolution = await this.options.broker.respond(grantId, input);
    let ruleId: string | undefined;
    if (resolution.decision === "allow" && resolution.always) {
      ruleId = await this.persistAlwaysRule(grantId, resolution, input.scope);
    }
    return { resolved: true, decision: resolution.decision, ...(ruleId !== undefined && { ruleId }) };
  }

  /** ask 收敛等待（agent-core tool-phase 挂起点）。 */
  awaitApproval(grantId: string): Promise<"allow" | "deny"> {
    return this.options.broker.wait(grantId);
  }

  // ---------------------------------------------------------------------------

  private modeVerdict(req: PermissionRequest): PreliminaryVerdict | null {
    if (req.mode === "plan") {
      if (req.toolName === "bash") {
        // 只读 bash 已在 L1 放行；到达此处即非只读
        return { decision: "deny", matchedBy: "mode", reason: "plan 模式禁止写操作（bash 非只读命令）" };
      }
      if (req.metadata.sideEffectScope === "none") {
        return { decision: "allow", matchedBy: "mode", reason: "plan 模式读类工具放行" };
      }
      return { decision: "deny", matchedBy: "mode", reason: "plan 模式禁止写操作" };
    }
    if (req.mode === "auto-accept") {
      // 02 §6.2「auto-accept → allow（workspace 内）」：机器级（bash/machine/network）保守不放行
      if (req.toolName !== "bash" && req.metadata.sideEffectScope !== "machine" && req.metadata.sideEffectScope !== "network") {
        return { decision: "allow", matchedBy: "mode", reason: "auto-accept 模式 workspace 范围放行" };
      }
    }
    return null;
  }

  /** 非 bash 工具：pattern 缺省规则按工具级匹配；首个命中层级生效。 */
  private plainRuleVerdict(levels: RuleLevel[], toolName: string): PreliminaryVerdict | null {
    for (const { level, rules } of levels) {
      const candidates = rules.filter(
        (rule) => rule.tool === toolName && (rule.pattern ?? "") === "" && rule.matchType !== "regex" && rule.matchType !== "exact",
      );
      const hit = strictestRule(candidates);
      if (hit !== null) {
        return {
          decision: hit.behavior,
          matchedBy: level,
          ruleId: hit.id,
          reason: `${level} 规则命中（${hit.behavior}）`,
        };
      }
    }
    return null;
  }

  /**
   * bash 命令级求值：链式分段逐段判定，取最严段（02 §6.2 第 4 点）。
   * 高危段：通配 allow 规则跳过（02 §6.4），无显式规则 → ask（逐次审批）。
   */
  private bashRuleVerdict(levels: RuleLevel[], analysis: BashCommandAnalysis): PreliminaryVerdict | null {
    if (analysis.inconclusive || analysis.segments.length === 0) {
      return null; // 解析不确定 → 兜底 ask（宁严勿松）
    }
    const segmentVerdicts: PreliminaryVerdict[] = [];
    for (const segment of analysis.segments) {
      const verdict = this.bashSegmentVerdict(levels, segment);
      if (verdict !== null) {
        segmentVerdicts.push(verdict);
      }
    }
    if (segmentVerdicts.length === 0) {
      return null;
    }
    return strictestVerdict(segmentVerdicts);
  }

  private bashSegmentVerdict(levels: RuleLevel[], segment: BashSegment): PreliminaryVerdict | null {
    for (const { level, rules } of levels) {
      const candidates = rules.filter((rule) => {
        if (rule.tool !== "bash") return false;
        if (!this.bash.segmentMatches(rule, segment.text)) return false;
        // 02 §6.4：通配规则试图 allow 高危根命令 → 匹配器强制跳过 allow 语义（降级 ask）
        if (rule.behavior === "allow" && effectiveMatchType(rule) === "wildcard" && segment.dangerous) {
          return false;
        }
        return true;
      });
      const hit = strictestRule(candidates);
      if (hit !== null) {
        return {
          decision: hit.behavior,
          matchedBy: level,
          ruleId: hit.id,
          reason: `${level} 命中 bash 片段「${segment.text}」（${hit.behavior}）`,
        };
      }
    }
    if (segment.dangerous) {
      return {
        decision: "ask",
        matchedBy: "default",
        reason: `高危根命令「${segment.root}」：通配 allow 不生效，须逐次审批（02 §6.4）`,
      };
    }
    return null; // 普通段无规则 → 由整体兜底 default ask
  }

  /** ask → 审批闭环（grantId 下发；ruleCandidates 随审批单推送）。 */
  private async askViaBroker(
    req: PermissionRequest,
    verdict: PreliminaryVerdict,
    levels: RuleLevel[],
  ): Promise<PermissionVerdict> {
    const { grantId } = await this.options.broker.request({
      sessionId: req.sessionId,
      workspaceId: req.workspaceId,
      toolName: req.toolName,
      input: req.input,
      mode: req.mode,
      matchedBy: verdict.matchedBy,
      ...(verdict.ruleId !== undefined && { ruleId: verdict.ruleId }),
      reason: verdict.reason,
      ...(req.turnId !== undefined && { turnId: req.turnId }),
      ...(req.toolCallId !== undefined && { toolCallId: req.toolCallId }),
      metadata: metadataSummary(req.metadata),
      ruleCandidates: candidatesOf(levels, req, this.bash),
      sink: req.events,
    });
    return {
      decision: "ask",
      matchedBy: verdict.matchedBy,
      ...(verdict.ruleId !== undefined && { ruleId: verdict.ruleId }),
      grantId,
      reason: verdict.reason,
    };
  }

  /** allow/deny 终判 → 审计立即落盘（ask 态的终判由 broker onSettled 落盘）。 */
  private async finalize(req: PermissionRequest, verdict: PreliminaryVerdict): Promise<PermissionVerdict> {
    await this.options.audit.record({
      sessionId: req.sessionId,
      workspaceId: req.workspaceId,
      toolName: req.toolName,
      mode: req.mode,
      decision: verdict.decision,
      matchedBy: verdict.matchedBy,
      ruleId: verdict.ruleId ?? null,
      reason: verdict.reason,
      input: req.input,
    });
    return { ...verdict };
  }

  /** 「始终允许」落规则：bash 取根命令前缀通配（rm 等高危仍会被匹配器跳过），其余工具整工具放行。 */
  private async persistAlwaysRule(
    grantId: string,
    _resolution: ApprovalResolution,
    scope: RuleScope | undefined,
  ): Promise<string> {
    const grant = this.options.broker.grant(grantId);
    if (grant === null) {
      throw new PermissionError(PC_ERROR_CODES.GRANT_NOT_FOUND, `grant not found: ${grantId}`);
    }
    const effectiveScope: RuleScope = scope ?? "project"; // 06 §2.2：默认 project
    const command = extractBashCommand(grant.input);
    const pattern =
      grant.toolName === "bash" && command !== null ? `${this.bash.parse(command).segments[0]?.root ?? command} *` : null;
    const rule = await this.options.rules.addRule({
      scope: effectiveScope,
      tool: grant.toolName,
      pattern,
      ...(grant.toolName === "bash" && { matchType: "wildcard" as const }),
      behavior: "allow",
      source: "allow-always",
      ...(effectiveScope === "session" && { sessionId: grant.sessionId }),
    });
    return rule.id;
  }
}

// ---------------------------------------------------------------------------

function effectiveMatchType(rule: PermissionRule): "wildcard" | "exact" | "regex" {
  return rule.matchType ?? "wildcard";
}

function strictestRule(rules: PermissionRule[]): PermissionRule | null {
  const rank = (behavior: string): number => (behavior === "deny" ? 2 : behavior === "ask" ? 1 : 0);
  let best: PermissionRule | null = null;
  for (const rule of rules) {
    if (
      best === null ||
      rank(rule.behavior) > rank(best.behavior) ||
      (rule.behavior === best.behavior && rule.createdAt > best.createdAt)
    ) {
      best = rule; // 层级内 deny > ask > allow；同行为取最新（02 §6.4）
    }
  }
  return best;
}

function strictestVerdict(verdicts: PreliminaryVerdict[]): PreliminaryVerdict {
  const rank = (decision: string): number => (decision === "deny" ? 2 : decision === "ask" ? 1 : 0);
  let best = verdicts[0]!;
  for (const verdict of verdicts.slice(1)) {
    if (rank(verdict.decision) > rank(best.decision)) {
      best = verdict;
    }
  }
  return best;
}

function candidatesOf(levels: RuleLevel[], req: PermissionRequest, bash: BashRuleEvaluator): unknown[] {
  const candidates: unknown[] = [];
  const command = extractBashCommand(req.input);
  const analysis = req.toolName === "bash" && command !== null ? bash.parse(command) : null;
  for (const { rules } of levels) {
    if (analysis !== null) {
      const hit = bash.matchRules(analysis, rules.filter((rule) => rule.tool === "bash"));
      if (hit !== null) candidates.push(hit);
    } else {
      const hit = strictestRule(rules.filter((rule) => rule.tool === req.toolName && (rule.pattern ?? "") === ""));
      if (hit !== null) candidates.push(hit);
    }
  }
  return candidates;
}

function metadataSummary(metadata: {
  readOnly: boolean;
  destructive: boolean;
  sideEffectScope: string;
  riskLevel: string;
}): ToolMetadataSummary {
  return {
    readOnly: metadata.readOnly,
    destructive: metadata.destructive,
    sideEffectScope: metadata.sideEffectScope as ToolMetadataSummary["sideEffectScope"],
    riskLevel: metadata.riskLevel as ToolMetadataSummary["riskLevel"],
  };
}

function extractBashCommand(input: unknown): string | null {
  if (typeof input === "object" && input !== null && "command" in input) {
    const command = (input as { command?: unknown }).command;
    if (typeof command === "string" && command.trim().length > 0) {
      return command;
    }
  }
  return null;
}

function bashInconclusive(analysis: BashCommandAnalysis | null): boolean {
  return analysis !== null && analysis.inconclusive;
}

function allReadonly(analysis: BashCommandAnalysis): boolean {
  return !analysis.inconclusive && analysis.segments.length > 0 && analysis.segments.every((s) => s.readonly);
}
