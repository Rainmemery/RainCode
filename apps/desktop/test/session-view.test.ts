/**
 * session-view reducer 单测（T3.9 UI-4）：
 * 全局事件（mcp.server_status_changed / plugin.status_changed）状态投影 + 斜杠命令解析。
 * reducer 为纯函数（不依赖 react/zustand），node:test 直跑。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applySessionEvent, initialDesktopState, parseSlashInvocation } from "../src/renderer/session-view.js";
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
