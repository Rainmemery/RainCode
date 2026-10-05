/**
 * turn-error 纯解析单测（polish-ui-states-and-runtime §A2）：桌面端与 Web 端同语义镜像。
 * error 事件结构化投影解析：recoverable 两态 + 缺字段回落（不抛错）+ 未知 scope 保守回落；
 * 另覆盖桌面端 applyErrorEvent 切片的字符串兼容路径。纯函数，node:test 直跑。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyErrorEvent, parseTurnError } from "../src/renderer/turn-error.js";

describe("parseTurnError（error 事件结构化投影，06 §3.2）", () => {
  it("recoverable true：完整结构化字段落 TurnError（含 turnId）", () => {
    const parsed = parseTurnError({
      scope: "turn",
      code: "TIMEOUT",
      message: "回合超时",
      recoverable: true,
      turnId: "t-1",
    });
    assert.deepEqual(parsed, { scope: "turn", code: "TIMEOUT", message: "回合超时", recoverable: true, turnId: "t-1" });
  });

  it("recoverable false：结构保留、不可重试", () => {
    const parsed = parseTurnError({ scope: "session", code: "CONFIG_PROVIDER_NOT_FOUND", message: "无 Provider", recoverable: false });
    assert.equal(parsed?.recoverable, false);
    assert.equal(parsed?.scope, "session");
    assert.equal(parsed?.turnId, undefined);
  });

  it("缺 code → null（回落既有字符串横条，不抛错）", () => {
    assert.equal(parseTurnError({ scope: "turn", message: "boom", recoverable: true }), null);
  });

  it("缺 recoverable → 不抛错且默认不可重试", () => {
    const parsed = parseTurnError({ scope: "turn", code: "TURN_INTERNAL", message: "boom" });
    assert.equal(parsed?.recoverable, false);
    assert.equal(parsed?.code, "TURN_INTERNAL");
  });

  it("未知 scope → null（保守回落，不臆造回合归属）", () => {
    assert.equal(parseTurnError({ scope: "weird", code: "X", message: "m", recoverable: true }), null);
  });

  it("非对象 / 缺 message → null", () => {
    assert.equal(parseTurnError(null), null);
    assert.equal(parseTurnError("boom"), null);
    assert.equal(parseTurnError({ scope: "turn", code: "X" }), null);
  });
});

describe("applyErrorEvent（端层错误切片：字符串兼容 + 结构化增量）", () => {
  it("结构化 payload：error 字符串取 message，turnError 同步落地", () => {
    const next = applyErrorEvent({ scope: "turn", code: "TIMEOUT", message: "回合超时", recoverable: true });
    assert.equal(next.error, "回合超时");
    assert.equal(next.turnError?.code, "TIMEOUT");
  });

  it("非结构化 payload：字符串横条保留，turnError 为 null（旧端兼容）", () => {
    assert.deepEqual(applyErrorEvent({ error: { message: "legacy boom" } }), { error: "legacy boom", turnError: null });
    assert.deepEqual(applyErrorEvent({}), { error: "turn error", turnError: null });
  });
});
