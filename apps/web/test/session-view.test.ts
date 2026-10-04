/**
 * session-view reducer 单测（UI 重设计二轮）：Web 端与桌面端同语义镜像——
 * message.delta reasoning 累积（思考块）+ summarizeInput v2（工具域主参数提炼）。
 * reducer 为纯函数，node:test 直跑。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applySessionEvent, initialWebState, summarizeInput } from "../src/session-view.js";
import type { ChatItem, ToolItem } from "../src/session-view.js";

describe("message.delta reasoning 累积（思考块，03 §6.1 v1.2）", () => {
  it("reasoning 先行到达：新建流式助手项，text 空串起步、reasoning 落字段", () => {
    const next = applySessionEvent(initialWebState(), "message.delta", {
      sessionId: "s1",
      model: "mock-model",
      delta: { type: "reasoning", text: "先读文件" },
    });
    const item = next.views["s1"]!.items[0] as ChatItem;
    assert.equal(item.kind, "message");
    assert.equal(item.role, "assistant");
    assert.equal(item.text, "");
    assert.equal(item.reasoning, "先读文件");
    assert.equal(item.streaming, true);
    assert.equal(item.model, "mock-model");
  });

  it("同一流式消息内 reasoning→text 交替：各自累积到对应字段", () => {
    let state = initialWebState();
    for (const delta of [
      { type: "reasoning", text: "思路A，" },
      { type: "reasoning", text: "思路B。" },
      { type: "text", text: "Hello" },
      { type: "text", text: " world" },
    ]) {
      state = applySessionEvent(state, "message.delta", { sessionId: "s1", delta });
    }
    const item = state.views["s1"]!.items[0] as ChatItem;
    assert.equal(item.reasoning, "思路A，思路B。");
    assert.equal(item.text, "Hello world");
    assert.equal(item.streaming, true);
  });

  it("message.completed 收束：streaming=false，reasoning 保留（折叠呈现由 UI 承担）", () => {
    let state = applySessionEvent(initialWebState(), "message.delta", {
      sessionId: "s1",
      delta: { type: "reasoning", text: "想一下" },
    });
    state = applySessionEvent(state, "message.delta", { sessionId: "s1", delta: { type: "text", text: "答案" } });
    state = applySessionEvent(state, "message.completed", {
      sessionId: "s1",
      message: { role: "assistant", content: "答案" },
    });
    const item = state.views["s1"]!.items[0] as ChatItem;
    assert.equal(item.streaming, false);
    assert.equal(item.text, "答案");
    assert.equal(item.reasoning, "想一下");
  });

  it("未知 delta 类型整体忽略（06 §7.4）：不建视图不建项", () => {
    const next = applySessionEvent(initialWebState(), "message.delta", {
      sessionId: "s1",
      delta: { type: "tool", text: "x" },
    });
    assert.equal(next.views["s1"], undefined);
  });
});

describe("summarizeInput v2（工具域主参数提炼，03 §6.4 v1.2）", () => {
  it("bash 命令行（多行折叠单行，$ 前缀）", () => {
    assert.equal(summarizeInput({ command: "npm\ntest\n--filter x" }), "$ npm test --filter x");
  });

  it("grep/glob 模式 + 范围", () => {
    assert.equal(summarizeInput({ pattern: "throw new", path: "src" }), `"throw new" · src`);
    assert.equal(summarizeInput({ query: "TODO" }), `"TODO"`);
  });

  it("路径族（read/write/edit）与 web_fetch URL", () => {
    assert.equal(summarizeInput({ file_path: "src/session/manager.ts" }), "src/session/manager.ts");
    assert.equal(summarizeInput({ path: "out/a.txt", content: "huge" }), "out/a.txt");
    assert.equal(summarizeInput({ url: "https://example.com/v1" }), "https://example.com/v1");
  });

  it("agent 派发与技能", () => {
    assert.equal(summarizeInput({ profile: "reviewer", task: "审查 src/rpc" }), "reviewer · 审查 src/rpc");
    assert.equal(summarizeInput({ name: "review", arguments: "src" }), "/review");
  });

  it("未知形状回退紧凑 JSON；字符串原样；超长省略号截断；null/undefined 缺省", () => {
    assert.equal(summarizeInput({ foo: "bar" }), `{"foo":"bar"}`);
    assert.equal(summarizeInput("plain"), "plain");
    assert.equal(summarizeInput({ command: "x".repeat(200) })!.length, 121); // 120 字符 + …
    assert.equal(summarizeInput(null), undefined);
    assert.equal(summarizeInput(undefined), undefined);
  });

  it("reducer 接线：tool_call.started 的 argsPreview 使用 v2 摘要（回归护栏）", () => {
    const state = applySessionEvent(initialWebState(), "tool_call.started", {
      sessionId: "s1",
      toolCallId: "t1",
      toolName: "bash",
      input: { command: "pnpm test" },
    });
    const item = state.views["s1"]!.items[0] as ToolItem;
    assert.equal(item.argsPreview, "$ pnpm test");
  });
});
