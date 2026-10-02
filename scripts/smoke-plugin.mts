/**
 * 插件化 smoke（M3 T3.5，02-module-design §2.3 插件扩展点 / 06-api-spec §2.10 v1.8）。
 * 运行：tsx scripts/smoke-plugin.mts（或 pnpm run smoke:plugin）
 *
 * 链路：node:http mock OpenAI SSE + 临时 RAINCODE_HOME（plugins 目录 + plugins.json 状态）
 * → 示例插件发布（examples/plugins/hello 拷入 plugins 目录）→ createAgentServiceNode
 * （plugins 域装配）→ 断言：
 * 用例 A 示例插件发布与加载（验收项）：plugins.list → active + 2 工具全名；tool.tools.list
 *   source=plugin 可见；turn 内 mock 下发 plugin__hello__greet / word_count tool_call →
 *   执行回传（greet 问候语 / word_count 非字符串返回值 JSON 序列化）。
 * 用例 B 运行时启停：setEnabled false → disabled + 工具不可见 + plugins.json 落盘停用名单
 *   （目录即配置，停用 ≠ 卸载）；同态重复请求幂等；setEnabled true → active + 工具恢复 +
 *   名单清空；未知 name → PLUGIN_NOT_FOUND。
 * 用例 C 故障隔离（验收项）：坏清单 / activate 抛错 → failed + lastError；execute 抛错的
 *   活跃插件 → 数据级 TOOL_EXEC_FAILED 回传模型、turn 正常收束；内核与会话不受影响，
 *   同目录好插件照常 active。
 * 全程仅本机回环与临时目录：无外呼、无真实密钥（mock provider apiKey 为占位符，绝不打印）。
 */
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemoryTransportPair, createRpcClient, RpcCallError } from "../packages/rpc/src/index.ts";
import type { RpcClient } from "../packages/rpc/src/index.ts";
import { createAgentServiceNode } from "../packages/server/src/index.ts";
import type { AgentServiceNode } from "../packages/server/src/index.ts";
import type {
  PluginsListResult,
  PluginsSetEnabledResult,
  SessionCreateResult,
  ToolCallCompletedEventPayload,
  ToolToolsListResult,
} from "../packages/shared/src/index.ts";
import { beginTurn, startMockLlmServer, textScript, toolCallFrame, withTimeout } from "./p0-lib.mts";
import type { SseScript } from "./p0-lib.mts";

const REPO_ROOT = join(import.meta.dirname, "..");
const EXAMPLE_PLUGIN = join(REPO_ROOT, "examples", "plugins", "hello");

// ---------------------------------------------------------------------------
// 场景装配：临时 RAINCODE_HOME + plugins 目录 + in-memory 服务节点 + RPC 客户端
// ---------------------------------------------------------------------------

interface Scenario {
  home: string;
  client: RpcClient;
  node: AgentServiceNode;
  toolCompleted: ToolCallCompletedEventPayload[];
  stopWatch: () => void;
  setScript: (script: SseScript[]) => void;
  close: () => Promise<void>;
}

