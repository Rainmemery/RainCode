/**
 * marketplace 分发 smoke（M6 T6.1，07-dev-plan §12.2 / 06-api-spec §2.10 v1.14）。
 * 运行：tsx scripts/smoke-marketplace.mts（或 pnpm run smoke:marketplace）
 *
 * 链路：node:http mock OpenAI SSE + 临时 RAINCODE_HOME（注册表/台账/缓存 + 技能目录）→ 本地
 * path 市场（examples/marketplaces/local 注册）→ 断言：
 * 用例 A 分发全链（验收项）：marketplace.add → list（未安装投影）→ install（status active +
 *   缓存布局 <marketplace>/<plugin>/<version> + 种子落盘）→ plugins.list 安装副本激活 →
 *   skills.list 第三源 plugin-demo（source=plugin）→ skills.invoke 起 turn → 模型经 mock 下发
 *   plugin__hello__greet 工具调用 → 执行回传（安装插件工具经技能链路真实执行）。
 * 用例 B 逃逸防护（验收项）：junction 指向插件根外的市场插件 → install 拒绝
 *   MARKETPLACE_ESCAPE_BLOCKED（越界路径入错误消息供审计）。
 * 用例 C 卸载复原（验收项）：uninstall → plugins.list / skills.list 不可见 + 安装副本删除 +
 *   台账清空；重复卸载 MARKETPLACE_NOT_FOUND；重装恢复 active。
 * 全程仅本机回环与临时目录：无外呼、无真实密钥（mock provider apiKey 为占位符，绝不打印）。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemoryTransportPair, createRpcClient, RpcCallError } from "../packages/rpc/src/index.ts";
import type { RpcClient } from "../packages/rpc/src/index.ts";
import { createAgentServiceNode } from "../packages/server/src/index.ts";
import type { AgentServiceNode } from "../packages/server/src/index.ts";
import type {
  PluginsListResult,
  SessionCreateResult,
  SkillSummary,
  ToolCallCompletedEventPayload,
} from "../packages/shared/src/index.ts";
import { startMockLlmServer, textScript, toolCallFrame } from "./p0-lib.mts";
import type { SseScript } from "./p0-lib.mts";

const REPO_ROOT = join(import.meta.dirname, "..");
const EXAMPLE_MARKET = join(REPO_ROOT, "examples", "marketplaces", "local");

// ---------------------------------------------------------------------------
// 场景装配
// ---------------------------------------------------------------------------

interface Scenario {
  home: string;
  client: RpcClient;
  node: AgentServiceNode;
  toolCompleted: ToolCallCompletedEventPayload[];
  setScript: (script: SseScript[]) => void;
  close: () => Promise<void>;
}

async function startScenario(): Promise<Scenario> {
  const home = await mkdtemp(join(tmpdir(), "raincode-smoke-mkt-"));
  await mkdir(join(home, "ws"), { recursive: true });
  const mock = await startMockLlmServer();
  const transports = createInMemoryTransportPair();
  const node = await createAgentServiceNode(transports[1], {
    env: { RAINCODE_HOME: home },
    provider: {
      name: "mock-marketplace",
      baseURL: mock.url,
      model: "mock-model",
      apiKey: "smoke-dummy-key",
      maxContextTokens: 8192,
    },
    tools: { approval: "always-allow" },
    permission: { policy: "default-allow" },
    plugins: {},
    marketplace: {},
    skills: {},
  });
  const client = createRpcClient({ transport: transports[0] });
  await client.call("system.ping", {});
  const toolCompleted: ToolCallCompletedEventPayload[] = [];
  const offTool = client.onEvent("tool_call.completed", (payload) =>
    toolCompleted.push(payload as ToolCallCompletedEventPayload));
  return {
    home,
    client,
    node,
    toolCompleted,
    setScript: mock.setScript,
    close: async () => {
      offTool();
      client.close();
      await node.close();
      await transports[0].close();
      await transports[1].close();
      await mock.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

/** A：分发全链（验收项：注册 → 安装 → 插件激活 → 第三源技能可见可 invoke → 插件工具真实执行）。 */
async function caseDistributionChain(scenario: Scenario): Promise<void> {
  const { client, home } = scenario;

  const added = (await client.call("marketplace.add", { id: "examples", source: { path: EXAMPLE_MARKET } })) as {
    marketplace: { id: string; name?: string };
  };
  assert.equal(added.marketplace.id, "examples");

  const listed = (await client.call("marketplace.list", {})) as {
    marketplaces: Array<{ id: string; pluginCount: number; lastError: string | null; plugins: Array<{ name: string; version: string; displayName?: string; installed: unknown }> }>;
  };
  assert.equal(listed.marketplaces.length, 1);
  assert.equal(listed.marketplaces[0]!.pluginCount, 1);
  assert.equal(listed.marketplaces[0]!.lastError, null);
  assert.equal(listed.marketplaces[0]!.plugins[0]!.name, "hello");
  assert.equal(listed.marketplaces[0]!.plugins[0]!.installed, null, "未安装投影");

  const installed = (await client.call("marketplace.install", { marketplaceId: "examples", plugin: "hello" })) as {
    name: string;
    version: string;
    dir: string;
    status: string;
  };
  assert.equal(installed.status, "active");
  assert.ok(installed.dir.includes(join(home, "marketplaces", "cache", "examples", "hello", "0.1.0")), "缓存布局三段式");
  const seed = JSON.parse(await readFile(join(installed.dir, ".zcode-plugin-seed.json"), "utf8")) as { hash: string; pluginVersion: string };
  assert.equal(seed.pluginVersion, "0.1.0");
  assert.match(seed.hash, /^[0-9a-f]{64}$/, "内容寻址种子落盘");

  const plugins = (await client.call("plugins.list", {})) as PluginsListResult;
  const hello = plugins.plugins.find((p) => p.name === "hello");
  assert.ok(hello !== undefined && hello.status === "active", "安装副本激活");
  assert.deepEqual(hello.tools, ["plugin__hello__greet", "plugin__hello__word_count"]);

  const skills = (await client.call("skills.list", {})) as { items: SkillSummary[] };
  const demo = skills.items.find((s) => s.name === "plugin-demo");
  assert.ok(demo !== undefined, "随插件技能经第三源可见");
  assert.equal(demo.source, "plugin");

  // skills.invoke：模板展开起 turn → mock 下发插件工具调用 → 真实执行回传
  scenario.setScript([
    {
      frames: [
        { choices: [{ index: 0, delta: { role: "assistant", content: "" } }] },
        toolCallFrame("call_mkt_1", "plugin__hello__greet", { name: "RainCode" }),
        { choices: [], usage: { prompt_tokens: 20, completion_tokens: 8 } },
      ],
      finish: "tool_calls",
    },
    textScript("技能链路完成"),
  ]);
  const sessionId = ((await client.call("session.create", { workspaceRoot: join(home, "ws") } as never)) as SessionCreateResult).sessionId;
  const invoked = (await client.call("skills.invoke", { sessionId, name: "plugin-demo", arguments: "RainCode" })) as { turnId: string };
  assert.match(invoked.turnId, /^turn_/, "skills.invoke 受理即返");
  const toolCompletedPromise = new Promise<void>((resolvePromise) => {
    const timer = setInterval(() => {
      if (scenario.toolCompleted.some((e) => e.toolCallId === "call_mkt_1")) {
        clearInterval(timer);
        resolvePromise();
      }
    }, 50);
    setTimeout(() => {
      clearInterval(timer);
      resolvePromise();
    }, 15000);
  });
  await toolCompletedPromise;
  const greet = scenario.toolCompleted.find((e) => e.toolCallId === "call_mkt_1");
  assert.ok(greet !== undefined, "greet 完成事件到达");
  assert.equal(greet.isError, false);
  assert.ok(greet.contentPreview?.includes("Hello, RainCode!"), `安装副本插件工具真实执行（${String(greet.contentPreview)}）`);
  console.log("case A: 分发全链（add/list/install/种子/插件激活/第三源技能 invoke/插件工具执行）OK");
}

