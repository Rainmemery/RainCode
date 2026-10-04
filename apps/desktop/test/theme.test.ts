/**
 * theme.ts 单测（03 §3.2 浅色主题落地轮）：偏好解析 / 切换循环 / 持久化存取——
 * 纯函数面（不触 DOM，applyTheme 由走查 CDP 断言覆盖）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isThemePref,
  loadThemePref,
  nextTheme,
  resolveTheme,
  saveThemePref,
  THEME_STORAGE_KEY,
} from "../src/renderer/theme.js";

/** localStorage 最小桩（Map 语义，仅覆盖 getItem/setItem 面）。 */
function fakeStorage(initial: Record<string, string> = {}): {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  dump(): Record<string, string>;
} {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    dump: () => Object.fromEntries(map),
  };
}

describe("resolveTheme（偏好 → 实际主题）", () => {
  it("dark / light 直接透传，不参考系统偏好", () => {
    assert.equal(resolveTheme("dark", true), "dark");
    assert.equal(resolveTheme("dark", false), "dark");
    assert.equal(resolveTheme("light", true), "light");
    assert.equal(resolveTheme("light", false), "light");
  });

  it("system 跟随 prefers-color-scheme（03 §3.2 跟随系统映射）", () => {
    assert.equal(resolveTheme("system", true), "light");
    assert.equal(resolveTheme("system", false), "dark");
  });
});

describe("nextTheme（切换循环）", () => {
  it("深色 → 浅色 → 跟随系统 → 深色", () => {
    assert.equal(nextTheme("dark"), "light");
    assert.equal(nextTheme("light"), "system");
    assert.equal(nextTheme("system"), "dark");
  });
});

describe("持久化存取", () => {
  it("合法偏好原样读回", () => {
    const storage = fakeStorage({ [THEME_STORAGE_KEY]: "light" });
    assert.equal(loadThemePref(storage), "light");
  });

  it("损坏值 / 缺省回退深色（03 §2.2 深色优先）", () => {
    assert.equal(loadThemePref(fakeStorage({ [THEME_STORAGE_KEY]: "sepia" })), "dark");
    assert.equal(loadThemePref(fakeStorage()), "dark");
  });

  it("saveThemePref 写入后可读回（isThemePref 校验语义）", () => {
    const storage = fakeStorage();
    saveThemePref(storage, "system");
    assert.equal(storage.dump()[THEME_STORAGE_KEY], "system");
    assert.equal(loadThemePref(storage), "system");
    assert.equal(isThemePref("system"), true);
    assert.equal(isThemePref("auto"), false);
    assert.equal(isThemePref(null), false);
  });
});
