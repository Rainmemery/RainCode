/**
 * focus-trap 纯函数单测（§8.1 焦点管理轮）：Tab/Shift+Tab 循环索引（回绕 / 越界 / 空集合）
 * 与可聚焦元素过滤（disabled / tabindex=-1 / hidden）。node:test 直跑，DOM 侧以最小假根覆盖。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FOCUSABLE_SELECTOR, focusableWithin, nextFocusIndex } from "../src/focus-trap.js";

describe("nextFocusIndex（Tab / Shift+Tab 循环）", () => {
  it("正向回绕：末位 → 首位", () => {
    assert.equal(nextFocusIndex(0, 3, false), 1);
    assert.equal(nextFocusIndex(2, 3, false), 0);
  });

  it("反向回绕：首位 → 末位", () => {
    assert.equal(nextFocusIndex(1, 3, true), 0);
    assert.equal(nextFocusIndex(0, 3, true), 2);
  });

  it("越界 current（-1 / 超范围）落到首或末", () => {
    assert.equal(nextFocusIndex(-1, 3, false), 0);
    assert.equal(nextFocusIndex(-1, 3, true), 2);
    assert.equal(nextFocusIndex(9, 3, false), 0);
    assert.equal(nextFocusIndex(9, 3, true), 2);
  });

  it("空集合（count === 0）安全返回 0", () => {
    assert.equal(nextFocusIndex(0, 0, false), 0);
    assert.equal(nextFocusIndex(0, 0, true), 0);
  });
});

describe("FOCUSABLE_SELECTOR（常量口径）", () => {
  it("覆盖原生可聚焦控件并排除 disabled / tabindex=-1", () => {
    for (const fragment of ["button:not([disabled])", "input:not([disabled])", 'tabindex]:not([tabindex="-1"])', 'a[href]']) {
      assert.equal(FOCUSABLE_SELECTOR.includes(fragment), true, `缺少片段: ${fragment}`);
    }
  });
});

describe("focusableWithin（过滤 disabled / tabindex=-1 / hidden）", () => {
  /** 最小假元素：仅实现 isFocusable 使用到的属性接口。 */
  function fakeEl(attrs: Record<string, string>, hidden = false): HTMLElement {
    return {
      hasAttribute: (name: string) => name in attrs,
      getAttribute: (name: string) => (name in attrs ? attrs[name]! : null),
      hidden,
    } as unknown as HTMLElement;
  }

  it("保留原生控件，滤除 disabled / tabindex=-1 / hidden / aria-hidden", () => {
    const ok1 = fakeEl({});
    const ok2 = fakeEl({ tabindex: "0" });
    const disabled = fakeEl({ disabled: "" });
    const minusOne = fakeEl({ tabindex: "-1" });
    const hiddenAttr = fakeEl({ hidden: "" });
    const hiddenProp = fakeEl({}, true);
    const ariaHidden = fakeEl({ "aria-hidden": "true" });
    const root = {
      querySelectorAll: () => [ok1, ok2, disabled, minusOne, hiddenAttr, hiddenProp, ariaHidden],
    } as unknown as HTMLElement;

    assert.deepEqual(focusableWithin(root), [ok1, ok2]);
  });

  it("无可聚焦元素 → 空数组", () => {
    const root = { querySelectorAll: () => [] } as unknown as HTMLElement;
    assert.deepEqual(focusableWithin(root), []);
  });
});
