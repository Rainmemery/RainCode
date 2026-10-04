/**
 * buildAssistantRecord 单测（协议 v1.13 additive：reasoning 随 assistant 行落盘）——
 * 纯文本行 / 工具调用行两条路径的 reasoning 字段随行与空串省略口径。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildAssistantRecord } from "../src/turn/round-helpers.js";

describe("buildAssistantRecord（reasoning 随行落盘，v1.13）", () => {
  it("纯文本行：reasoning 非空随行，空串省略", () => {
    const withReasoning = buildAssistantRecord("答案", null, "先想一想");
    assert.equal(withReasoning.role, "assistant");
    assert.equal(withReasoning.content, "答案");
    assert.equal(withReasoning.reasoning, "先想一想");

    const without = buildAssistantRecord("答案", null);
    assert.equal(without.reasoning, undefined);
    assert.equal("reasoning" in without, false);
  });

  it("工具调用行：tool_call 块数组 + reasoning 随行（思考块跨重启恢复）", () => {
    const record = buildAssistantRecord(
      "我先看一下",
      [{ toolCallId: "t1", toolName: "read", argumentsJSON: '{"path":"src/a.ts"}' }],
      "推理过程",
    );
    assert.ok(Array.isArray(record.content));
    const blocks = record.content as Array<{ type: string; text?: string; name?: string }>;
    assert.equal(blocks[0]!.type, "text");
    assert.equal(blocks[1]!.type, "tool_call");
    assert.equal(blocks[1]!.name, "read");
    assert.equal(record.reasoning, "推理过程");
  });
});
