/**
 * Web 界面 smoke（M3 T3.8，07 §4.1 / 06-api-spec §6.3 v1.9；T4.5 扩用例 D 四面板服务面）。
 * 运行：tsx scripts/smoke-web.mts（或 pnpm run smoke:web）
 *
 * 链路：node:http mock OpenAI SSE + 临时 RAINCODE_HOME → createAgentServiceNode(undefined)
 * （延迟 attach）→ WebHost(127.0.0.1:0) → node「ws」客户端（与浏览器同帧形态）→ 断言：
 * 用例 A 鉴权握手与浏览器端到端会话（验收项）：无鉴权 ping → UNAUTHORIZED；ws.auth(错误
 *   token) → UNAUTHORIZED；正确 token → ping（capabilities 含 ws.auth）→ session.create →
 *   session.send（mock LLM 文本回合）→ message.delta/completed/done 事件流全经 WS 到达。
 * 用例 B 断线重连快照补偿（验收项）：createReconnectingRpcClient 真实客户端——turn 进行中
 *   模拟网络断开（客户端 terminate）→ 退避重连 → onRestored → session.resume 快照补推
 *   覆盖断线窗口流式内容（history 全量重建无丢失）+ lastSeq 连续。
 * 用例 C 多连接扇出：两个连接各自完整时序，session.create 事件双双到达；断开其一后
 *   另一连接事件扇出不中断。
 * 用例 D 四面板服务面（T4.5 验收项）：斜杠命令面板（skills.list 双层投影 + skills.invoke
 *   端到端回合）/ 用量统计（session.usage 回合后投影）/ 记忆管理器（memory.read 空态 →
 *   write Agent 专用章节 → 回读 + drafts/entries 投影）/ 扩展面板（MCP 连接投影 → 健康检查
 *   实测 RTT → 启停事件到达 → 重连收敛；插件 active → 停用 → 再激活）——web 面板消费的
 *   正是这套同方法表帧形态（06 §6.3），UI 侧真浏览器走查归 T4.7（L-05）。
 * 全程仅本机回环与临时目录：无外呼、无真实密钥（mock provider apiKey 为占位符，绝不打印）。
 */
import assert from "node:assert/strict";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { createReconnectingRpcClient, WebSocketTransport, createRpcClient, RpcCallError } from "../packages/rpc/src/index.js";
import type { RpcClient } from "../packages/rpc/src/index.js";
import type { WsSocketLike } from "../packages/rpc/src/websocket.js";
import { createAgentServiceNode } from "../packages/server/src/index.js";
import type { AgentServiceNode } from "../packages/server/src/index.js";
import { WebHost } from "../packages/server/src/web-host.js";
import type { SystemPingResult } from "../packages/shared/src/index.js";
import { beginTurn, startMockLlmServer, textScript, withTimeout } from "./p0-lib.mts";
import type { SseScript } from "./p0-lib.mts";

const sleep = (ms: number): Promise<void> => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

async function waitFor(predicate: () => boolean, ms = 10000, label = "condition"): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > ms) throw new Error(`waitFor timeout: ${label}`);
    await sleep(10);
  }
}

/** 异步谓词轮询（用例 D 服务面收敛：MCP 连接/插件状态变化经事件异步到达）。 */
async function waitForAsync(predicate: () => Promise<boolean>, ms = 20000, label = "condition"): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - started > ms) throw new Error(`waitFor timeout: ${label}`);
    await sleep(100);
  }
}

