/**
 * session-view reducer 单测（T3.9 UI-4）：
 * 全局事件（mcp.server_status_changed / plugin.status_changed）状态投影 + 斜杠命令解析。
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
