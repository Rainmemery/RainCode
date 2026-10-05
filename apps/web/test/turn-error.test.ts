/**
 * turn-error reducer 单测（polish-ui-states-and-runtime §A2 回合失败重试）：
 * `error` 事件 payload（scope/code/message/recoverable/turnId）→ 结构化错误切片 + 字符串兼容路径。
 * 纯函数（不依赖 react/zustand），node:test 直跑；与桌面端同构镜像。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyErrorEvent, parseTurnError } from "../src/turn-error.js";

describe("parseTurnError（结构化回合错误解析）", () => {
  it("recoverable=true：scope/code/message/turnId 随行（可重试）", () => {
    const error = parseTurnError({
      scope: "turn",
      code: "TIMEOUT",
      message: "模型请求超时",
      recoverable: true,
      turnId: "t_01",
    });
    assert.deepEqual(error, {
      scope: "turn",
      code: "TIMEOUT",
      message: "模型请求超时",
      recoverable: true,
      turnId: "t_01",
    });
  });

  it("recoverable=false：不可重试标志原样保留（无 turnId 不设字段）", () => {
    const error = parseTurnError({
      scope: "session",
      code: "SESSION_ARCHIVED",
      message: "会话已归档",
      recoverable: false,
    });
    assert.equal(error?.recoverable, false);
    assert.equal(error?.scope, "session");
    assert.equal(error?.turnId, undefined);
  });

  it("缺 code / recoverable → null（不抛错，回落既有字符串横条）", () => {
    assert.equal(parseTurnError({ scope: "turn", message: "x" }), null); // 缺 code + recoverable
    assert.equal(parseTurnError({ code: "TURN_INTERNAL", message: "x" }), null); // 缺 recoverable
    assert.equal(parseTurnError({ recoverable: true, message: "x" }), null); // 缺 code
    assert.equal(parseTurnError({ code: "", recoverable: true }), null); // 空 code 视为缺失
    assert.equal(parseTurnError({ code: 42, recoverable: true }), null); // 类型不符
    assert.equal(parseTurnError({}), null);
  });

  it("未知 scope → 保底 system（不吞错误、可判读）", () => {
    const error = parseTurnError({ scope: "transport", code: "EIO", message: "socket", recoverable: false });
    assert.equal(error?.scope, "system");
    assert.equal(error?.code, "EIO");
  });

  it("兼容历史嵌套形态 { error: { ... } }（扁平字段优先）", () => {
    const nested = parseTurnError({
      error: { scope: "turn", code: "TURN_INTERNAL", message: "boom", recoverable: true },
    });
    assert.equal(nested?.code, "TURN_INTERNAL");
    assert.equal(nested?.recoverable, true);
  });
});

describe("applyErrorEvent（端层错误切片：字符串兼容 + 结构化增量）", () => {
  it("结构化 payload：error 字符串取 message，turnError 同步落地", () => {
    const next = applyErrorEvent({ scope: "turn", code: "TIMEOUT", message: "模型请求超时", recoverable: true });
    assert.equal(next.error, "模型请求超时");
    assert.equal(next.turnError?.code, "TIMEOUT");
  });

  it("缺结构化字段：字符串横条保留（历史嵌套 message 兜底），turnError 为 null", () => {
    const flat = applyErrorEvent({ turnId: "t1" });
    assert.equal(flat.error, "turn error");
    assert.equal(flat.turnError, null);
    const nested = applyErrorEvent({ error: { message: "legacy boom" } });
    assert.equal(nested.error, "legacy boom");
    assert.equal(nested.turnError, null);
  });
});