/** B：逃逸防护（验收项）：junction 指向插件根外 → MARKETPLACE_ESCAPE_BLOCKED。 */
async function caseEscapeBlocked(scenario: Scenario): Promise<void> {
  const { client, home } = scenario;
  const market = join(home, "escape-mkt");
  const plugin = join(market, "evil");
  await mkdir(plugin, { recursive: true });
  await writeFile(
    join(market, "marketplace.json"),
    JSON.stringify({ name: "escape", version: "1.0.0", plugins: [{ name: "evil", version: "1.0.0", source: "evil", description: "越界插件" }] }),
    "utf8",
  );
  await writeFile(join(plugin, "plugin.json"), JSON.stringify({ name: "evil", description: "越界插件", version: "1.0.0" }), "utf8");
  const outside = join(home, "outside-target");
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "secret.txt"), "outside", "utf8");
  await symlink(outside, join(plugin, "leak"), "junction");
  await client.call("marketplace.add", { id: "escape-mkt", source: { path: market } });
  await assert.rejects(
    client.call("marketplace.install", { marketplaceId: "escape-mkt", plugin: "evil" }),
    (err: unknown) => err instanceof RpcCallError && err.code === "MARKETPLACE_ESCAPE_BLOCKED" && err.message.includes("outside plugin root"),
    "junction 逃逸拒绝且越界路径入错误消息（审计可见）",
  );
  const plugins = (await client.call("plugins.list", {})) as PluginsListResult;
  assert.ok(plugins.plugins.every((p) => p.name !== "evil"), "越界插件未进插件记录");
  console.log("case B: 逃逸防护（junction 越界拒绝 + 审计消息）OK");
}

