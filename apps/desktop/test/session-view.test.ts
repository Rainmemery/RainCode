/**
 * session-view reducer 单测（T3.9 UI-4）：
 * 全局事件（mcp.server_status_changed / plugin.status_changed）状态投影 + 斜杠命令解析。
 * refine-ui-context-panel 轮追加：子代理事件归并（applySubagentEvent）+ 会话时间分组
 * （groupSessions）+ ctx 用量阈值分档（ctxLevel），与 Web 端 session-view 同构镜像。
 * reducer 为纯函数（不依赖 react/zustand），node:test 直跑。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applySessionEvent,
  initialDesktopState,
  parseSlashInvocation,
  summarizeInput,
} from "../src/renderer/session-view.js";
import { applySubagentEvent, ctxLevel, groupSessions } from "../src/renderer/subagent-view.js";
import { rebuildItemsFromHistory } from "../src/renderer/history-rebuild.js";
import type { ChatItem, ToolItem } from "../src/renderer/session-view.js";
import type { McpServerStatusEntry, PluginSummary } from "@raincode/shared";

function stateWithMcp(servers: McpServerStatusEntry[]): ReturnType<typeof initialDesktopState> {
  return { ...initialDesktopState(), mcpServers: servers };
}

function stateWithPlugins(plugins: PluginSummary[]): ReturnType<typeof initialDesktopState> {
  return { ...initialDesktopState(), plugins };
}

describe("applySessionEvent 全局事件投影（UI-4 扩展面板）", () => {
  it("mcp.server_status_changed 更新既有行：status/toolCount/lastError，enabled 不被改写", () => {
    const base = stateWithMcp([
      { serverKey: "fs", transport: "stdio", status: "Connecting", enabled: true },
    ]);
    const next = applySessionEvent(base, "mcp.server_status_changed", {
      serverKey: "fs",
      status: "Connected",
      toolCount: 3,
    });
    assert.equal(next.mcpServers.length, 1);
    assert.equal(next.mcpServers[0]!.status, "Connected");
    assert.equal(next.mcpServers[0]!.toolCount, 3);
    assert.equal(next.mcpServers[0]!.enabled, true);
    assert.equal(next.mcpServers[0]!.lastError, undefined);
  });

  it("mcp.server_status_changed 失败态落 lastError；未拉取过列表的 serverKey 忽略", () => {
    const base = stateWithMcp([
      { serverKey: "fs", transport: "stdio", status: "Connected", enabled: true },
    ]);
    const failed = applySessionEvent(base, "mcp.server_status_changed", {
      serverKey: "fs",
      status: "Failed",
      error: "spawn ENOENT",
    });
    assert.equal(failed.mcpServers[0]!.status, "Failed");
    assert.equal(failed.mcpServers[0]!.lastError, "spawn ENOENT");
    const unknown = applySessionEvent(base, "mcp.server_status_changed", {
      serverKey: "ghost",
      status: "Connected",
    });
    assert.equal(unknown.mcpServers.length, 1);
  });

  it("plugin.status_changed 更新既有行 status/lastError；未知插件忽略；载荷缺失字段整体忽略", () => {
    const base = stateWithPlugins([
      {
        name: "hello",
        description: "demo",
        dir: "/plugins/hello",
        enabled: true,
        status: "active",
        tools: ["plugin__hello__greet"],
        lastError: null,
      },
    ]);
    const next = applySessionEvent(base, "plugin.status_changed", {
      name: "hello",
      status: "failed",
      error: "activate threw",
    });
    assert.equal(next.plugins[0]!.status, "failed");
    assert.equal(next.plugins[0]!.lastError, "activate threw");
    const unknown = applySessionEvent(base, "plugin.status_changed", { name: "ghost", status: "active" });
    assert.equal(unknown.plugins.length, 1);
    assert.equal(applySessionEvent(base, "plugin.status_changed", {}).plugins.length, 1);
  });

  it("会话域事件不受全局事件分支影响（回归护栏）：message.delta 仍进会话流", () => {
    const base = initialDesktopState();
    const next = applySessionEvent(base, "message.delta", {
      sessionId: "s1",
      delta: { type: "text", text: "hello" },
    });
    const view = next.views["s1"];
    assert.ok(view !== undefined);
    assert.equal(view.items.length, 1);
  });
});

describe("parseSlashInvocation（T3.9 斜杠命令面板）", () => {
  it("无参 / 有参 / 多空格参数", () => {
    assert.deepEqual(parseSlashInvocation("/review"), { name: "review" });
    assert.deepEqual(parseSlashInvocation("/review src/app.ts"), { name: "review", args: "src/app.ts" });
    assert.deepEqual(parseSlashInvocation("/review   多段 参数  "), { name: "review", args: "多段 参数" });
  });

  it("非斜杠 / 裸斜杠 / 非法名字域 → null（按普通文本发送）", () => {
    assert.equal(parseSlashInvocation("hello world"), null);
    assert.equal(parseSlashInvocation("/"), null);
    assert.equal(parseSlashInvocation("/Bad_Name"), null);
    assert.equal(parseSlashInvocation("/名称"), null);
  });
});

describe("message.delta reasoning 累积（UI 重设计二轮思考块，03 §6.1 v1.2）", () => {
  it("reasoning 先行到达：新建流式助手项，text 空串起步、reasoning 落字段", () => {
    const next = applySessionEvent(initialDesktopState(), "message.delta", {
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
    let state = initialDesktopState();
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
    let state = applySessionEvent(initialDesktopState(), "message.delta", {
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
    const next = applySessionEvent(initialDesktopState(), "message.delta", {
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
    let state = applySessionEvent(initialDesktopState(), "tool_call.started", {
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

describe("applySubagentEvent（refine-ui-context-panel 轮：全局子代理事件归并）", () => {
  const spawnedPayload = {
    subagentId: "sa1",
    profileName: "reviewer",
    taskPreview: "审查 src/rpc",
    status: "Pending",
    queuePosition: 1,
    ts: 1_000,
  };

  it("spawned 归属=事件到达时 activeId：新记录追加尾部；status 非法回退 Running；同 id 原位更新", () => {
    const base = { ...initialDesktopState(), activeId: "s1" };
    const next = applySubagentEvent(base, "subagent.spawned", spawnedPayload);
    assert.equal(next.subagents.length, 1);
    const record = next.subagents[0]!;
    assert.equal(record.sessionId, "s1");
    assert.equal(record.profileName, "reviewer");
    assert.equal(record.taskPreview, "审查 src/rpc");
    assert.equal(record.status, "Pending");
    assert.equal(record.startedAt, 1_000);
    assert.equal(record.stage, null);
    assert.equal(record.summary, null);
    assert.equal(record.completedAt, null);
    assert.equal(record.turnsUsed, null);
    // activeId=null（无活跃会话）归属 null
    const orphan = applySubagentEvent(initialDesktopState(), "subagent.spawned", spawnedPayload);
    assert.equal(orphan.subagents[0]!.sessionId, null);
    // spawned 载荷 status 非法（仅 Pending/Running 合法）→ 回退 Running
    const fallback = applySubagentEvent(base, "subagent.spawned", {
      ...spawnedPayload,
      subagentId: "sa2",
      status: "Completed",
    });
    assert.equal(fallback.subagents.length, 1);
    assert.equal(fallback.subagents[0]!.status, "Running");
    // 同 id 重复 spawned（重连补推）：原位更新不重复追加
    const replay = applySubagentEvent(next, "subagent.spawned", { ...spawnedPayload, status: "Running", ts: 2_000 });
    assert.equal(replay.subagents.length, 1);
    assert.equal(replay.subagents[0]!.status, "Running");
    assert.equal(replay.subagents[0]!.startedAt, 2_000);
  });

  it("progress 按 subagentId 更新 stage/summary（字符串才写）；找不到忽略", () => {
    const base = { ...initialDesktopState(), activeId: "s1" };
    let state = applySubagentEvent(base, "subagent.spawned", spawnedPayload);
    state = applySubagentEvent(state, "subagent.progress", {
      subagentId: "sa1",
      stage: "tool",
      summary: "读取 src/rpc/store.ts",
      ts: 2_000,
    });
    assert.equal(state.subagents[0]!.stage, "tool");
    assert.equal(state.subagents[0]!.summary, "读取 src/rpc/store.ts");
    // 非字符串 stage/summary 不写（保持现值）
    state = applySubagentEvent(state, "subagent.progress", { subagentId: "sa1", stage: 42, summary: 7 });
    assert.equal(state.subagents[0]!.stage, "tool");
    assert.equal(state.subagents[0]!.summary, "读取 src/rpc/store.ts");
    // 未知 subagentId 忽略
    const unknown = applySubagentEvent(state, "subagent.progress", { subagentId: "ghost", stage: "done" });
    assert.equal(unknown.subagents.length, 1);
    assert.equal(unknown.subagents[0]!.stage, "tool");
  });

  it("completed 收束：终态才写、summary 覆盖、completedAt=ts、turnsUsed 数字才写；非法终态与未知 id 忽略", () => {
    const base = { ...initialDesktopState(), activeId: "s1" };
    let state = applySubagentEvent(base, "subagent.spawned", spawnedPayload);
    state = applySubagentEvent(state, "subagent.progress", { subagentId: "sa1", stage: "tool", summary: "跑测试" });
    state = applySubagentEvent(state, "subagent.completed", {
      subagentId: "sa1",
      status: "Completed",
      summary: "审查完成：2 个问题",
      usage: { inputTokens: 10, outputTokens: 5 },
      turnsUsed: 3,
      ts: 5_000,
    });
    const record = state.subagents[0]!;
    assert.equal(record.status, "Completed");
    assert.equal(record.summary, "审查完成：2 个问题");
    assert.equal(record.completedAt, 5_000);
    assert.equal(record.turnsUsed, 3);
    // 非终态 status（Running）整体忽略
    const invalid = applySubagentEvent(state, "subagent.completed", {
      subagentId: "sa1",
      status: "Running",
      summary: "x",
      ts: 6_000,
    });
    assert.equal(invalid.subagents[0]!.status, "Completed");
    assert.equal(invalid.subagents[0]!.completedAt, 5_000);
    // 未知 subagentId 忽略
    const unknown = applySubagentEvent(state, "subagent.completed", {
      subagentId: "ghost",
      status: "Completed",
      summary: "x",
    });
    assert.equal(unknown.subagents.length, 1);
  });

  it("未知事件名或 subagentId 非字符串 → 原样返回（不新建记录）", () => {
    const base = { ...initialDesktopState(), activeId: "s1" };
    assert.equal(applySubagentEvent(base, "subagent.paused", { subagentId: "sa1" }), base);
    assert.equal(applySubagentEvent(base, "subagent.spawned", { subagentId: 42 }), base);
    assert.equal(applySubagentEvent(base, "subagent.spawned", {}), base);
  });
});

describe("groupSessions（refine-ui-context-panel 轮：今天/昨天/更早，本地时区自然日）", () => {
  const now = new Date(2026, 9, 4, 12, 0, 0).getTime(); // 2026-10-04 12:00 本地
  const dayStart = new Date(2026, 9, 4, 0, 0, 0).getTime();

  it("三组归属正确；组内保持入参顺序", () => {
    const rows = [
      { id: "a", lastActiveAt: dayStart + 60_000 }, // 今天 00:01
      { id: "b", lastActiveAt: now }, // 今天 12:00
      { id: "c", lastActiveAt: dayStart - 3_600_000 }, // 昨天 23:00
      { id: "d", lastActiveAt: dayStart - 86_400_000 * 3 }, // 三天前
    ];
    const groups = groupSessions(rows, now);
    assert.deepEqual(groups.today.map((r) => r.id), ["a", "b"]);
    assert.deepEqual(groups.yesterday.map((r) => r.id), ["c"]);
    assert.deepEqual(groups.earlier.map((r) => r.id), ["d"]);
  });

  it("跨日边界：昨天 00:00 归昨天、前天 23:59 归更早；空列表三组皆空", () => {
    const rows = [
      { id: "x", lastActiveAt: new Date(2026, 9, 2, 23, 59).getTime() },
      { id: "y", lastActiveAt: new Date(2026, 9, 3, 0, 0).getTime() },
    ];
    const groups = groupSessions(rows, now);
    assert.deepEqual(groups.yesterday.map((r) => r.id), ["y"]);
    assert.deepEqual(groups.earlier.map((r) => r.id), ["x"]);
    const empty = groupSessions([], now);
    assert.equal(empty.today.length, 0);
    assert.equal(empty.yesterday.length, 0);
    assert.equal(empty.earlier.length, 0);
  });
});

describe("ctxLevel（refine-ui-context-panel 轮：ctx 用量阈值分档，03 §7）", () => {
  it("70 → ok；85 → warn；96 → danger；边界 80/95", () => {
    assert.equal(ctxLevel(70), "ok");
    assert.equal(ctxLevel(85), "warn");
    assert.equal(ctxLevel(96), "danger");
    assert.equal(ctxLevel(80), "ok"); // >80 才转琥珀
    assert.equal(ctxLevel(95), "warn"); // >95 才转红
  });
});
