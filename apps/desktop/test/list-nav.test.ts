/**
 * list-nav 单测（polish-ui-states-and-runtime A5）：列表键盘导航纯函数——
 * 越界夹取 / 环绕 / 无高亮起始 / count===0 安全 / Home·End / 非导航键 → null。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clampIndex, nextIndex, nextIndexFromKey } from "../src/renderer/list-nav.js";

describe("clampIndex（越界夹取）", () => {
  it("范围内原样返回", () => {
    assert.equal(clampIndex(0, 3), 0);
    assert.equal(clampIndex(2, 3), 2);
  });

  it("下溢夹到 0，上溢夹到 count-1", () => {
    assert.equal(clampIndex(-5, 3), 0);
    assert.equal(clampIndex(9, 3), 2);
  });

  it("count<=0 返回 0（空列表安全）", () => {
    assert.equal(clampIndex(3, 0), 0);
    assert.equal(clampIndex(-1, 0), 0);
  });
});

describe("nextIndex（环绕）", () => {
  it("普通前进 / 后退", () => {
    assert.equal(nextIndex(0, 3, 1), 1);
    assert.equal(nextIndex(2, 3, -1), 1);
  });

  it("首尾环绕", () => {
    assert.equal(nextIndex(2, 3, 1), 0);
    assert.equal(nextIndex(0, 3, -1), 2);
  });

  it("无高亮（current<0）：前进到首项 / 后退到末项", () => {
    assert.equal(nextIndex(-1, 3, 1), 0);
    assert.equal(nextIndex(-1, 3, -1), 2);
  });

  it("越界 current 先夹取", () => {
    assert.equal(nextIndex(9, 3, 0), 2);
    assert.equal(nextIndex(-7, 3, 0), 0);
  });

  it("count<=0 安全返回 0", () => {
    assert.equal(nextIndex(0, 0, 1), 0);
    assert.equal(nextIndex(-1, 0, -1), 0);
  });
});

describe("nextIndexFromKey", () => {
  it("ArrowUp / ArrowDown 环绕", () => {
    assert.equal(nextIndexFromKey("ArrowDown", 0, 3), 1);
    assert.equal(nextIndexFromKey("ArrowUp", 0, 3), 2);
    assert.equal(nextIndexFromKey("ArrowDown", -1, 3), 0);
  });

  it("Home → 0，End → count-1", () => {
    assert.equal(nextIndexFromKey("Home", 2, 5), 0);
    assert.equal(nextIndexFromKey("End", 0, 5), 4);
    assert.equal(nextIndexFromKey("End", 0, 0), 0);
  });

  it("非导航键 → null", () => {
    assert.equal(nextIndexFromKey("Enter", 0, 3), null);
    assert.equal(nextIndexFromKey("Delete", 0, 3), null);
    assert.equal(nextIndexFromKey("a", 1, 3), null);
  });
});