/** C：卸载复原（验收项）：不可见 + 副本删除 + 台账清空 + 重复卸载拒绝 + 重装恢复。 */
async function caseUninstallRestore(scenario: Scenario): Promise<void> {
  const { client, home } = scenario;
  const installed = (await client.call("marketplace.install", { marketplaceId: "examples", plugin: "hello" })) as { dir: string };

  const removed = (await client.call("marketplace.uninstall", { marketplaceId: "examples", plugin: "hello" })) as { removed: boolean };
  assert.equal(removed.removed, true);
  const plugins = (await client.call("plugins.list", {})) as PluginsListResult;
  assert.ok(plugins.plugins.every((p) => p.name !== "hello"), "卸载后插件不可见");
  const skills = (await client.call("skills.list", {})) as { items: SkillSummary[] };
  assert.ok(skills.items.every((s) => s.name !== "plugin-demo"), "卸载后第三源技能不可见");
  await assert.rejects(async () => readFile(join(installed.dir, "plugin.json"), "utf8"), "安装副本已删除");
  const ledger = JSON.parse(await readFile(join(home, "marketplaces", "installed.json"), "utf8")) as { installed: unknown[] };
  assert.equal(ledger.installed.length, 0, "台账清空");
  await assert.rejects(
    client.call("marketplace.uninstall", { marketplaceId: "examples", plugin: "hello" }),
    (err: unknown) => err instanceof RpcCallError && err.code === "MARKETPLACE_NOT_FOUND",
    "重复卸载 NOT_FOUND",
  );

  const reinstalled = (await client.call("marketplace.install", { marketplaceId: "examples", plugin: "hello" })) as { status: string };
  assert.equal(reinstalled.status, "active", "重装恢复");
  console.log("case C: 卸载复原（不可见/副本删除/台账清空/NOT_FOUND/重装恢复）OK");
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const scenario = await startScenario();
  try {
    await caseDistributionChain(scenario);
    await caseEscapeBlocked(scenario);
    await caseUninstallRestore(scenario);
  } finally {
    await scenario.close();
  }
  console.log("SMOKE OK: marketplace");
}

main().catch((reason: unknown) => {
  console.error("SMOKE FAILED:", reason);
  process.exit(1);
});
