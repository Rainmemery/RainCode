/**
 * session-filters 纯函数单测（ui-panel-deepening 轮）：子会话判定（[subagent: 前缀）与
 * 归档/子会话显隐过滤（filterSessionRows 默认隐藏、开关放行）。node:test 直跑。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { filterSessionRows, isSubsessionSession } from "../src/session-filters.js";

describe("isSubsessionSession（子会话判定：[subagent: 前缀）", () => {
  it("[subagent: 前缀 → true（含 profile 变体）", () => {
    assert.equal(isSubsessionSession("[subagent:reviewer] 审查 src/rpc"), true);
    assert.equal(isSubsessionSession("[subagent:builder]"), true);
  });

  it("普通标题与非前缀相似形态 → false", () => {
    assert.equal(isSubsessionSession("重构 store"), false);
    assert.equal(isSubsessionSession("[subagent] 无冒号前缀不算"), false);
    assert.equal(isSubsessionSession("前缀 [subagent: 在中间"), false);
  });
});

describe("filterSessionRows（归档/子会话显隐过滤，顺序保持）", () => {
  const rows = [
    { id: "a1", title: "活跃会话", state: "Active" },
    { id: "a2", title: "无 state 行（旧服务端）" },
    { id: "a3", title: "已归档会话", state: "Archived" },
    { id: "a4", title: "[subagent:reviewer] 审查", state: "Active" },
  ];

  it("默认（两开关皆关）：滤掉 Archived 与子会话，其余保持入参顺序", () => {
    const filtered = filterSessionRows(rows, { showArchived: false, showSubsessions: false });
    assert.deepEqual(filtered.map((r) => r.id), ["a1", "a2"]);
  });

  it("showArchived 开启：归档行放行，子会话仍隐藏", () => {
    const filtered = filterSessionRows(rows, { showArchived: true, showSubsessions: false });
    assert.deepEqual(filtered.map((r) => r.id), ["a1", "a2", "a3"]);
  });

  it("showSubsessions 开启：子会话放行，归档行仍隐藏", () => {
    const filtered = filterSessionRows(rows, { showArchived: false, showSubsessions: true });
    assert.deepEqual(filtered.map((r) => r.id), ["a1", "a2", "a4"]);
  });
});