interface Scenario {
  home: string;
  workspace: string;
  host: WebHost;
  node: AgentServiceNode;
  url: string;
  setScript: (script: SseScript[]) => void;
  close: () => Promise<void>;
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function startScenario(): Promise<Scenario> {
  const home = await mkdtemp(join(tmpdir(), "raincode-smoke-web-"));
  const workspace = join(home, "ws");
  await mkdir(workspace, { recursive: true });
  // 种子（用例 D 面板服务面）：mcp.json（stdio fixture）+ 示例插件 hello + 技能双层
  //（home/skills 全局层 ×2 + workspace/.raincode/skills 工作区层 ×1）
  writeFileSync(
    join(home, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: { transport: "stdio", command: "node", args: [join(REPO_ROOT, "scripts", "mcp-fixture-stdio.mjs")], enabled: true },
      },
    }),
    "utf8",
  );
  mkdirSync(join(home, "plugins"), { recursive: true });
  cpSync(join(REPO_ROOT, "examples", "plugins", "hello"), join(home, "plugins", "hello"), { recursive: true });
  mkdirSync(join(home, "skills"), { recursive: true });
  for (const skill of ["docs.md", "review.md"]) {
    cpSync(join(REPO_ROOT, "examples", "skills", skill), join(home, "skills", skill));
  }
  mkdirSync(join(workspace, ".raincode", "skills"), { recursive: true });
  cpSync(join(REPO_ROOT, "examples", "skills", "test-gen.md"), join(workspace, ".raincode", "skills", "test-gen.md"));
  const mock = await startMockLlmServer();
  const node = await createAgentServiceNode(undefined, {
    env: { RAINCODE_HOME: home },
    provider: {
      name: "mock-web",
      baseURL: mock.url,
      model: "mock-model",
      apiKey: "smoke-dummy-key",
      maxContextTokens: 8192,
    },
    tools: { approval: "always-allow" },
    permission: { policy: "default-allow" },
    skills: {},
    plugins: {},
    mcp: {},
    memory: {},
  });
  const host = new WebHost({
    node,
    port: 0,
    token: "smoke-token",
    heartbeatIntervalMs: 0,
    onDiagnostic: () => undefined,
  });
  await host.start();
  return {
    home,
    workspace,
    host,
    node,
    url: host.url,
    setScript: mock.setScript,
    close: async () => {
      await host.stop();
      await node.close();
      await mock.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

/** node ws 客户端完整时序（ws.auth → system.ping）→ RpcClient。 */
async function connectClient(url: string, token: string): Promise<{ client: RpcClient; close: () => Promise<void> }> {
  const ws = new WebSocket(`${url}/ws`);
  await new Promise<void>((resolvePromise, reject) => {
    ws.once("open", resolvePromise);
    ws.once("error", reject);
  });
  const transport = new WebSocketTransport({ socket: ws as unknown as WsSocketLike, role: "client" });
  const client = createRpcClient({ transport, defaultTimeoutMs: 8000 });
  await client.call("ws.auth", { token });
  await client.call("system.ping", {});
  return {
    client,
    close: async () => {
      client.close();
      await transport.close();
    },
  };
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

/** A：鉴权握手 + 浏览器端到端会话（验收项：WS 绑定下全方法/事件流零改动）。 */
async function caseAuthAndSession(scenario: Scenario): Promise<void> {
  const { url, workspace, setScript } = scenario;
  // 未鉴权 → UNAUTHORIZED（含 system.ping）
  const ws = new WebSocket(`${url}/ws`);
  await new Promise<void>((resolvePromise) => ws.once("open", resolvePromise));
  const bareTransport = new WebSocketTransport({ socket: ws as unknown as WsSocketLike, role: "client" });
  const bare = createRpcClient({ transport: bareTransport, defaultTimeoutMs: 8000 });
  await assert.rejects(
    bare.call("system.ping", {}),
    (err: unknown) => err instanceof RpcCallError && err.code === "UNAUTHORIZED",
    "鉴权前 ping 应 UNAUTHORIZED",
  );
  // 错误 token → ws.auth 拒绝
  await assert.rejects(
    bare.call("ws.auth", { token: "wrong" }),
    (err: unknown) => err instanceof RpcCallError && err.code === "UNAUTHORIZED",
    "错误 token 应 UNAUTHORIZED",
  );
  bare.close();
  await bareTransport.close();

  // 正确 token → 全链会话
  const { client, close } = await connectClient(url, "smoke-token");
  try {
    const ping = (await client.call("system.ping", {})) as SystemPingResult;
    assert.ok(ping.capabilities.includes("ws.auth"), `capability 缺 ws.auth: ${String(ping.capabilities)}`);
    const created = (await client.call("session.create", { workspaceRoot: workspace, title: "web-e2e" })) as { sessionId: string };
    setScript([textScript("浏览器端到端回复：帧协议与方法表零改动。")]);
    const run = beginTurn(client, created.sessionId, "你好");
    const deltas: string[] = [];
    client.onEvent("message.delta", (payload) => {
      const delta = (payload as { delta?: { type?: string; text?: string } }).delta;
      if (delta?.type === "text" && typeof delta.text === "string") deltas.push(delta.text);
    });
    await run.sendPromise;
    await withTimeout(run.done, 15000, "turn over ws");
    assert.ok(deltas.length > 0, "message.delta 应经 WS 到达");
    const list = (await client.call("session.list", {})) as { items: Array<{ id: string; title: string }> };
    assert.ok(list.items.some((row) => row.id === created.sessionId), "会话应已落库可见");
  } finally {
    await close();
  }
}

/** B：断线重连快照补偿（验收项：seq 缺口 → resume 补偿路径）。
 * 回合内容整体产生于断线窗口（mock 请求延迟 1200ms）——补偿后视图内容**只能**经
 * resume 快照补推到达，是对「端层必须完整实现补偿路径」的最强断言。 */
async function caseReconnectCompensation(scenario: Scenario): Promise<void> {
  const { url, setScript } = scenario;
  let lastSocket: WebSocket | null = null; // connectSocket 工厂捕获：模拟网络断开用
  const client = createReconnectingRpcClient({
    url: `${url}/ws`,
    token: "smoke-token",
    connectSocket: (socketUrl) => {
      const ws = new WebSocket(socketUrl);
      ws.once("open", () => {
        lastSocket = ws;
      });
      return ws as unknown as WsSocketLike;
    },
    backoffMs: () => 30,
  });
  try {
    await waitFor(() => client.state === "ready", 8000, "first ready");
    const created = (await client.call("session.create", { workspaceRoot: scenario.workspace, title: "web-reconnect" })) as { sessionId: string };
    // 长回合：单请求延迟 1200ms——断线窗口内内容在服务端持续产生
    setScript([textScript("补偿前半段。补偿后半段内容在断线窗口内流式产生。", 1200)]);
    const admitted = (await client.call("session.send", { sessionId: created.sessionId, input: { text: "开始回合" } })) as { turnId: string };
    assert.ok(admitted.turnId.length > 0);
    await sleep(120); // 进入模型请求延迟窗口
    // 网络断开（客户端侧 terminate ≡ 链路中断）
    const socketToKill = lastSocket;
    assert.ok(socketToKill !== null, "应已捕获底层 socket");
    socketToKill.terminate();
    lastSocket = null;
    await waitFor(() => client.state === "reconnecting", 8000, "reconnecting");
    // 退避重连 → onRestored
    let restoredFired = false;
    client.onRestored(() => {
      restoredFired = true;
    });
    await waitFor(() => restoredFired, 8000, "restored");
    assert.equal(client.state, "ready");
    // 等 turn 在新连接上收束（done 事件扇出到重连后的绑定——多连接扇出的佐证之一）
    let doneArrived = false;
    client.onEvent("done", (payload) => {
      if ((payload as { sessionId?: string }).sessionId === created.sessionId) doneArrived = true;
    });
    await waitFor(() => doneArrived, 15000, "done after restore");
    // resume 补偿：快照全量重建，断线窗口内容零丢失
    const resumed = (await client.call("session.resume", { sessionId: created.sessionId })) as {
      snapshot: { history?: Array<{ role?: string; content?: unknown }>; messages?: unknown[]; lastSeq: number };
    };
    const rebuild = resumed.snapshot.history ?? resumed.snapshot.messages ?? [];
    const text = rebuild
      .map((row) => (typeof row.content === "string" ? row.content : ""))
      .join("");
    assert.ok(text.includes("补偿前半段"), `快照缺前半段: ${text}`);
    assert.ok(text.includes("补偿后半段内容在断线窗口内流式产生"), `快照缺断线窗口内容: ${text}`);
    assert.ok(resumed.snapshot.lastSeq >= 1, "snapshot.lastSeq 应有效");
    client.setSeqBaseline(created.sessionId, resumed.snapshot.lastSeq); // 端层补偿完成回填（06 §6.3 第 4 条）
    // 补偿后链路仍可用：下一回合正常收束
    setScript([textScript("重连后的第二回合。")]);
    const run = beginTurn(client as unknown as RpcClient, created.sessionId, "再来一回合");
    await run.sendPromise;
    await withTimeout(run.done, 15000, "post-restore turn");
  } finally {
    client.close();
  }
}

/** C：多连接扇出 + 断开隔离。 */
async function caseMultiClientFanout(scenario: Scenario): Promise<void> {
  const { url } = scenario;
  const c1 = await connectClient(url, "smoke-token");
  const c2 = await connectClient(url, "smoke-token");
  try {
    const got1: unknown[] = [];
    const got2: unknown[] = [];
    c1.client.onEvent("session.created", (payload) => got1.push(payload));
    c2.client.onEvent("session.created", (payload) => got2.push(payload));
    await c1.client.call("session.create", { workspaceRoot: scenario.workspace, title: "fanout" });
    await waitFor(() => got1.length >= 1 && got2.length >= 1, 8000, "fanout");
    // 断开 c1：c2 事件扇出不中断
    await c1.close();
    await sleep(60);
    const got2After: unknown[] = [];
    c2.client.onEvent("session.created", (payload) => got2After.push(payload));
    await c2.client.call("session.create", { workspaceRoot: scenario.workspace, title: "after-disconnect" });
    await waitFor(() => got2After.length >= 1, 8000, "post-disconnect fanout");
    assert.equal(got1.length, 1, "c1 断开前应恰好收到一次");
  } finally {
    await c2.close();
  }
}

/** D：四面板服务面（T4.5 验收项）。web 面板消费的正是这套同方法表帧形态（06 §6.3）：
 * 斜杠命令面板 → skills.list（workspace+global 双层 source 投影）+ skills.invoke 端到端回合；
 * 用量统计 → session.usage（mock usage 每回合 20/8）；记忆管理器 → memory.read 空态 →
 * memory.write（Agent 专用章节白名单）→ 回读 + drafts/entries 空投影；扩展面板 → MCP
 * 连接投影 → 健康检查实测 RTT → 启停（mcp.server_status_changed 到达）→ 重连收敛，
 * 插件 active → 停用 → 再激活（plugin.status_changed 到达）。 */
async function casePanelServices(scenario: Scenario): Promise<void> {
  const { url, workspace, setScript } = scenario;
  const { client, close } = await connectClient(url, "smoke-token");
  try {
    const statusEvents = new Set<string>();
    client.onEvent("mcp.server_status_changed", () => statusEvents.add("mcp"));
    client.onEvent("plugin.status_changed", () => statusEvents.add("plugin"));

    // ① 斜杠命令面板服务面
    const created = (await client.call("session.create", { workspaceRoot: workspace, title: "web-panels" })) as { sessionId: string };
    const skills = (await client.call("skills.list", { sessionId: created.sessionId })) as {
      items: Array<{ name: string; source: string }>;
    };
    const byName = new Map(skills.items.map((row) => [row.name, row]));
    assert.equal(byName.get("test-gen")?.source, "workspace", "workspace 层技能应投影 source=workspace");
    assert.equal(byName.get("review")?.source, "global", "global 层技能应投影 source=global");
    setScript([textScript("面板走查：技能展开后的回复。")]);
    const invokeDone = new Promise<void>((resolvePromise) => {
      client.onEvent("done", (payload) => {
        if ((payload as { sessionId?: string }).sessionId === created.sessionId) resolvePromise();
      });
    });
    await client.call("skills.invoke", { sessionId: created.sessionId, name: "test-gen", arguments: "src/a.ts" });
    await withTimeout(invokeDone, 15000, "skills.invoke turn");

    // ② 用量统计服务面
    const usage = (await client.call("session.usage", { sessionId: created.sessionId })) as {
      inputTokens: number;
      outputTokens: number;
      turnsCount: number;
    };
    assert.ok(usage.turnsCount >= 1 && usage.inputTokens > 0 && usage.outputTokens > 0, `用量投影应为正: ${JSON.stringify(usage)}`);

    // ③ 记忆管理器服务面（session.create 已建立 workspace 上下文）
    const md0 = (await client.call("memory.read", { workspaceRoot: workspace })) as { exists: boolean };
    assert.equal(md0.exists, false, "初始 MEMORY.md 不存在");
    await client.call("memory.write", { workspaceRoot: workspace, section: "工作约定", content: "- smoke: 面板走查写入" });
    const md1 = (await client.call("memory.read", { workspaceRoot: workspace })) as { exists: boolean; content: string };
    assert.equal(md1.exists, true, "memory.write 后 MEMORY.md 应存在");
    assert.ok(md1.content.includes("面板走查写入"), "memory.read 应回读写入内容");
    const drafts = (await client.call("memory.drafts.list", {})) as { drafts: unknown[] };
    assert.ok(Array.isArray(drafts.drafts), "memory.drafts.list 应投影空数组");
    const entries = (await client.call("memory.entries.list", { page: { limit: 50 } })) as { items: unknown[] };
    assert.ok(Array.isArray(entries.items), "memory.entries.list 应投影空数组");

    // ④ 扩展面板服务面：MCP（连接投影 → 健康 → 启停 → 重连收敛）
    const listServers = async (): Promise<Array<{ serverKey: string; status: string; enabled: boolean }>> => {
      const result = (await client.call("mcp.servers.list", {})) as {
        servers: Array<{ serverKey: string; status: string; enabled: boolean }>;
      };
      return result.servers;
    };
    await waitForAsync(
      async () => (await listServers()).some((row) => row.serverKey === "fixture" && row.status === "Connected"),
      20000,
      "fixture Connected 投影",
    );
    const health = (await client.call("mcp.servers.health", {})) as {
      items: Array<{ serverKey: string; ok: boolean; latencyMs?: number }>;
    };
    const fixtureHealth = health.items.find((row) => row.serverKey === "fixture");
    assert.ok(fixtureHealth?.ok === true && typeof fixtureHealth.latencyMs === "number", "健康检查应对已连接 server 实测 RTT");
    await client.call("mcp.servers.setEnabled", { serverKey: "fixture", enabled: false });
    await waitForAsync(
      async () => (await listServers()).some((row) => row.serverKey === "fixture" && row.status === "Disconnected" && !row.enabled),
      10000,
      "fixture 停用投影",
    );
    await client.call("mcp.servers.setEnabled", { serverKey: "fixture", enabled: true });
    await waitForAsync(
      async () => (await listServers()).some((row) => row.serverKey === "fixture" && row.status === "Connected"),
      20000,
      "fixture 重连收敛",
    );
    assert.ok(statusEvents.has("mcp"), "mcp.server_status_changed 应到达端层（扩展面板活更通道）");

    // ⑤ 扩展面板服务面：插件（active → 停用 → 再激活）
    const listPlugins = async (): Promise<Array<{ name: string; status: string }>> => {
      const result = (await client.call("plugins.list", {})) as { plugins: Array<{ name: string; status: string }> };
      return result.plugins;
    };
    assert.ok((await listPlugins()).some((row) => row.name === "hello" && row.status === "active"), "hello 插件应激活投影");
    await client.call("plugins.setEnabled", { name: "hello", enabled: false });
    await waitForAsync(async () => (await listPlugins()).some((row) => row.name === "hello" && row.status === "disabled"), 10000, "hello 停用");
    await client.call("plugins.setEnabled", { name: "hello", enabled: true });
    await waitForAsync(async () => (await listPlugins()).some((row) => row.name === "hello" && row.status === "active"), 10000, "hello 再激活");
    assert.ok(statusEvents.has("plugin"), "plugin.status_changed 应到达端层（扩展面板活更通道）");
  } finally {
    await close();
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("== smoke:web（T3.8 Web 界面 / 06 §6.3 v1.9；T4.5 四面板服务面）==");
  const scenario = await startScenario();
  try {
    await caseAuthAndSession(scenario);
    console.log("—— 用例 A 鉴权握手 + 浏览器端到端会话 OK");
    await caseReconnectCompensation(scenario);
    console.log("—— 用例 B 断线重连快照补偿 OK");
    await caseMultiClientFanout(scenario);
    console.log("—— 用例 C 多连接扇出 OK");
    await casePanelServices(scenario);
    console.log("—— 用例 D 四面板服务面 OK（斜杠 / 用量 / 记忆 / 扩展）");
    console.log("SMOKE OK: smoke-web 4/4");
  } finally {
    await scenario.close();
  }
}

main().catch((err: unknown) => {
  console.error("SMOKE FAILED:", err);
  process.exit(1);
});
