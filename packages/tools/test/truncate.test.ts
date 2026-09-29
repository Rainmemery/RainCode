/**
 * truncateToByteBudget / OutputRingBuffer 单测（T2.7 任务 3）。
 * 02-module-design §2.4「输出超出 maxOutputBytes」：环形缓冲保留头 70% / 尾 30%，
 * 标记 truncated=true；本波增强——截断提示行补充总字节数 / omitted 字节数与分页建议。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OutputRingBuffer, truncateToByteBudget } from "../src/index.js";

/** 提示行固定片段（文案形态与工具输出风格一致，模型可读）。 */
const MARKER_HINT = "output truncated:";
/** 提示行完整边界（首尾 \n 属于提示行，见 truncate.ts makeTruncationMarker）。 */
const MARKER_HEAD = `\n…[${MARKER_HINT}`;
const MARKER_TAIL = "]…\n";

/** 从裁剪结果中拆出 head / marker / tail 三段（marker 形态见 truncate.ts makeTruncationMarker）。 */
function splitMarker(text: string): { head: string; marker: string; tail: string } {
  const markerStart = text.indexOf(MARKER_HEAD);
  assert.ok(markerStart >= 0, "截断结果应包含提示行");
  const markerEnd = text.indexOf(MARKER_TAIL, markerStart);
  assert.ok(markerEnd > markerStart, "提示行应以 ]… 收尾");
  return {
    head: text.slice(0, markerStart),
    marker: text.slice(markerStart, markerEnd + MARKER_TAIL.length),
    tail: text.slice(markerEnd + MARKER_TAIL.length),
  };
}

describe("truncateToByteBudget", () => {
  it("未超预算：原样返回，无提示行", () => {
    const text = "hello 世界 NovaCode";
    const result = truncateToByteBudget(text, 1024);
    assert.equal(result.truncated, false);
    assert.equal(result.text, text);
    assert.ok(!result.text.includes(MARKER_HINT), "未超限不得出现提示行");
  });

  it("恰好等于预算：不截断", () => {
    const text = "a".repeat(256);
    const result = truncateToByteBudget(text, 256);
    assert.equal(result.truncated, false);
    assert.equal(result.text, text);
  });

  it("超预算（ASCII）：结果不超预算，头尾为原文的 70%/30%，提示行含 total 与 omitted", () => {
    const text = "a".repeat(10_000);
    const maxBytes = 1_000;
    const total = Buffer.byteLength(text, "utf8");
    const result = truncateToByteBudget(text, maxBytes);
    assert.equal(result.truncated, true);
    assert.ok(
      Buffer.byteLength(result.text, "utf8") <= maxBytes,
      "裁剪结果（含提示行）不得超出预算",
    );

    const { head, marker, tail } = splitMarker(result.text);
    assert.ok(text.startsWith(head), "head 应为原文前缀");
    assert.ok(text.endsWith(tail), "tail 应为原文后缀");

    // 提示行携带 total / omitted 字节数（omitted = 被丢弃的中段，与字节口径一致）
    assert.ok(marker.includes(`of ${String(total)} bytes total`), `提示行应含总字节数：${marker}`);
    const omittedMatch = /(\d+) bytes omitted/.exec(marker);
    assert.notEqual(omittedMatch, null, `提示行应含 omitted 字节数：${marker}`);
    const omitted = Number(omittedMatch![1]);
    const keptBytes = Buffer.byteLength(head, "utf8") + Buffer.byteLength(tail, "utf8");
    assert.equal(omitted, total - keptBytes, "omitted 应等于被丢弃的中段字节数");
    assert.ok(omitted > 0, "omitted 必须为正");

    // 头 70% / 尾 30% 占比（02 §2.4）：实现按 omitted 数字最宽情形预留提示行字节，
    // 实际 omitted 位数更少时头尾各让出 ≤1 字节 → 精确断言放宽 ±1 字节
    const budget = maxBytes - Buffer.byteLength(marker, "utf8");
    const headBytes = Buffer.byteLength(head, "utf8");
    const tailBytes = Buffer.byteLength(tail, "utf8");
    const expectedHead = Math.floor(budget * 0.7);
    const expectedTail = budget - expectedHead;
    assert.ok(
      headBytes <= expectedHead && headBytes >= expectedHead - 1,
      `head 应为预算的 70%（±1 字节估计余量）：${String(headBytes)} vs ${String(expectedHead)}`,
    );
    assert.ok(
      tailBytes <= expectedTail && tailBytes >= expectedTail - 1,
      `tail 应为预算的 30%（±1 字节估计余量）：${String(tailBytes)} vs ${String(expectedTail)}`,
    );
  });

  it("多字节 UTF-8 切点回退：无残缺码元（U+FFFD），切点落在字符边界", () => {
    const text = "中".repeat(2_000); // 每字符 3 字节
    const result = truncateToByteBudget(text, 900);
    assert.equal(result.truncated, true);
    assert.ok(!result.text.includes("\uFFFD"), "不得产生残缺码元");

    const { head, tail } = splitMarker(result.text);
    assert.equal(Buffer.byteLength(head, "utf8") % 3, 0, "head 切点应回退到 3 字节字符边界");
    assert.equal(Buffer.byteLength(tail, "utf8") % 3, 0, "tail 切点应落在字符边界");
  });

  it("预算非法（≤0 / 非有限）：返回空文本并标记截断", () => {
    assert.deepEqual(truncateToByteBudget("abc", 0), { text: "", truncated: true });
    assert.deepEqual(truncateToByteBudget("abc", -5), { text: "", truncated: true });
    assert.deepEqual(truncateToByteBudget("abc", Number.NaN), { text: "", truncated: true });
    assert.deepEqual(truncateToByteBudget("", 0), { text: "", truncated: false });
  });

  it("极小预算（小于提示行）：保留提示行本体", () => {
    const result = truncateToByteBudget("a".repeat(500), 16);
    assert.equal(result.truncated, true);
    assert.ok(result.text.includes(MARKER_HINT), "极小预算下保提示行（指引模型自纠）");
  });
});

describe("OutputRingBuffer", () => {
  it("未超预算：truncated=false，text 为原样拼接", () => {
    const buffer = new OutputRingBuffer(1024);
    buffer.push(Buffer.from("hello ", "utf8"));
    buffer.push(Buffer.from("world", "utf8"));
    assert.equal(buffer.truncated, false);
    assert.equal(buffer.text(), "hello world");
    assert.equal(buffer.byteLength, 11);
  });

  it("超预算：仅留头尾窗口，text 提示行含 total / omitted 字节数", () => {
    const buffer = new OutputRingBuffer(300);
    const chunk = Buffer.from("x".repeat(100), "utf8");
    for (let i = 0; i < 10; i += 1) {
      buffer.push(chunk); // 总量 1000 字节，窗口 300 字节（head 210 / tail 90）
    }
    assert.equal(buffer.truncated, true);
    assert.equal(buffer.byteLength, 1_000);

    const text = buffer.text();
    const { head, marker, tail } = splitMarker(text);
    assert.ok(marker.includes(`of ${String(1_000)} bytes total`), `提示行应含总字节数：${marker}`);
    const omittedMatch = /(\d+) bytes omitted/.exec(marker);
    assert.notEqual(omittedMatch, null, `提示行应含 omitted 字节数：${marker}`);
    const keptBytes = Buffer.byteLength(head, "utf8") + Buffer.byteLength(tail, "utf8");
    assert.equal(Number(omittedMatch![1]), 1_000 - keptBytes, "omitted 应等于窗口外字节数");
    assert.ok(Number(omittedMatch![1]) > 0);
  });
});
