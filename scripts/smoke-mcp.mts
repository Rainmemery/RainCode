/**
 * MCP 接入 smoke（M2 T2.2，02-module-design §3 / 06-api-spec §2.5）。
 * 运行：tsx scripts/smoke-mcp.mts（或 pnpm run smoke:mcp）
 *
 * 链路：node:http mock OpenAI SSE（turn 内模型工具调用用）+ 两个手写 JSON-RPC fixture server
 * （scripts/mcp-fixture-stdio.mjs stdio 子进程 / mcp-fixture-http.mjs Streamable HTTP）——
 * 与 SDK client 的真实互操作（协议层真实，非 mock）→ 临时 RAINCODE_HOME + mcp.json 双 server 配置
 * → createAgentServiceNode（mcp 域装配）→ 断言：
 * 用例 A 配置加载与连接状态机：alpha → Connected（事件），broken（命令不存在）→ Failed（M3，
 *   失败隔离不阻塞 alpha）；servers.list 状态投影正确。
 * 用例 B 命名空间工具：mcp.tools.list 含 mcp__alpha__echo/crash（available）；tool.tools.list 可见。
 * 用例 C 控制面直调：mcp.tools.call 走 ToolExecutor → 回显内容正确。
 * 用例 D 模型调用：turn 内 mock LLM 发 mcp__alpha__echo tool_call → 权限链（needsApproval 从严）
 *   → 执行回传 → tool_call.completed 内容正确。
 * 用例 E 进程树管理：crash 工具致子进程退出 → connection_lost → Reconnecting（M4）→
 *   退避重连成功 → Connected（M5 重新 listTools）。
 * 用例 F HTTP transport + add/remove：spawn fixture-http → mcp.servers.add（持久化写盘）→
 *   Connected → mcp.tools.call 回显 → remove → 工具注销 + Disconnected（M8）。
 * 用例 G 运行时启停 + 健康检查（T3.7）：health on Connected 主动 ping 实测 RTT / Failed 只读投影；
 *   setEnabled false → 断连 + 工具不可用 + mcp.json enabled:false（配置保留）；setEnabled true →
 *   重连 Connected + 工具恢复 + enabled:true 持久化；未知 serverKey → MCP_SERVER_NOT_FOUND。
 * 全程仅本机回环与临时目录：无外呼、无真实密钥。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemoryTransportPair, createRpcClient, RpcCallError } from "../packages/rpc/src/index.ts";
import type { RpcClient } from "../packages/rpc/src/index.ts";
import { createAgentServiceNode } from "../packages/server/src/index.ts";
import type { AgentServiceNode } from "../packages/server/src/index.ts";
import type {
  McpServerStatusChangedEventPayload,
  McpServersAddResult,
  McpServersHealthResult,
  McpServersListResult,
  McpServersSetEnabledResult,
  McpToolsCallResult,
  McpToolsListResult,
  SessionCreateResult,
  SessionSendResult,
  ToolCallCompletedEventPayload,
  ToolToolsListResult,
} from "../packages/shared/src/index.ts";
import { beginTurn, startMockLlmServer, textScript, toolCallFrame, withTimeout } from "./p0-lib.mts";
import type { SseScript } from "./p0-lib.mts";

const REPO_ROOT = join(import.meta.dirname, "..");
const FIXTURE_STDIO = join(import.meta.dirname, "mcp-fixture-stdio.mjs");
const FIXTURE_HTTP = join(import.meta.dirname, "mcp-fixture-http.mjs");
const CONNECT_TIMEOUT = 15000;

// ---------------------------------------------------------------------------
// 场景装配：临时 RAINCODE_HOME + mcp.json + in-memory 服务节点 + RPC 客户端
// ---------------------------------------------------------------------------

interface StatusWatch {
  events: McpServerStatusChangedEventPayload[];
  toolCompleted: ToolCallCompletedEventPayload[];
  stop: () => void;
}

interface Scenario {
  home: string;
  client: RpcClient;
  node: AgentServiceNode;
  watch: StatusWatch;
  setScript: (script: SseScript[]) => void;
  close: () => Promise<void>;
}

async function startScenario(script: SseScript[]): Promise<Scenario> {
  const home = await mkdtemp(join(tmpdir(), "raincode-smoke-mcp-"));
  const workspace = join(home, "ws");
  await mkdir(workspace, { recursive: true });
  const mcpConfig = {
    mcpServers: {
      alpha: {
        serverKey: "alpha",
        transport: "stdio",
        command: process.execPath,
        args: [FIXTURE_STDIO, "alpha"],
        timeoutMs: 5000,
        enabled: true,
      },
      broken: {
        serverKey: "broken",
        transport: "stdio",
        command: "definitely-not-exist-cmd-xyz",
        enabled: true,
      },
    },
  };
  await writeFile(join(home, "mcp.json"), JSON.stringify(mcpConfig, null, 2), "utf8");
  const mock = await startMockLlmServer();
  mock.setScript(script);
  const transports = createInMemoryTransportPair();
  const node = await createAgentServiceNode(transports[1], {
    env: { RAINCODE_HOME: home },
    provider: {
      name: "mock-mcp",
      baseURL: mock.url,
      model: "mock-model",
      apiKey: "smoke-dummy-key",
      maxContextTokens: 8192,
    },
    tools: { approval: "always-allow" },
    permission: { policy: "default-allow" },
    mcp: { workspaceRoot: workspace },
  });
  const client = createRpcClient({ transport: transports[0] });
  await client.call("system.ping", {});
  const events: McpServerStatusChangedEventPayload[] = [];
  const toolCompleted: ToolCallCompletedEventPayload[] = [];
  const offStatus = client.onEvent("mcp.server_status_changed", (payload) =>
    events.push(payload as McpServerStatusChangedEventPayload));
  const offTool = client.onEvent("tool_call.completed", (payload) =>
    toolCompleted.push(payload as ToolCallCompletedEventPayload));
  return {
    home,
    client,
    node,
    watch: { events, toolCompleted, stop: () => { offStatus(); offTool(); } },
    setScript: mock.setScript,
    close: async () => {
      client.close();
      await node.close();
      await transports[0].close();
      await transports[1].close();
      await mock.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

/** 轮询状态事件（全局事件异步到达；onlyNew=true 时只看进入后新到的事件）。 */
async function waitForStatus(
  watch: StatusWatch,
  predicate: (event: McpServerStatusChangedEventPayload) => boolean,
  label: string,
  timeoutMs = CONNECT_TIMEOUT,
  onlyNew = false,
): Promise<McpServerStatusChangedEventPayload> {
  const start = onlyNew ? watch.events.length : 0;
  return withTimeout(
    (async () => {
      for (;;) {
        const found = watch.events.slice(start).reverse().find(predicate);
        if (found !== undefined) {
          return found;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    })(),
    timeoutMs,
    label,
  );
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

async function caseConnectAndNamespace(): Promise<Scenario> {
  const scenario = await startScenario([textScript("ready", 0)]);
  const { client, watch } = scenario;

  // A：alpha Connected（M2 + listTools 后带工具数）、broken Failed（M3，spawn 失败失败隔离）
  const alphaConnected = await waitForStatus(
    watch,
    (e) => e.serverKey === "alpha" && e.status === "Connected" && (e.toolCount ?? 0) > 0,
    "alpha Connected",
  );
  assert.ok(alphaConnected.toolCount !== undefined && alphaConnected.toolCount > 0, "Connected 后带工具数");
  const brokenFailed = await waitForStatus(watch, (e) => e.serverKey === "broken" && e.status === "Failed", "broken Failed");
  assert.ok(brokenFailed.error !== undefined && brokenFailed.error.length > 0, "Failed 附错误详情");
  const list = (await client.call("mcp.servers.list", {})) as McpServersListResult;
  const alphaEntry = list.servers.find((s) => s.serverKey === "alpha");
  const brokenEntry = list.servers.find((s) => s.serverKey === "broken");
  assert.equal(alphaEntry?.status, "Connected");
  assert.equal(brokenEntry?.status, "Failed");
  console.log("case A: 配置加载 + 连接状态机（Connected/Failed 失败隔离）OK");

  // B：命名空间工具
  const tools = (await client.call("mcp.tools.list", { serverKey: "alpha" })) as McpToolsListResult;
  assert.equal(tools.tools.length, 2);
  const echo = tools.tools.find((t) => t.name === "mcp__alpha__echo");
  assert.ok(echo !== undefined, "mcp__alpha__echo 在列");
  assert.equal(echo.available, true);
  assert.deepEqual(echo.inputSchema, {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  });
  const allTools = (await client.call("tool.tools.list", {})) as ToolToolsListResult;
  assert.ok(allTools.tools.some((t) => t.name === "mcp__alpha__echo" && t.source === "mcp"), "命名空间工具进注册表");
  console.log("case B: 命名空间工具（mcp__alpha__echo）注册 OK");
  return scenario;
}

async function caseControlCall(scenario: Scenario): Promise<void> {
  // C：控制面直调（ToolExecutor 链路）
  const call = (await scenario.client.call("mcp.tools.call", {
    serverKey: "alpha",
    toolName: "echo",
    args: { text: "hi" },
  })) as McpToolsCallResult;
  assert.equal(call.isError, false);
  assert.equal(call.content, "echo(alpha): hi");
  console.log("case C: mcp.tools.call（ToolExecutor 链路）OK");
}

async function caseModelCall(scenario: Scenario): Promise<void> {
  // D：turn 内模型调用（needsApproval 从严 → default-allow 审批放行）
  scenario.setScript([
    {
      frames: [
        { choices: [{ index: 0, delta: { role: "assistant", content: "" } }] },
        toolCallFrame("call_mcp_1", "mcp__alpha__echo", { text: "from-model" }),
        { choices: [], usage: { prompt_tokens: 30, completion_tokens: 10 } },
      ],
      finish: "tool_calls",
    },
    textScript("echo tool said: done"),
  ]);
  const sessionId = ((await scenario.client.call("session.create", {
    workspaceRoot: REPO_ROOT,
  })) as SessionCreateResult).sessionId;
  const run = beginTurn(scenario.client, sessionId, "call the echo tool with text 'from-model'");
  const admission = (await run.sendPromise) as SessionSendResult;
  assert.equal(admission.admission, "started");
  await withTimeout(run.done, 20000, "model turn done");
  run.stop();
  const completed = scenario.watch.toolCompleted.find((e) => e.contentPreview?.includes("echo(alpha): from-model"));
  assert.ok(completed !== undefined, `mcp 工具结果回传（${JSON.stringify(scenario.watch.toolCompleted)}）`);
  assert.equal(completed.isError, false);
  console.log("case D: turn 内模型调用（权限链 + 命名空间工具执行）OK");
}

async function caseReconnect(scenario: Scenario): Promise<void> {
  // E：crash 工具 → 子进程退出 → M4 Reconnecting → 退避重连 → M5 Connected
  await scenario.client.call("mcp.tools.call", { serverKey: "alpha", toolName: "crash", args: {} });
  await waitForStatus(scenario.watch, (e) => e.serverKey === "alpha" && e.status === "Reconnecting", "alpha Reconnecting", CONNECT_TIMEOUT, true);
  await waitForStatus(
    scenario.watch,
    (e) => e.serverKey === "alpha" && e.status === "Connected" && (e.toolCount ?? 0) > 0,
    "alpha 重连成功",
    CONNECT_TIMEOUT,
    true,
  );
  const call = (await scenario.client.call("mcp.tools.call", {
    serverKey: "alpha",
    toolName: "echo",
    args: { text: "after-reconnect" },
  })) as McpToolsCallResult;
  assert.equal(call.content, "echo(alpha): after-reconnect");
  console.log("case E: 进程退出 → M4 重连 → M5 工具恢复 OK");
}

async function caseHttpAndRemove(scenario: Scenario): Promise<void> {
  // F：HTTP transport（fixture-http spawn）+ add 持久化 + remove 注销
  const http = spawn(process.execPath, [FIXTURE_HTTP, "0"], { stdio: ["ignore", "pipe", "ignore"] });
  let stdout = "";
  http.stdout!.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  try {
    const port = await withTimeout(
      (async () => {
        for (;;) {
          const ready = stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0).at(0);
          if (ready !== undefined) {
            return (JSON.parse(ready) as { port: number }).port;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      })(),
      10000,
      "http fixture ready",
    );
    const added = (await scenario.client.call("mcp.servers.add", {
      config: { serverKey: "remote", transport: "http", url: `http://127.0.0.1:${String(port)}/mcp`, timeoutMs: 5000, enabled: true },
      level: "global",
    })) as McpServersAddResult;
    assert.equal(added.serverKey, "remote");
    await waitForStatus(
      scenario.watch,
      (e) => e.serverKey === "remote" && e.status === "Connected" && (e.toolCount ?? 0) > 0,
      "remote Connected",
    );
    const call = (await scenario.client.call("mcp.tools.call", {
      serverKey: "remote",
      toolName: "echo",
      args: { text: "over-http" },
    })) as McpToolsCallResult;
    assert.equal(call.content, "echo(http-fixture): over-http");
    // 持久化写盘
    const persisted = JSON.parse(await readFile(join(scenario.home, "mcp.json"), "utf8")) as { mcpServers: Record<string, unknown> };
    assert.ok(persisted.mcpServers["remote"] !== undefined, "add 写回 mcp.json");
    // remove：断连 + 注销 + 持久化删除
    await scenario.client.call("mcp.servers.remove", { serverKey: "remote" });
    await assert.rejects(
      scenario.client.call("mcp.tools.list", { serverKey: "remote" }),
      (err: unknown) => err instanceof RpcCallError && err.code === "MCP_SERVER_NOT_FOUND",
    );
    assert.equal(
      (await scenario.client.call("mcp.servers.list", {}) as McpServersListResult).servers.some((s) => s.serverKey === "remote"),
      false,
      "remove 后 server 注销",
    );
    const allAfterRemove = (await scenario.client.call("mcp.tools.list", {})) as McpToolsListResult;
    assert.equal(allAfterRemove.tools.some((t) => t.name === "mcp__remote__echo"), false, "remove 后命名空间工具注销");
    console.log("case F: HTTP transport（add/call/remove + 持久化）OK");
  } finally {
    http.kill();
  }
}

async function caseSetEnabledAndHealth(scenario: Scenario): Promise<void> {
  const { client } = scenario;

  // G1 健康检查：Connected server 主动 ping（RTT 实测）；Failed server 只读投影 ok=false
  const alphaHealth = (await client.call("mcp.servers.health", { serverKey: "alpha" })) as McpServersHealthResult;
  assert.equal(alphaHealth.items.length, 1);
  const alpha = alphaHealth.items[0]!;
  assert.equal(alpha.ok, true, `alpha 健康检查通过（实际 ${JSON.stringify(alphaHealth)}）`);
  assert.equal(alpha.status, "Connected");
  assert.ok(typeof alpha.latencyMs === "number" && alpha.latencyMs >= 0, "latencyMs 实测值");
  const allHealth = (await client.call("mcp.servers.health", {})) as McpServersHealthResult;
  const broken = allHealth.items.find((item) => item.serverKey === "broken");
  assert.ok(broken !== undefined && broken.ok === false && broken.status === "Failed", "Failed server 只读投影 ok=false");

  // G2 停（setEnabled false）：断连 + 命名空间工具不可用 + enabled:false 持久化
  const stopped = (await client.call("mcp.servers.setEnabled", {
    serverKey: "alpha",
    enabled: false,
  })) as McpServersSetEnabledResult;
  assert.equal(stopped.enabled, false);
  assert.equal(stopped.status, "Disconnected");
  const toolsAfterStop = (await client.call("mcp.tools.list", {})) as McpToolsListResult;
  assert.equal(toolsAfterStop.tools.some((t) => t.name === "mcp__alpha__echo" && t.available), false, "停后工具不可用");
  await assert.rejects(
    client.call("mcp.tools.call", { serverKey: "alpha", toolName: "echo", args: { text: "x" } }),
    (err: unknown) => err instanceof RpcCallError && err.code === "MCP_UNAVAILABLE",
  );
  const persisted = JSON.parse(await readFile(join(scenario.home, "mcp.json"), "utf8")) as {
    mcpServers: Record<string, { enabled?: boolean }>;
  };
  assert.ok(persisted.mcpServers["alpha"] !== undefined, "alpha 配置保留（停 ≠ 删除）");
  assert.equal(persisted.mcpServers["alpha"]!.enabled, false, "enabled:false 写回 mcp.json");
  const healthStopped = (await client.call("mcp.servers.health", { serverKey: "alpha" })) as McpServersHealthResult;
  assert.equal(healthStopped.items[0]!.ok, false);
  assert.equal(healthStopped.items[0]!.status, "Disconnected");

  // G3 启（setEnabled true）：受理即返重连 → Connected + 工具恢复 + enabled:true 持久化
  const started = (await client.call("mcp.servers.setEnabled", {
    serverKey: "alpha",
    enabled: true,
  })) as McpServersSetEnabledResult;
  assert.equal(started.enabled, true);
  await waitForStatus(
    scenario.watch,
    (e) => e.serverKey === "alpha" && e.status === "Connected" && (e.toolCount ?? 0) > 0,
    "alpha 重启 Connected",
    CONNECT_TIMEOUT,
    true,
  );
  const call = (await client.call("mcp.tools.call", {
    serverKey: "alpha",
    toolName: "echo",
    args: { text: "restarted" },
  })) as McpToolsCallResult;
  assert.equal(call.content, "echo(alpha): restarted");
  const persistedRestarted = JSON.parse(await readFile(join(scenario.home, "mcp.json"), "utf8")) as {
    mcpServers: Record<string, { enabled?: boolean }>;
  };
  assert.equal(persistedRestarted.mcpServers["alpha"]!.enabled, true, "enabled:true 写回 mcp.json");

  // 错误族：未知 serverKey → MCP_SERVER_NOT_FOUND
  await assert.rejects(
    client.call("mcp.servers.setEnabled", { serverKey: "no-such", enabled: true }),
    (err: unknown) => err instanceof RpcCallError && err.code === "MCP_SERVER_NOT_FOUND",
  );
  await assert.rejects(
    client.call("mcp.servers.health", { serverKey: "no-such" }),
    (err: unknown) => err instanceof RpcCallError && err.code === "MCP_SERVER_NOT_FOUND",
  );
  console.log("case G: 运行时启停 + 健康检查（ping RTT/停后隔离与持久化/重启恢复）OK");
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const scenario = await caseConnectAndNamespace();
  try {
    await caseControlCall(scenario);
    await caseModelCall(scenario);
    await caseReconnect(scenario);
    await caseSetEnabledAndHealth(scenario);
    await caseHttpAndRemove(scenario);
  } finally {
    scenario.watch.stop();
    await scenario.close();
  }
  console.log("");
  console.log("SMOKE OK");
}

main().catch((err: unknown) => {
  console.error("SMOKE FAILED:", err);
  process.exit(1);
});
