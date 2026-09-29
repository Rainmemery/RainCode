/**
 * ApprovalBroker ask_user_question 通道单测（T2.7 任务 2 · 06-api-spec §2.2 respond answerText
 * capability: permission.respond.answer）。
 * - respond allow + answerText → askAndWait 侧收到应答文本；permission.resolved 事件携带 answerText；
 * - respond deny → { cancelled }；allow 无 answerText → { cancelled }；
 * - 超时收敛 → { cancelled }（事件 by=timeout，无 answerText）；
 * - 既有 wait()/respond 零回归：wait 返回 allow/deny 口径不变。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApprovalBroker } from "../src/index.js";
import type { PermissionEventSink } from "../src/index.js";

interface CapturedEvent {
  name: string;
  payload: Record<string, unknown>;
}

function makeSink(): { sink: PermissionEventSink; events: CapturedEvent[] } {
  const events: CapturedEvent[] = [];
  return {
    events,
    sink: {
      emit: (name, build) => {
        events.push({ name, payload: build(1, Date.now()) as Record<string, unknown> });
      },
    },
  };
}

function makeBroker(timeoutMs?: number): ApprovalBroker {
  return new ApprovalBroker({
    ...(timeoutMs !== undefined && { timeoutMs }),
    persistApproval: async () => {},
    persistResolution: async () => {},
    onSettled: () => {},
  });
}

const BASE_REQUEST = {
  sessionId: "s1",
  workspaceId: "w1",
  toolName: "ask_user_question",
  mode: "normal" as const,
  matchedBy: "default" as const,
  reason: "ask_user_question 等待用户应答",
  metadata: { readOnly: true, destructive: false, sideEffectScope: "none" as const, riskLevel: "low" as const },
};

describe("ApprovalBroker ask_user_question 通道（06 §2.2 answerText）", () => {
  it("respond allow + answerText → askAndWait 收到应答文本，resolved 事件携带 answerText", async () => {
    const broker = makeBroker();
    const { sink, events } = makeSink();
    try {
      const { grantId } = await broker.request({
        ...BASE_REQUEST,
        input: { question: "选哪个方案？", choices: ["A", "B"] },
        sink,
      });
      const pending = broker.askAndWait(grantId);
      await broker.respond(grantId, { decision: "allow", answerText: "方案 A" });
      assert.deepEqual(await pending, { answerText: "方案 A" });

      const resolved = events.find((event) => event.name === "permission.resolved");
      assert.ok(resolved !== undefined, "应发出 permission.resolved");
      assert.equal(resolved.payload.decision, "allow");
      assert.equal(resolved.payload.answerText, "方案 A");
    } finally {
      broker.close();
    }
  });

  it("respond deny → askAndWait 收敛 { cancelled: true }", async () => {
    const broker = makeBroker();
    try {
      const { grantId } = await broker.request({ ...BASE_REQUEST, input: { question: "q" } });
      const pending = broker.askAndWait(grantId);
      await broker.respond(grantId, { decision: "deny" });
      assert.deepEqual(await pending, { cancelled: true });
    } finally {
      broker.close();
    }
  });

  it("respond allow 无 answerText → { cancelled: true }（空应答不冒充答案）", async () => {
    const broker = makeBroker();
    try {
      const { grantId } = await broker.request({ ...BASE_REQUEST, input: { question: "q" } });
      const pending = broker.askAndWait(grantId);
      await broker.respond(grantId, { decision: "allow" });
      assert.deepEqual(await pending, { cancelled: true });
    } finally {
      broker.close();
    }
  });

  it("超时收敛 → { cancelled: true }，resolved 事件 by=timeout 无 answerText", async () => {
    const broker = makeBroker(40);
    const { sink, events } = makeSink();
    try {
      const { grantId } = await broker.request({ ...BASE_REQUEST, input: { question: "q" }, sink });
      const pending = broker.askAndWait(grantId);
      assert.deepEqual(await pending, { cancelled: true });
      const resolved = events.find((event) => event.name === "permission.resolved");
      assert.ok(resolved !== undefined);
      assert.equal(resolved.payload.by, "timeout");
      assert.equal(resolved.payload.decision, "deny");
      assert.equal(resolved.payload.answerText, undefined);
    } finally {
      broker.close();
    }
  });

  it("既有 wait() 零回归：ask 通道审批单的 wait 口径仍为 allow/deny", async () => {
    const broker = makeBroker();
    try {
      const { grantId } = await broker.request({ ...BASE_REQUEST, input: { question: "q" } });
      const pending = broker.wait(grantId);
      await broker.respond(grantId, { decision: "allow", answerText: "文本" });
      assert.equal(await pending, "allow");
    } finally {
      broker.close();
    }
  });

  it("askAndWait 对不存在 grantId → PC_GRANT_NOT_FOUND", async () => {
    const broker = makeBroker();
    try {
      await assert.rejects(broker.askAndWait("grant_missing"), (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(String((err as Error).message).includes("grant not found"));
        return true;
      });
    } finally {
      broker.close();
    }
  });
});
