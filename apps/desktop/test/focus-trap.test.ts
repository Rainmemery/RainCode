/**
 * focus-trap 单测（polish-ui-states-and-runtime A6）：Tab / Shift+Tab 循环纯数学
 * （focusableWithin 依赖 DOM，不在 node 环境覆盖）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FOCUSABLE_SELECTOR, nextFocusIndex } from "../src/renderer/focus-trap.js";

describe("nextFocusIndex（Tab 循环）", () => {
  it("前进环绕", () => {
    assert.equal(nextFocusIndex(0, 3, false), 1);
    assert.equal(nextFocusIndex(1, 3, false), 2);
    assert.equal(nextFocusIndex(2, 3, false), 0);
  });

  it("Shift+Tab 反向环绕", () => {
    assert.equal(nextFocusIndex(2, 3, true), 1);
    assert.equal(nextFocusIndex(0, 3, true), 2);
  });

  it("count<=0 安全返回 0", () => {
    assert.equal(nextFocusIndex(0, 0, false), 0);
    assert.equal(nextFocusIndex(5, 0, true), 0);
  });
});

describe("FOCUSABLE_SELECTOR", () => {
  it("覆盖按钮 / 输入 / tabindex，且排除 tabindex=-1", () => {
    assert.ok(FOCUSABLE_SELECTOR.includes("button"));
    assert.ok(FOCUSABLE_SELECTOR.includes("input"));
    assert.ok(FOCUSABLE_SELECTOR.includes('tabindex]:not([tabindex="-1"])'));
  });
});
