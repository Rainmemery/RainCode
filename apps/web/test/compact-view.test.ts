/**
 * compact-view reducer 单测（ui-panel-deepening 轮）：compact.started / compact.completed
 * 事件归并投影（applyCompactEvent）——running / ok 带 tokens / failed 带 reason /
 * 他会话事件与未知事件忽略。纯函数，node:test 直跑。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyCompactEvent } from "../src/compact-view.js";
import type { CompactionBanner } from "../src/compact-view.js";

/** 基态（activeId=s1，无提示条）。 */
function base(): { activeId: string | null; compaction: CompactionBanner | null } {
  return { activeId: "s1", compaction: null };
}

describe("applyCompactEvent（压缩生命周期事件归并，06 §3.5 C 组）", () => {
  it("compact.started → running 提示条（epoch/trigger 落字段，归属活跃会话）", () => {
    const next = applyCompactEvent(base(), "compact.started", {
      sessionId: "s1",
      compactionId: "c1",
      epoch: 3,
      trigger: "manual",
    });
    assert.deepEqual(next.compaction, {
      sessionId: "s1",
      phase: "running",
      epoch: 3,
      trigger: "manual",
    });
  });

  it("completed ok=true → ok（tokens 齐备附加；trigger/epoch 沿用 started）", () => {
    let state = applyCompactEvent(base(), "compact.started", {
      sessionId: "s1",
      compactionId: "c1",
      epoch: 2,
      trigger: "auto",
    });
    state = applyCompactEvent(state, "compact.completed", {
      sessionId: "s1",
      compactionId: "c1",
      epoch: 2,
      ok: true,
      tokensBefore: 82000,
      tokensAfter: 12400,
      failure: { reason: "不应出现在 ok 态" },
    });
    assert.deepEqual(state.compaction, {
      sessionId: "s1",
      phase: "ok",
      epoch: 2,
      trigger: "auto",
      tokensBefore: 82000,
      tokensAfter: 12400,
    });
  });

  it("completed ok=false → failed（failure.reason 字符串时携带；ok=true 不携带 reason）", () => {
    const failed = applyCompactEvent(base(), "compact.completed", {
      sessionId: "s1",
      compactionId: "c1",
      epoch: 1,
      ok: false,
      failure: { reason: "LLM 调用超时" },
    });
    assert.equal(failed.compaction!.phase, "failed");
    assert.equal(failed.compaction!.reason, "LLM 调用超时");
    assert.equal(failed.compaction!.trigger, "manual"); // 无 started 前文回退 manual
    assert.equal(failed.compaction!.tokensBefore, undefined);
    const ok = applyCompactEvent(base(), "compact.completed", {
      sessionId: "s1",
      compactionId: "c1",
      epoch: 1,
      ok: true,
      failure: { reason: "ok 态不携带" },
    });
    assert.equal(ok.compaction!.phase, "ok");
    assert.equal(ok.compaction!.reason, undefined);
  });

  it("他会话事件、非字符串 sessionId、未知事件名 → 原样返回（同引用）", () => {
    const state = base();
    // 他会话（activeId=s1）
    assert.equal(
      applyCompactEvent(state, "compact.started", { sessionId: "s2", compactionId: "c1", epoch: 1, trigger: "auto" }),
      state,
    );
    // 非字符串 sessionId
    assert.equal(applyCompactEvent(state, "compact.started", { sessionId: 42 }), state);
    // 未知事件名
    assert.equal(
      applyCompactEvent(state, "compact.unknown", { sessionId: "s1", epoch: 1 }),
      state,
    );
    // 字段类型不符一律忽略该字段（epoch 非 number → 0 缺省；tokens 非 number 不附加）
    const dirty = applyCompactEvent(base(), "compact.started", {
      sessionId: "s1",
      epoch: "x",
      trigger: "maybe",
    });
    assert.deepEqual(dirty.compaction, { sessionId: "s1", phase: "running", epoch: 0, trigger: "manual" });
    const dirtyCompleted = applyCompactEvent(dirty, "compact.completed", {
      sessionId: "s1",
      epoch: null,
      ok: "yes",
      tokensBefore: "many",
    });
    assert.equal(dirtyCompleted.compaction!.phase, "failed"); // ok 非 true → failed
    assert.equal(dirtyCompleted.compaction!.tokensBefore, undefined);
    assert.equal(dirtyCompleted.compaction!.epoch, 0); // 沿用 started 缺省
  });
});
