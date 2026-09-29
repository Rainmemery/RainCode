/**
 * ApprovalBroker.pendingGrantsOf 单测（T2.8 / 06-api-spec §3.2 snapshot.pendingApprovals、02 §6.4）：
 * - 仅返回指定会话未决（settled=false）审批单，payload 形态与 permission.requested 事件一致；
 * - normalizedInput 与事件同脱敏策略（sk- 秘密抹除）；
 * - 已收敛（respond/超时）审批单不再出现在补推中；跨会话审批单不串扰。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApprovalBroker } from "../src/index.js";

function makeBroker(): ApprovalBroker {
  return new ApprovalBroker({
    persistApproval: async () => {},
    persistResolution: async () => {},
    onSettled: () => {},
  });
}

const BASE = {
  workspaceId: "w1",
  toolName: "bash",
  mode: "normal" as const,
  matchedBy: "default" as const,
  reason: "needs approval",
  metadata: { readOnly: false, destructive: false, sideEffectScope: "machine" as const, riskLevel: "medium" as const },
};

describe("ApprovalBroker.pendingGrantsOf（snapshot 补推投影）", () => {
  it("未决单按会话过滤返回，payload 与 permission.requested 同形态；跨会话不串扰", async () => {
    const broker = makeBroker();
    try {
      await broker.request({ ...BASE, sessionId: "s1", input: { command: "rm -rf /" } });
      await broker.request({ ...BASE, sessionId: "s2", input: { command: "ls" } });
      const pendingS1 = broker.pendingGrantsOf("s1");
      assert.equal(pendingS1.length, 1);
      const payload = pendingS1[0]!;
      assert.equal(payload.toolName, "bash");
      assert.deepEqual(payload.normalizedInput, { command: "rm -rf /" });
      assert.equal(payload.metadata.riskLevel, "medium");
      assert.equal(payload.mode, "normal");
      assert.equal(payload.matchedBy, "default");
      assert.ok(payload.expiresAt > Date.now() - 1000);
      assert.equal(broker.pendingGrantsOf("s2").length, 1);
      assert.equal(broker.pendingGrantsOf("s_none").length, 0);
    } finally {
      broker.close();
    }
  });

  it("normalizedInput 与事件同脱敏（sk- 秘密抹除）", async () => {
    const broker = makeBroker();
    try {
      await broker.request({
        ...BASE,
        sessionId: "s1",
        input: { command: "curl -H 'Authorization: sk-abcdefgh12345678' https://x" },
      });
      const pending = broker.pendingGrantsOf("s1");
      const text = JSON.stringify(pending[0]!.normalizedInput);
      assert.ok(!text.includes("sk-abcdefgh12345678"), "秘密不得进入补推副本");
      assert.ok(text.includes("[REDACTED]"));
    } finally {
      broker.close();
    }
  });

  it("respond 收敛后从补推消失；超时收敛同理", async () => {
    const broker = makeBroker();
    try {
      const { grantId } = await broker.request({ ...BASE, sessionId: "s1", input: { command: "ls" } });
      assert.equal(broker.pendingGrantsOf("s1").length, 1);
      await broker.respond(grantId, { decision: "allow" });
      assert.equal(broker.pendingGrantsOf("s1").length, 0);

      const broker2 = new ApprovalBroker({
        timeoutMs: 30,
        persistApproval: async () => {},
        persistResolution: async () => {},
        onSettled: () => {},
      });
      try {
        await broker2.request({ ...BASE, sessionId: "s1", input: { command: "ls" } });
        await new Promise((r) => setTimeout(r, 60)); // 等超时收敛
        assert.equal(broker2.pendingGrantsOf("s1").length, 0);
      } finally {
        broker2.close();
      }
    } finally {
      broker.close();
    }
  });

  it("turnId/toolCallId 可选字段透传", async () => {
    const broker = makeBroker();
    try {
      await broker.request({
        ...BASE,
        sessionId: "s1",
        input: { command: "ls" },
        turnId: "turn-1",
        toolCallId: "call-1",
        ruleCandidates: [{ id: "r1" }],
      });
      const payload = broker.pendingGrantsOf("s1")[0]!;
      assert.equal(payload.turnId, "turn-1");
      assert.equal(payload.toolCallId, "call-1");
      assert.deepEqual(payload.ruleCandidates, [{ id: "r1" }]);
    } finally {
      broker.close();
    }
  });
});