async function startScenario(): Promise<Scenario> {
  const home = await mkdtemp(join(tmpdir(), "raincode-smoke-plugin-"));
  const workspace = join(home, "ws");
  await mkdir(workspace, { recursive: true });
  // 示例插件「发布」：目录拷入 <dataRoot>/plugins/hello（06 §2.10 发布口径）
  await cp(EXAMPLE_PLUGIN, join(home, "plugins", "hello"), { recursive: true });
  const mock = await startMockLlmServer();
  const transports = createInMemoryTransportPair();
  const node = await createAgentServiceNode(transports[1], {
    env: { RAINCODE_HOME: home },
    provider: {
      name: "mock-plugin",
      baseURL: mock.url,
      model: "mock-model",
      apiKey: "smoke-dummy-key",
      maxContextTokens: 8192,
    },
    tools: { approval: "always-allow" },
    permission: { policy: "default-allow" },
    plugins: {},
  });
  const client = createRpcClient({ transport: transports[0] });
  await client.call("system.ping", {}); // rpc 握手（首请求必须 system.ping）
  const toolCompleted: ToolCallCompletedEventPayload[] = [];
  const offTool = client.onEvent("tool_call.completed", (payload) =>
    toolCompleted.push(payload as ToolCallCompletedEventPayload));
  return {
    home,
    client,
    node,
    toolCompleted,
    stopWatch: offTool,
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

/** 单轮收束（send → done completed）。 */
async function sendAndAwait(scenario: Scenario, sessionId: string, text: string): Promise<void> {
  const run = beginTurn(scenario.client, sessionId, text);
  await run.sendPromise;
  await withTimeout(run.done, 15000, `turn: ${text}`);
  run.stop();
}

async function listPluginTools(scenario: Scenario): Promise<ToolToolsListResult["tools"]> {
  const res = (await scenario.client.call("tool.tools.list", { source: "plugin" })) as ToolToolsListResult;
  return res.tools;
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

/** A：示例插件发布与加载（验收项：清单/激活/工具注册/模型调用全链）。 */
async function caseExamplePlugin(scenario: Scenario): Promise<void> {
  const { client, home } = scenario;

  const list = (await client.call("plugins.list", {})) as PluginsListResult;
  assert.equal(list.plugins.length, 1, `插件 1 个，实得 ${String(list.plugins.length)}`);
  const hello = list.plugins[0]!;
  assert.equal(hello.name, "hello");
  assert.equal(hello.enabled, true);
  assert.equal(hello.status, "active");
  assert.equal(hello.lastError, null);
  assert.ok(hello.dir.includes(join(home, "plugins")), "dir 投影为 plugins 目录绝对路径");
  assert.deepEqual(hello.tools, ["plugin__hello__greet", "plugin__hello__word_count"]);

  const tools = await listPluginTools(scenario);
  assert.equal(tools.length, 2, "tool.tools.list source=plugin 可见两个插件工具");
  assert.ok(tools.every((tool) => tool.source === "plugin"));

  // 模型调用 greet（metadata 声明 readOnly+needsApproval=false → 无审批直执行）
  scenario.setScript([
    {
      frames: [
        { choices: [{ index: 0, delta: { role: "assistant", content: "" } }] },
        toolCallFrame("call_plug_1", "plugin__hello__greet", { name: "ZCode" }),
        { choices: [], usage: { prompt_tokens: 20, completion_tokens: 8 } },
      ],
      finish: "tool_calls",
    },
    textScript("greet 完成"),
  ]);
  const sessionId = ((await client.call("session.create", { workspaceRoot: home } as never)) as SessionCreateResult).sessionId;
  await sendAndAwait(scenario, sessionId, "用 greet 问候 ZCode");
  const greet = scenario.toolCompleted.find((e) => e.toolCallId === "call_plug_1");
  assert.ok(greet !== undefined, "greet 工具卡完成事件");
  assert.equal(greet.isError, false);
  assert.ok(greet.contentPreview?.includes("Hello, ZCode!"), `greet 结果回传（${String(greet.contentPreview)}）`);

  // 模型调用 word_count（无声明 metadata → 缺省从严；非字符串返回值 JSON 序列化）
  scenario.setScript([
    {
      frames: [
        { choices: [{ index: 0, delta: { role: "assistant", content: "" } }] },
        toolCallFrame("call_plug_2", "plugin__hello__word_count", { text: "a b c" }),
        { choices: [], usage: { prompt_tokens: 20, completion_tokens: 8 } },
      ],
      finish: "tool_calls",
    },
    textScript("word_count 完成"),
  ]);
  await sendAndAwait(scenario, sessionId, "统计 a b c 的字数");
  const wc = scenario.toolCompleted.find((e) => e.toolCallId === "call_plug_2");
  assert.ok(wc !== undefined, "word_count 工具卡完成事件");
  assert.equal(wc.isError, false);
  assert.ok(wc.contentPreview?.includes('"chars":5'), `word_count 结果 JSON 序列化（${String(wc.contentPreview)}）`);
  console.log("case A: 示例插件发布与加载（plugins.list/tool.tools.list/模型调用双工具）OK");
}

/** B：运行时启停（plugins.json 停用名单持久化；配置保留 ≠ 卸载）。 */
async function caseSetEnabled(scenario: Scenario): Promise<void> {
  const { client, home } = scenario;

  const disabled = (await client.call("plugins.setEnabled", { name: "hello", enabled: false })) as PluginsSetEnabledResult;
  assert.equal(disabled.status, "disabled");
  assert.deepEqual((await listPluginTools(scenario)).map((tool) => tool.name), [], "停用后插件工具不可见");
  const stateRaw = JSON.parse(await readFile(join(home, "plugins.json"), "utf8")) as { disabled: string[] };
  assert.deepEqual(stateRaw.disabled, ["hello"], "停用名单落盘（目录即配置，仅状态持久化）");
  const listed = (await client.call("plugins.list", {})) as PluginsListResult;
  assert.equal(listed.plugins[0]!.enabled, false);
  assert.equal(listed.plugins[0]!.dir, (await client.call("plugins.list", {}) as PluginsListResult).plugins[0]!.dir, "目录仍在（停用 ≠ 卸载）");

  // 幂等：同态重复请求直接返回
  const again = (await client.call("plugins.setEnabled", { name: "hello", enabled: false })) as PluginsSetEnabledResult;
  assert.equal(again.status, "disabled");

  const enabled = (await client.call("plugins.setEnabled", { name: "hello", enabled: true })) as PluginsSetEnabledResult;
  assert.equal(enabled.status, "active");
  assert.deepEqual((await listPluginTools(scenario)).map((tool) => tool.name), ["plugin__hello__greet", "plugin__hello__word_count"], "重启后工具恢复");
  const stateAfter = JSON.parse(await readFile(join(home, "plugins.json"), "utf8")) as { disabled: string[] };
  assert.deepEqual(stateAfter.disabled, [], "启用后停用名单清空");

  await assert.rejects(
    client.call("plugins.setEnabled", { name: "nope", enabled: true }),
    (err: unknown) => err instanceof RpcCallError && err.code === "PLUGIN_NOT_FOUND",
  );
  console.log("case B: 运行时启停（disabled 落盘 / 幂等 / 重启恢复 / PLUGIN_NOT_FOUND）OK");
}

/** C：故障隔离（验收项「插件故障不拖垮内核」）——第二场景：坏清单/坏 activate/坏 execute。 */
async function caseFaultIsolation(): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "raincode-smoke-plugin-bad-"));
  const workspace = join(home, "ws");
  await mkdir(workspace, { recursive: true });
  const plugins = join(home, "plugins");
  await mkdir(join(plugins, "bad-manifest"), { recursive: true });
  await writeFile(join(plugins, "bad-manifest", "plugin.json"), "{not json", "utf8");
  await mkdir(join(plugins, "throw-activate"), { recursive: true });
  await writeFile(
    join(plugins, "throw-activate", "plugin.json"),
    JSON.stringify({ name: "throw-activate", description: "activate 抛错插件" }),
    "utf8",
  );
  await writeFile(join(plugins, "throw-activate", "index.mjs"), "export function activate(){ throw new Error('activate boom'); }", "utf8");
  await mkdir(join(plugins, "fail-tool"), { recursive: true });
  await writeFile(
    join(plugins, "fail-tool", "plugin.json"),
    JSON.stringify({ name: "fail-tool", description: "execute 抛错插件" }),
    "utf8",
  );
  await writeFile(
    join(plugins, "fail-tool", "index.mjs"),
    "export function activate(){ return [{ name: 'boom', description: '必抛错工具', execute: async () => { throw new Error('execute boom'); } }]; }",
    "utf8",
  );
  await cp(EXAMPLE_PLUGIN, join(plugins, "hello"), { recursive: true }); // 同目录好插件

  const mock = await startMockLlmServer();
  const transports = createInMemoryTransportPair();
  const node = await createAgentServiceNode(transports[1], {
    env: { RAINCODE_HOME: home },
    provider: { name: "mock-plugin-bad", baseURL: mock.url, model: "mock-model", apiKey: "smoke-dummy-key", maxContextTokens: 8192 },
    tools: { approval: "always-allow" },
    permission: { policy: "default-allow" },
    plugins: {},
  });
  const client = createRpcClient({ transport: transports[0] });
  const toolCompleted: ToolCallCompletedEventPayload[] = [];
  const offTool = client.onEvent("tool_call.completed", (payload) =>
    toolCompleted.push(payload as ToolCallCompletedEventPayload));
  try {
    await client.call("system.ping", {}); // 内核存活

    const list = (await client.call("plugins.list", {})) as PluginsListResult;
    const byName = new Map(list.plugins.map((p) => [p.name, p]));
    assert.equal(list.plugins.length, 4);
    assert.equal(byName.get("bad-manifest")!.status, "failed", "坏清单 → failed");
    assert.ok(byName.get("bad-manifest")!.lastError !== null);
    assert.equal(byName.get("throw-activate")!.status, "failed", "activate 抛错 → failed");
    assert.ok(byName.get("throw-activate")!.lastError?.includes("activate boom"));
    assert.equal(byName.get("fail-tool")!.status, "active", "execute 抛错不影响激活");
    assert.deepEqual(byName.get("fail-tool")!.tools, ["plugin__fail-tool__boom"]);
    assert.equal(byName.get("hello")!.status, "active", "同目录好插件照常 active");

    // 坏 execute：数据级错误回传模型，turn 正常收束（不拖垮内核）
    mock.setScript([
      {
        frames: [
          { choices: [{ index: 0, delta: { role: "assistant", content: "" } }] },
          toolCallFrame("call_bad_1", "plugin__fail-tool__boom", {}),
          { choices: [], usage: { prompt_tokens: 20, completion_tokens: 8 } },
        ],
        finish: "tool_calls",
      },
      textScript("坏工具已自纠"),
    ]);
    const sessionId = ((await client.call("session.create", { workspaceRoot: workspace } as never)) as SessionCreateResult).sessionId;
    const run = beginTurn(client, sessionId, "调用 boom 工具");
    await run.sendPromise;
    const done = await withTimeout(run.done, 15000, "bad tool turn");
    run.stop();
    assert.equal(done.outcome, "completed", "execute 抛错后 turn 仍收束（模型自纠）");
    const boom = toolCompleted.find((e) => e.toolCallId === "call_bad_1");
    assert.ok(boom !== undefined, `boom 完成事件（${JSON.stringify(toolCompleted)}）`);
    assert.equal(boom.isError, true, "数据级 isError 标记");
    assert.ok(boom.contentPreview?.includes("TOOL_EXEC_FAILED"), `TOOL_EXEC_FAILED 回传（${String(boom.contentPreview)}）`);
    offTool();

    // 内核与会话仍可用：再起一正常 turn
    mock.setScript([textScript("内核正常")]);
    const run2 = beginTurn(client, sessionId, "内核还在吗");
    await run2.sendPromise;
    const done2 = await withTimeout(run2.done, 15000, "kernel turn");
    run2.stop();
    assert.equal(done2.outcome, "completed");
    console.log("case C: 故障隔离（failed 投影/execute 抛错数据级回传/内核与好插件不受影响）OK");
  } finally {
    client.close();
    await node.close();
    await transports[0].close();
    await transports[1].close();
    await mock.close();
    await rm(home, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const scenario = await startScenario();
  try {
    await caseExamplePlugin(scenario);
    await caseSetEnabled(scenario);
    await caseFaultIsolation();
  } finally {
    scenario.stopWatch();
    await scenario.close();
  }
  console.log("SMOKE OK: plugin");
}

main().catch((reason: unknown) => {
  console.error("SMOKE FAILED:", reason);
  process.exit(1);
});
