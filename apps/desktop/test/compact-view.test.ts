/**
 * compact-view reducer 单测（UI 管理面板深化轮）：compact.started / compact.completed →
 * 压缩提示条状态投影。reducer 为纯函数（不依赖 react/zustand），node:test 直跑。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyCompactEvent } from "../src/renderer/compact-view.js";
import type { CompactionBanner } from "../src/renderer/compact-view.js";

function baseState(activeId: string | null = "s1", compaction: CompactionBanner | null = null) {
  return { activeId, compaction };
}

describe("applyCompactEvent（压缩可视化：compact.* 事件 → 提示条状态）", () => {
  it("started → running：epoch/trigger 随行（trigger 非法回退 manual）", () => {
    const next = applyCompactEvent(baseState(), "compact.started", {
      sessionId: "s1",
      compactionId: "c1",
      epoch: 1,
      trigger: "manual",
    });
    assert.equal(next.compaction?.sessionId, "s1");
    assert.equal(next.compaction?.phase, "running");
    assert.equal(next.compaction?.epoch, 1);
    assert.equal(next.compaction?.trigger, "manual");
    // trigger 非法（协议仅 auto|manual）→ manual
    const fallback = applyCompactEvent(baseState(), "compact.started", {
      sessionId: "s1",
      compactionId: "c1",
      epoch: 2,
      trigger: "weird",
    });
    assert.equal(fallback.compaction?.trigger, "manual");
    assert.equal(fallback.compaction?.phase, "running");
  });

  it("completed ok 带 tokens：phase=ok，tokensBefore/After 收束，trigger 沿用 running 态", () => {
    let state = applyCompactEvent(baseState(), "compact.started", {
      sessionId: "s1",
      compactionId: "c1",
      epoch: 1,
      trigger: "auto",
    });
    state = applyCompactEvent(state, "compact.completed", {
      sessionId: "s1",
      compactionId: "c1",
      epoch: 1,
      ok: true,
      tokensBefore: 120_000,
      tokensAfter: 30_000,
    });
    assert.equal(state.compaction?.phase, "ok");
    assert.equal(state.compaction?.trigger, "auto"); // completed 事件不带 trigger，沿用 started
    assert.equal(state.compaction?.tokensBefore, 120_000);
    assert.equal(state.compaction?.tokensAfter, 30_000);
    assert.equal(state.compaction?.reason, undefined);
  });

  it("completed failed 带 reason：phase=failed；无前置 started 时 trigger 回退 manual", () => {
    const next = applyCompactEvent(baseState(), "compact.completed", {
      sessionId: "s1",
      compactionId: "c1",
      epoch: 2,
      ok: false,
      failure: { reason: "summary is empty" },
    });
    assert.equal(next.compaction?.phase, "failed");
    assert.equal(next.compaction?.reason, "summary is empty");
    assert.equal(next.compaction?.trigger, "manual");
  });

  it("他会话事件忽略：sessionId 不匹配或非字符串原样返回（引用相等）", () => {
    const state = baseState("s1", { sessionId: "s1", phase: "running", epoch: 1, trigger: "manual" });
    assert.equal(
      applyCompactEvent(state, "compact.started", { sessionId: "s2", compactionId: "c2", epoch: 1, trigger: "auto" }),
      state,
    );
    assert.equal(applyCompactEvent(state, "compact.completed", { sessionId: 42, ok: true }), state);
    // 无活跃会话同样不应用（原样返回）
    const orphan = baseState(null);
    assert.equal(
      applyCompactEvent(orphan, "compact.started", { sessionId: "s1", compactionId: "c1", epoch: 1, trigger: "auto" }),
      orphan,
    );
  });

  it("其余事件名与非法字段守卫：未知事件原样返回；epoch 非数字回退 0；failure 形状不符不写 reason", () => {
    const state = baseState();
    assert.equal(applyCompactEvent(state, "compact.paused", { sessionId: "s1" }), state);
    const started = applyCompactEvent(baseState(), "compact.started", { sessionId: "s1", epoch: "x" });
    assert.equal(started.compaction?.epoch, 0);
    const completed = applyCompactEvent(baseState(), "compact.completed", { sessionId: "s1", ok: false, failure: "boom" });
    assert.equal(completed.compaction?.phase, "failed"); // ok 缺省/非 true → failed
    assert.equal(completed.compaction?.reason, undefined);
  });
});
