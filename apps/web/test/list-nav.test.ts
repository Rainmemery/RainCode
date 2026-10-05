/**
 * list-nav 纯函数单测（§8.1 键盘可达轮）：钳制 / 回绕步进 / 按键映射（含空列表与越界安全）。
 * node:test 直跑。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clampIndex, nextIndex, nextIndexFromKey } from "../src/list-nav.js";

describe("clampIndex（钳制到 [0, count-1]）", () => {
  it("区间内原样返回", () => {
    assert.equal(clampIndex(0, 5), 0);
    assert.equal(clampIndex(3, 5), 3);
    assert.equal(clampIndex(4, 5), 4);
  });

  it("越界钳到边界（负 → 0，超出 → count-1）", () => {
    assert.equal(clampIndex(-1, 5), 0);
    assert.equal(clampIndex(-99, 5), 0);
    assert.equal(clampIndex(5, 5), 4);
    assert.equal(clampIndex(999, 5), 4);
  });

  it("空列表（count === 0）安全返回 0", () => {
    assert.equal(clampIndex(0, 0), 0);
    assert.equal(clampIndex(3, 0), 0);
    assert.equal(clampIndex(-2, 0), 0);
  });
});

describe("nextIndex（回绕步进）", () => {
  it("正向推进并在末尾回绕到 0", () => {
    assert.equal(nextIndex(0, 3, 1), 1);
    assert.equal(nextIndex(2, 3, 1), 0);
  });

  it("负向推进并在 0 处回绕到末尾", () => {
    assert.equal(nextIndex(2, 3, -1), 1);
    assert.equal(nextIndex(0, 3, -1), 2);
  });

  it("越界 current 先钳制再步进", () => {
    assert.equal(nextIndex(-1, 3, 1), 0);
    assert.equal(nextIndex(9, 3, 1), 0); // clamp → 2，+1 回绕 → 0
    assert.equal(nextIndex(9, 3, -1), 1); // clamp → 2，-1 → 1
  });

  it("空列表安全返回 0", () => {
    assert.equal(nextIndex(0, 0, 1), 0);
    assert.equal(nextIndex(5, 0, -1), 0);
  });
});

describe("nextIndexFromKey（按键映射）", () => {
  it("ArrowDown / ArrowUp 按方向回绕", () => {
    assert.equal(nextIndexFromKey("ArrowDown", 0, 4), 1);
    assert.equal(nextIndexFromKey("ArrowDown", 3, 4), 0);
    assert.equal(nextIndexFromKey("ArrowUp", 3, 4), 2);
    assert.equal(nextIndexFromKey("ArrowUp", 0, 4), 3);
  });

  it("Home → 0，End → count-1", () => {
    assert.equal(nextIndexFromKey("Home", 3, 6), 0);
    assert.equal(nextIndexFromKey("End", 0, 6), 5);
  });

  it("非导航键 → null（Enter / Delete / Escape / 字母）", () => {
    assert.equal(nextIndexFromKey("Enter", 0, 5), null);
    assert.equal(nextIndexFromKey("Delete", 0, 5), null);
    assert.equal(nextIndexFromKey("Escape", 0, 5), null);
    assert.equal(nextIndexFromKey("a", 0, 5), null);
    assert.equal(nextIndexFromKey("Tab", 0, 5), null);
  });

  it("空列表：导航键返回 0（不抛错）", () => {
    assert.equal(nextIndexFromKey("ArrowDown", 0, 0), 0);
    assert.equal(nextIndexFromKey("ArrowUp", 0, 0), 0);
    assert.equal(nextIndexFromKey("End", 0, 0), 0);
    assert.equal(nextIndexFromKey("Home", 0, 0), 0);
  });
});
