/**
 * highlight 单测（polish-ui-states-and-runtime C2 / Task 5.2）：检索命中分段纯函数——
 * 多命中 / 大小写不敏感且保留原大小写 / 空或全空白 query 单段非命中 / 正则元字符按字面 /
 * query 超长 / 重复出现；分段拼接恒等于原文（无损）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { splitHighlight } from "../src/renderer/highlight.js";

/** 无损性断言：分段文本拼回原文，且 hit 段文本大小写与原文一致。 */
function rejoin(text: string, query: string): string {
  return splitHighlight(text, query)
    .map((segment) => segment.text)
    .join("");
}

describe("splitHighlight（检索命中分段）", () => {
  it("多命中：命中段与非命中段交替", () => {
    const segments = splitHighlight("迁移前重构，迁移后回归", "迁移");
    assert.deepEqual(segments, [
      { text: "迁移", hit: true },
      { text: "前重构，", hit: false },
      { text: "迁移", hit: true },
      { text: "后回归", hit: false },
    ]);
  });

  it("大小写不敏感且保留原始大小写", () => {
    const segments = splitHighlight("Hello HELLO hello", "hello");
    assert.deepEqual(segments, [
      { text: "Hello", hit: true },
      { text: " ", hit: false },
      { text: "HELLO", hit: true },
      { text: " ", hit: false },
      { text: "hello", hit: true },
    ]);
  });

  it("query 两端空白被裁剪后参与匹配", () => {
    assert.deepEqual(splitHighlight("abc", "  b  "), [
      { text: "a", hit: false },
      { text: "b", hit: true },
      { text: "c", hit: false },
    ]);
  });

  it("空 / 全空白 query → 单段非命中", () => {
    assert.deepEqual(splitHighlight("迁移说明", ""), [{ text: "迁移说明", hit: false }]);
    assert.deepEqual(splitHighlight("迁移说明", "   "), [{ text: "迁移说明", hit: false }]);
  });

  it("正则元字符按字面处理（不以用户输入构造 RegExp）", () => {
    assert.deepEqual(splitHighlight("a.*+b", ".*+"), [
      { text: "a", hit: false },
      { text: ".*+", hit: true },
      { text: "b", hit: false },
    ]);
    // 单个 `.` 不当作通配符：仅命中字面点号
    assert.deepEqual(splitHighlight("a.b", "."), [
      { text: "a", hit: false },
      { text: ".", hit: true },
      { text: "b", hit: false },
    ]);
    // 字符类形态亦不抛错
    assert.deepEqual(splitHighlight("x[1]", "[1]"), [
      { text: "x", hit: false },
      { text: "[1]", hit: true },
    ]);
  });

  it("query 长于原文 → 单段非命中", () => {
    assert.deepEqual(splitHighlight("ab", "abcdef"), [{ text: "ab", hit: false }]);
  });

  it("重复出现（含首尾）逐段命中，非重叠扫描", () => {
    assert.deepEqual(splitHighlight("foo foo foo", "foo"), [
      { text: "foo", hit: true },
      { text: " ", hit: false },
      { text: "foo", hit: true },
      { text: " ", hit: false },
      { text: "foo", hit: true },
    ]);
  });

  it("分段拼接恒等于原文（无损）", () => {
    for (const [text, query] of [
      ["", "abc"],
      ["abc", ""],
      ["迁移前重构，迁移后回归", "迁移"],
      ["Hello HELLO hello", "hello"],
      ["a.*+b", ".*+"],
    ] as const) {
      assert.equal(rejoin(text, query), text);
    }
  });
});
