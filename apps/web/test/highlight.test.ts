/**
 * highlight 纯函数单测（polish-ui-states-and-runtime 轮 C2）：多命中 / 大小写不敏感 /
 * 空 query 原样 / 正则元字符安全 / query 长于文本 / 重复命中非重叠推进。node:test 直跑。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { splitHighlight } from "../src/highlight.js";

describe("splitHighlight（检索命中分段）", () => {
  it("多命中：逐段切分且顺序与原大小写保留", () => {
    assert.deepEqual(splitHighlight("记忆迁移与迁移记录", "迁移"), [
      { text: "记忆", hit: false },
      { text: "迁移", hit: true },
      { text: "与", hit: false },
      { text: "迁移", hit: true },
      { text: "记录", hit: false },
    ]);
  });

  it("大小写不敏感：命中段保留原文大小写", () => {
    assert.deepEqual(splitHighlight("RainCode raincode RAINCODE", "raincode"), [
      { text: "RainCode", hit: true },
      { text: " ", hit: false },
      { text: "raincode", hit: true },
      { text: " ", hit: false },
      { text: "RAINCODE", hit: true },
    ]);
  });

  it("空 / 纯空白 query → 单段非命中（原样）", () => {
    assert.deepEqual(splitHighlight("任意文本", ""), [{ text: "任意文本", hit: false }]);
    assert.deepEqual(splitHighlight("任意文本", "   "), [{ text: "任意文本", hit: false }]);
    assert.deepEqual(splitHighlight("", "迁移"), [{ text: "", hit: false }]);
  });

  it("正则元字符零语义（.*+?[] 等按字面匹配，不构造 RegExp）", () => {
    assert.deepEqual(splitHighlight("匹配 a.*+?[]b 结束", ".*+?[]"), [
      { text: "匹配 a", hit: false },
      { text: ".*+?[]", hit: true },
      { text: "b 结束", hit: false },
    ]);
    // 字面 "a.c" 不得命中 "abc"
    assert.deepEqual(splitHighlight("abc", "a.c"), [{ text: "abc", hit: false }]);
  });

  it("query 长于文本 → 单段非命中", () => {
    assert.deepEqual(splitHighlight("短", "远长于文本的查询"), [{ text: "短", hit: false }]);
  });

  it("重复命中非重叠推进（overlapping-ish repeats）", () => {
    assert.deepEqual(splitHighlight("aaaa", "aa"), [
      { text: "aa", hit: true },
      { text: "aa", hit: true },
    ]);
    assert.deepEqual(splitHighlight("aaa", "aa"), [
      { text: "aa", hit: true },
      { text: "a", hit: false },
    ]);
  });
});
