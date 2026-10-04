/**
 * session-view reducer 单测（UI 重设计二轮）：Web 端与桌面端同语义镜像——
 * message.delta reasoning 累积（思考块）+ summarizeInput v2（工具域主参数提炼）。
 * reducer 为纯函数，node:test 直跑。
 * refine-ui-context-panel 轮追加：applySubagentEvent（全局子代理事件归并）+
 * groupSessions（会话列表时间分组）+ ctxLevel（context 用量阈值）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applySessionEvent,
  initialWebState,
  rebuildItemsFromHistory,
  summarizeInput,
} from "../src/session-view.js";
import { applySubagentEvent, ctxLevel, groupSessions } from "../src/subagent-view.js";
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

describe("rebuildItemsFromHistory（冷重建：v1.13 reasoning 落盘恢复 + 摘要 v2 重建）", () => {
  const history = [
    { id: "m1", role: "user", content: "把备注卡片改成流式布局" },
    { id: "m2", role: "assistant", content: "看完了，给两个方案。", reasoning: "先读文件再对比方案。" },
    {
      id: "m3",
      role: "assistant",
      content: [{ type: "tool_call", toolCallId: "t1", name: "read", arguments: { path: "src/store.ts" } }],
    },
    { id: "m4", role: "tool", toolCallId: "t1", content: "export class NoteStore {}", isError: false },
    { id: "m5", role: "assistant", content: "无思考的旧消息" },
  ];

  it("assistant 行 reasoning 恢复为思考块字段；无 reasoning 的行不设字段", () => {
    const items = rebuildItemsFromHistory(history);
    const withReasoning = items[1] as ChatItem;
    assert.equal(withReasoning.kind, "message");
    assert.equal(withReasoning.role, "assistant");
    assert.equal(withReasoning.text, "看完了，给两个方案。");
    assert.equal(withReasoning.reasoning, "先读文件再对比方案。");
    assert.equal(withReasoning.streaming, false);
    const without = items[3] as ChatItem;
    assert.equal(without.text, "无思考的旧消息");
    assert.equal(without.reasoning, undefined);
  });

  it("工具卡参数摘要走 summarizeInput v2（不再裸 JSON 墙），工具结果归并 contentPreview", () => {
    const items = rebuildItemsFromHistory(history);
    const card = items[2] as ToolItem;
    assert.equal(card.kind, "tool");
    assert.equal(card.toolName, "read");
    assert.equal(card.state, "ok");
    assert.equal(card.argsPreview, "src/store.ts");
    assert.equal(card.contentPreview, "export class NoteStore {}");
  });

  it("空 history → 空视图", () => {
    assert.equal(rebuildItemsFromHistory([]).length, 0);
  });
});

describe("applySubagentEvent（全局子代理事件归并，06 §3.2 C 组；归属=事件到达时活跃会话）", () => {
  it("spawned 建行并绑定事件到达时的 activeId；非法 status 回退 Running", () => {
    const next = applySubagentEvent({ activeId: "s1", subagents: [] }, "subagent.spawned", {
      ts: 1000,
      subagentId: "a1",
      profileName: "reviewer",
      taskPreview: "审查 src/rpc",
      status: "Whatever", // 非法值
    });
    assert.equal(next.activeId, "s1");
    assert.equal(next.subagents.length, 1);
    const row = next.subagents[0]!;
    assert.equal(row.subagentId, "a1");
    assert.equal(row.sessionId, "s1");
    assert.equal(row.status, "Running");
    assert.equal(row.profileName, "reviewer");
    assert.equal(row.taskPreview, "审查 src/rpc");
    assert.equal(row.startedAt, 1000);
    assert.equal(row.stage, null);
    assert.equal(row.completedAt, null);
    assert.equal(row.turnsUsed, null);
  });

  it("同 id 重派发更新原行不重复（顺序保留，startedAt 不改写）；新 id 追加尾部", () => {
    let state = applySubagentEvent({ activeId: "s1", subagents: [] }, "subagent.spawned", {
      ts: 1000,
      subagentId: "a1",
      profileName: "reviewer",
      taskPreview: "审查 src/rpc",
      status: "Running",
    });
    state = applySubagentEvent(state, "subagent.spawned", {
      ts: 2000,
      subagentId: "a1",
      profileName: "reviewer",
      taskPreview: "审查 src/rpc v2",
      status: "Pending",
      queuePosition: 1, // 忽略
    });
    assert.equal(state.subagents.length, 1);
    assert.equal(state.subagents[0]!.status, "Pending");
    assert.equal(state.subagents[0]!.taskPreview, "审查 src/rpc v2");
    assert.equal(state.subagents[0]!.startedAt, 1000);
    state = applySubagentEvent(state, "subagent.spawned", {
      ts: 3000,
      subagentId: "a2",
      profileName: "builder",
      taskPreview: "x",
      status: "Pending",
    });
    assert.equal(state.subagents.length, 2);
    assert.equal(state.subagents[0]!.subagentId, "a1");
    assert.equal(state.subagents[1]!.subagentId, "a2");
  });

  it("progress 更新 stage/summary（字符串才写）；未跟踪 subagentId 整体忽略", () => {
    let state = applySubagentEvent({ activeId: "s1", subagents: [] }, "subagent.spawned", {
      ts: 1000,
      subagentId: "a1",
      profileName: "reviewer",
      taskPreview: "审查 src/rpc",
      status: "Running",
    });
    state = applySubagentEvent(state, "subagent.progress", {
      ts: 1500,
      subagentId: "a1",
      stage: "tool",
      toolName: "read",
      summary: "读 src/rpc/client.ts",
    });
    assert.equal(state.subagents[0]!.stage, "tool");
    assert.equal(state.subagents[0]!.summary, "读 src/rpc/client.ts");
    const ghost = applySubagentEvent(state, "subagent.progress", { ts: 1600, subagentId: "ghost", stage: "done" });
    assert.equal(ghost, state); // 原样返回（同引用）
  });

  it("completed 收束 status/summary/completedAt/turnsUsed；非法终态不写", () => {
    let state = applySubagentEvent({ activeId: "s1", subagents: [] }, "subagent.spawned", {
      ts: 1000,
      subagentId: "a1",
      profileName: "reviewer",
      taskPreview: "审查 src/rpc",
      status: "Running",
    });
    state = applySubagentEvent(state, "subagent.completed", {
      ts: 5000,
      subagentId: "a1",
      status: "Completed",
      summary: "审查完成：2 处问题",
      usage: { inputTokens: 10, outputTokens: 5 },
      turnsUsed: 3,
    });
    assert.equal(state.subagents[0]!.status, "Completed");
    assert.equal(state.subagents[0]!.summary, "审查完成：2 处问题");
    assert.equal(state.subagents[0]!.completedAt, 5000);
    assert.equal(state.subagents[0]!.turnsUsed, 3);
    const before = state;
    state = applySubagentEvent(state, "subagent.completed", {
      ts: 6000,
      subagentId: "a1",
      status: "Running", // 非终态
      summary: "x",
      turnsUsed: 9,
    });
    assert.equal(state, before); // 原样返回
  });

  it("未知事件名与缺 subagentId 原样返回（同引用）", () => {
    const state = applySubagentEvent({ activeId: "s1", subagents: [] }, "subagent.spawned", {
      ts: 1000,
      subagentId: "a1",
      profileName: "reviewer",
      taskPreview: "t",
      status: "Running",
    });
    assert.equal(applySubagentEvent(state, "mcp.server_status_changed", { subagentId: "a1" }), state);
    assert.equal(applySubagentEvent(state, "subagent.spawned", { profileName: "x" }), state); // 缺 subagentId
    assert.equal(applySubagentEvent(state, "subagent.progress", {}), state);
    assert.equal(applySubagentEvent(state, "subagent.completed", { subagentId: 42 }), state); // 非字符串
  });
});

describe("groupSessions（会话列表时间分组，03 §6.1：本地时区自然日）", () => {
  const now = new Date("2026-10-04T15:00:00").getTime(); // 本地时区解析
  it("今天/昨天/三天前 → 三组归属与组内顺序保持", () => {
    const rows = [
      { id: "t1", lastActiveAt: new Date("2026-10-04T09:00:00").getTime() },
      { id: "t2", lastActiveAt: new Date("2026-10-04T12:00:00").getTime() },
      { id: "y1", lastActiveAt: new Date("2026-10-03T23:30:00").getTime() },
      { id: "e1", lastActiveAt: new Date("2026-10-01T08:00:00").getTime() },
    ];
    const groups = groupSessions(rows, now);
    assert.deepEqual(groups.today.map((r) => r.id), ["t1", "t2"]); // 组内保持入参顺序
    assert.deepEqual(groups.yesterday.map((r) => r.id), ["y1"]);
    assert.deepEqual(groups.earlier.map((r) => r.id), ["e1"]);
  });

  it("空列表 → 三组皆空", () => {
    const groups = groupSessions([], now);
    assert.deepEqual(groups, { today: [], yesterday: [], earlier: [] });
  });
});

describe("ctxLevel（context 用量阈值，03 §7：>95 红 / >80 琥珀）", () => {
  it("70→ok 85→warn 96→danger；边界 80/95/100", () => {
    assert.equal(ctxLevel(70), "ok");
    assert.equal(ctxLevel(85), "warn");
    assert.equal(ctxLevel(96), "danger");
    assert.equal(ctxLevel(80), "ok");
    assert.equal(ctxLevel(95), "warn");
    assert.equal(ctxLevel(100), "danger");
  });
});
