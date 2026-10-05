/**
 * session-filters 单测（UI 管理面板深化轮）：子会话识别 + 归档/子会话双开关过滤。
 * 纯函数（不依赖 react/zustand），node:test 直跑。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { filterSessionRows, isSubsessionSession } from "../src/renderer/session-filters.js";

describe("isSubsessionSession（子会话识别）", () => {
  it("[subagent: 前缀命中", () => {
    assert.equal(isSubsessionSession("[subagent:reviewer] 审查 src/rpc"), true);
    assert.equal(isSubsessionSession("[subagent:x"), true);
  });

  it("普通标题 / 空串 / 无前缀方括号不命中", () => {
    assert.equal(isSubsessionSession("重构 store"), false);
    assert.equal(isSubsessionSession(""), false);
    assert.equal(isSubsessionSession("subagent: 缺前缀方括号"), false);
  });
});

describe("filterSessionRows（归档/子会话双开关）", () => {
  const rows = [
    { id: "a", title: "活跃会话", state: "Active" },
    { id: "b", title: "已归档会话", state: "Archived" },
    { id: "c", title: "[subagent:reviewer] 审查", state: "Active" },
    { id: "d", title: "旧服务端无 state 字段" },
  ];

  it("默认双关：归档行与子会话行均隐藏；state 缺省行保留（不丢行）", () => {
    const visible = filterSessionRows(rows, { showArchived: false, showSubsessions: false });
    assert.deepEqual(
      visible.map((row) => row.id),
      ["a", "d"],
    );
  });

  it("开启已归档：归档行出现；开启子会话：子会话行出现（两开关独立）", () => {
    assert.deepEqual(
      filterSessionRows(rows, { showArchived: true, showSubsessions: false }).map((row) => row.id),
      ["a", "b", "d"],
    );
    assert.deepEqual(
      filterSessionRows(rows, { showArchived: false, showSubsessions: true }).map((row) => row.id),
      ["a", "c", "d"],
    );
  });

  it("全开透传全量；空列表返回空集", () => {
    assert.equal(filterSessionRows(rows, { showArchived: true, showSubsessions: true }).length, 4);
    assert.deepEqual(filterSessionRows([], { showArchived: true, showSubsessions: true }), []);
  });
});
