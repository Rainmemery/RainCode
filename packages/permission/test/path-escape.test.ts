/**
 * PermissionService 越界强制 ask 单测（T2.7 任务 4 · 02-module-design §5.4）。
 * 「命令读写 workspace 外路径 | P0 标记为需审批（权限层 ask）；审批通过后放行并记录审计」：
 * - pathEscape 存在 → 跳过 L1 只读快速通道，强制经 ApprovalBroker 逐次审批（ask 闭环/审计不变）；
 * - 无 pathEscape → 既有五级链零回归（readOnly+none 快速通道 allow）；
 * - respond always → 既有落规则行为不回归（工具级 allow，越界审批不特殊化）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolve } from "node:path";
import type { DecisionAppendInput, DecisionsRepo, PermissionRuleRow, RuleAddInput, RulesRepo } from "@raincode/storage";
import { ApprovalBroker, AuditLogger, BashRuleEvaluator, PermissionService, RulesManager } from "../src/index.js";
import type { PermissionRequest } from "../src/index.js";

// ---------------------------------------------------------------------------
// 最小 fake：DecisionsRepo / RulesRepo（类含私有成员，结构化投影 + 双重断言）
// ---------------------------------------------------------------------------

function makeAuditFake(): { repo: DecisionsRepo; records: DecisionAppendInput[] } {
  const records: DecisionAppendInput[] = [];
  const repo = {
    append: async (input: DecisionAppendInput) => {
      records.push(input);
    },
  } as unknown as DecisionsRepo;
  return { repo, records };
}

function makeRulesFake(): { repo: RulesRepo; rows: PermissionRuleRow[] } {
  const rows: PermissionRuleRow[] = [];
  const repo = {
    add: async (input: RuleAddInput) => {
      const row: PermissionRuleRow = {
        id: `rule_${String(rows.length + 1)}`,
        scope: input.scope,
        workspaceId: input.workspaceId,
        tool: input.tool,
        pattern: input.pattern ?? null,
        behavior: input.behavior,
        source: input.source,
        createdAt: input.ts ?? Date.now(),
      };
      rows.push(row);
      return row;
    },
    list: async () => [...rows],
    get: async (id: string) => rows.find((row) => row.id === id) ?? null,
    remove: async () => true,
  } as unknown as RulesRepo;
  return { repo, rows };
}

interface Harness {
  service: PermissionService;
  broker: ApprovalBroker;
  auditRecords: DecisionAppendInput[];
  ruleRows: PermissionRuleRow[];
}

function makeHarness(): Harness {
  const audit = makeAuditFake();
  const rules = makeRulesFake();
  const auditLogger = new AuditLogger(audit.repo);
  // 与 server permission-runtime 装配一致：ask 终判（respond/timeout）由 broker onSettled 统一落审计
  const broker = new ApprovalBroker({
    persistApproval: async () => {},
    persistResolution: async () => {},
    onSettled: (grant, resolution) => {
      void auditLogger.record({
        sessionId: grant.sessionId,
        workspaceId: grant.workspaceId,
        toolName: grant.toolName,
        mode: grant.mode,
        decision: resolution.decision,
        matchedBy: grant.matchedBy,
        ruleId: grant.ruleId ?? null,
        grantId: grant.grantId,
        reason: grant.reason,
        input: grant.input,
        respondLatencyMs: resolution.respondLatencyMs,
      });
    },
  });
  const service = new PermissionService({
    rules: new RulesManager({ repo: rules.repo, defaultWorkspaceId: () => "w1" }),
    bash: new BashRuleEvaluator(),
    broker,
    audit: auditLogger,
  });
  return { service, broker, auditRecords: audit.records, ruleRows: rules.rows };
}

// ---------------------------------------------------------------------------
// 请求构造：read 为 readOnly+none 工具（L1 快速通道候选），pathEscape 由预检注入
// ---------------------------------------------------------------------------

const root = process.cwd();
const escapedAbs = resolve(root, "../outside/secret.txt");

function baseRequest(overrides?: Partial<PermissionRequest>): PermissionRequest {
  return {
    toolName: "read",
    input: { path: "../outside/secret.txt" },
    metadata: {
      readOnly: true,
      destructive: false,
      sideEffectScope: "none",
      riskLevel: "low",
      needsApproval: false,
    },
    mode: "normal",
    sessionId: "s1",
    workspaceRoot: root,
    workspaceId: "w1",
    ...overrides,
  };
}

describe("PermissionService 越界强制 ask（02 §5.4）", () => {
  it("pathEscape 存在 + readOnly 工具：不进快速通道，强制 ask（grantId 下发，reason 携带绝对路径）", async () => {
    const h = makeHarness();
    try {
      const verdict = await h.service.evaluate(
        baseRequest({ pathEscape: { absolutePath: escapedAbs } }),
      );
      assert.equal(verdict.decision, "ask");
      assert.equal(verdict.matchedBy, "default");
      assert.ok(typeof verdict.grantId === "string" && verdict.grantId.length > 0);
      assert.ok(verdict.reason.includes(escapedAbs), `reason 应携带越界绝对路径：${verdict.reason}`);
    } finally {
      h.broker.close();
    }
  });

  it("pathEscape ask → respond allow：awaitApproval 收敛 allow，审计落 allow 且 reason 带路径", async () => {
    const h = makeHarness();
    try {
      const verdict = await h.service.evaluate(
        baseRequest({ pathEscape: { absolutePath: escapedAbs } }),
      );
      assert.equal(verdict.decision, "ask");
      const grantId = verdict.grantId!;

      const pending = h.service.awaitApproval(grantId);
      const respondResult = await h.service.respond(grantId, { decision: "allow" });
      assert.equal(respondResult.resolved, true);
      assert.equal(await pending, "allow");

      // 审计：ask 收敛经 broker onSettled 统一落 permission_decisions（02 §5.4「记录审计」）
      assert.equal(h.auditRecords.length, 1);
      assert.equal(h.auditRecords[0]!.decision, "allow");
      assert.equal(h.auditRecords[0]!.grantId, grantId);
      assert.ok(
        h.auditRecords[0]!.reason!.includes(escapedAbs),
        "审计 reason 应携带越界绝对路径",
      );
    } finally {
      h.broker.close();
    }
  });

  it("pathEscape ask → respond deny：awaitApproval 收敛 deny，审计落 deny", async () => {
    const h = makeHarness();
    try {
      const verdict = await h.service.evaluate(
        baseRequest({ pathEscape: { absolutePath: escapedAbs } }),
      );
      const grantId = verdict.grantId!;
      const pending = h.service.awaitApproval(grantId);
      await h.service.respond(grantId, { decision: "deny" });
      assert.equal(await pending, "deny");
      assert.equal(h.auditRecords[0]!.decision, "deny");
    } finally {
      h.broker.close();
    }
  });

  it("无 pathEscape 的同请求：readOnly+none 快速通道 allow 零回归", async () => {
    const h = makeHarness();
    try {
      const verdict = await h.service.evaluate(baseRequest());
      assert.deepEqual(verdict, {
        decision: "allow",
        matchedBy: "metadata",
        reason: "只读工具快速通道（readOnly && sideEffectScope=none）",
      });
      assert.equal(h.auditRecords.length, 1);
      assert.equal(h.auditRecords[0]!.decision, "allow");
      assert.equal(h.auditRecords[0]!.matchedBy, "metadata");
    } finally {
      h.broker.close();
    }
  });

  it("pathEscape + respond allow always：既有落规则行为不回归（工具级 allow 规则）", async () => {
    const h = makeHarness();
    try {
      const verdict = await h.service.evaluate(
        baseRequest({ pathEscape: { absolutePath: escapedAbs } }),
      );
      const grantId = verdict.grantId!;
      const pending = h.service.awaitApproval(grantId);
      const respondResult = await h.service.respond(grantId, { decision: "allow", always: true });
      assert.equal(await pending, "allow");
      assert.ok(typeof respondResult.ruleId === "string");

      // 既有行为：always 落工具级 allow 规则（越界场景不特殊化；路径级收紧留给后续波次）
      assert.equal(h.ruleRows.length, 1);
      assert.equal(h.ruleRows[0]!.tool, "read");
      assert.equal(h.ruleRows[0]!.behavior, "allow");
      assert.equal(h.ruleRows[0]!.pattern, null);
    } finally {
      h.broker.close();
    }
  });
});
