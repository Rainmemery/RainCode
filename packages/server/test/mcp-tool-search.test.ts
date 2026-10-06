/**
 * T5.6 MCP 工具目录化端到端单测（07-dev-plan §11.2 验收：多 server fixture 系统提示 token
 * 对比断言 + search 工具 mock 端到端 + 目录热变更重发布）。
 *
 * - 多 server fixture：alpha/beta 两 server 共 12 个 schema 重的 mcp__ 工具直接注册进共享
 *   registry（catalog 只消费 registry 投影，连接面已由 smoke:mcp 覆盖）；
 * - token 对比：目录模式开（mcp:{}）vs 关（toolSearch:false）——开启后载荷无任何 mcp__ 工具
 *   且序列化体积显著小于关闭态（全量 schema），检索工具 description 携带目录摘要；
 * - search 端到端：mcp_tool_search 命中 → 下一轮载荷含已激活工具 → 真实执行回传；
 * - 执行安全：未加载直调 → TOOL_MCP_NOT_LOADED + 指引（先于审批闭环）；
 * - 热变更：turn 间注册新工具 → 下一轮目录摘要重发布含新条目。
 * 与 skill-tool.test 同装配口径（in-memory 节点 + mock LLM + default-allow）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createInMemoryTransportPair, createRpcClient } from "@raincode/rpc";
import type { RpcClient } from "@raincode/rpc";
import { createBuiltinTools } from "@raincode/tools";
import type { Tool } from "@raincode/tools";
import { MCP_TOOL_SEARCH_NAME } from "@raincode/tools";
import { createAgentServiceNode } from "../src/index.js";
import type { AgentServiceNode } from "../src/index.js";

interface ScriptItem {
  frames: unknown[];
  finish: string;
}

interface WireTool {
  function: { name: string; description: string };
}

interface CapturedRequest {
  messages: Array<{ role: string; content: unknown }>;
  tools?: WireTool[];
}

interface MockLlm {
  url: string;
  setScript(script: ScriptItem[]): void;
  bodies(): CapturedRequest[];
  close(): Promise<void>;
}

/** 极简 mock OpenAI SSE 服务器：按请求序回放脚本项并捕获请求体（messages + tools 断言数据源）。 */
async function startMock(): Promise<MockLlm> {
  let script: ScriptItem[] = [];
  const captured: CapturedRequest[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as CapturedRequest;
        captured.push({ messages: body.messages, ...(body.tools !== undefined && { tools: body.tools }) });
      } catch {
        captured.push({ messages: [] });
      }
      const item = script.shift() ?? { frames: [], finish: "stop" };
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const frame of item.frames) {
        res.write(`data: ${JSON.stringify(frame)}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${String(port)}/v1`,
    setScript: (s) => {
      script = s;
    },
    bodies: () => captured,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function textReply(text: string): ScriptItem {
  return {
    frames: [
      { choices: [{ index: 0, delta: { role: "assistant", content: "" } }] },
      { choices: [{ index: 0, delta: { content: text } }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ],
    finish: "stop",
  };
}

function toolCallReply(callId: string, name: string, args: unknown): ScriptItem {
  return {
    frames: [
      { choices: [{ index: 0, delta: { role: "assistant", content: "" } }] },
      {
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, id: callId, type: "function", function: { name, arguments: JSON.stringify(args) } }] } },
        ],
      },
    ],
    finish: "tool_calls",
  };
}

/** fixture：schema 重的伪 MCP 工具（description + 参数描述均长，模拟真实 server 工具目录体积）。 */
function fakeMcpTool(server: string, name: string, description: string, properties: Record<string, unknown>): Tool<Record<string, unknown>> {
  return {
    name: `mcp__${server}__${name}`,
    description: `${description} ${"Detailed usage notes. ".repeat(10)}`,
    parametersSchema: z.record(z.string(), z.unknown()),
    parametersJsonSchema: {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(properties).map(([key, type]) => [
          key,
          { type, description: `The ${key} argument used by ${name} on the ${server} server. ${"Additional parameter documentation. ".repeat(4)}` },
        ]),
      ),
      required: Object.keys(properties),
    },
    metadata: { readOnly: false, destructive: false, sideEffectScope: "machine", riskLevel: "medium", needsApproval: true },
    async execute(input: Record<string, unknown>) {
      return { data: "ok", content: `fixture-result(${server}/${name}): ${JSON.stringify(input)}` };
    },
  };
}

/** 多 server fixture registry：内建 13 件 + alpha/beta 两 server × 6 工具（schema 重）。 */
function buildFixtureRegistry(): ReturnType<typeof createBuiltinTools>["registry"] {
  const fixture = createBuiltinTools();
  for (let i = 0; i < 6; i += 1) {
    fixture.registry.register(
      fakeMcpTool("alpha", `tool_${String(i)}`, `Alpha tool ${String(i)}: read file and directory entries`, { path: "string", encoding: "string", limit: "number" }),
      "mcp",
    );
    fixture.registry.register(
      fakeMcpTool("beta", `tool_${String(i)}`, `Beta tool ${String(i)}: execute database query statements`, { sql: "string", timeout_ms: "number" }),
      "mcp",
    );
  }
  return fixture.registry;
}

interface Harness {
  client: RpcClient;
  mock: MockLlm;
  node: AgentServiceNode;
  registry: ReturnType<typeof buildFixtureRegistry>;
  home: string;
  workspace: string;
  close(): Promise<void>;
}

async function startHarness(mcp: { toolSearch?: boolean }): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), "raincode-mcp-tool-search-"));
  const workspace = join(home, "ws");
  await mkdir(workspace, { recursive: true });
  const mock = await startMock();
  const registry = buildFixtureRegistry();
  const transports = createInMemoryTransportPair();
  const node = await createAgentServiceNode(transports[1], {
    env: { RAINCODE_HOME: home },
    provider: { name: "mock-mcp-search", baseURL: mock.url, model: "mock-model", apiKey: "test-dummy-key", maxContextTokens: 32768 },
    tools: { registry, approval: "always-allow" },
    permission: { policy: "default-allow" },
    mcp,
  });
  const client = createRpcClient({ transport: transports[0] });
  await client.call("system.ping", {});
  return {
    client,
    mock,
    node,
    registry,
    home,
    workspace,
    close: async () => {
      client.close();
      await new Promise((r) => setTimeout(r, 30));
      await node.close();
      await transports[0].close();
      await transports[1].close();
      await mock.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

function nextDone(client: RpcClient): Promise<unknown> {
  return new Promise((resolve) => {
    client.onEvent("done", (payload) => resolve(payload));
  });
}

function toolNames(request: CapturedRequest | undefined): string[] {
  return request?.tools?.map((tool) => tool.function.name) ?? [];
}

test("token 对比：目录模式开启后载荷不含 mcp__ 工具，序列化体积显著小于全量 schema", async () => {
  const on = await startHarness({});
  const off = await startHarness({ toolSearch: false });
  try {
    for (const harness of [on, off]) {
      const created = await harness.client.call<{ sessionId: string }>("session.create", { workspaceRoot: harness.workspace, title: "tokens" });
      const done = nextDone(harness.client);
      await harness.client.call("session.send", { sessionId: created.sessionId, input: { text: "列一下能力" } });
      await done;
    }
    const onRequest = on.mock.bodies()[0];
    const offRequest = off.mock.bodies()[0];
    // 开启：无 mcp__ 工具进载荷；检索工具在位且 description 承载目录摘要
    const onNames = toolNames(onRequest);
    assert.ok(onNames.includes(MCP_TOOL_SEARCH_NAME), "目录模式应暴露 mcp_tool_search");
    assert.ok(onNames.every((name) => !name.startsWith("mcp__")), "目录模式载荷不得含 mcp__ 工具");
    const searchTool = onRequest?.tools?.find((tool) => tool.function.name === MCP_TOOL_SEARCH_NAME);
    assert.match(searchTool?.function.description ?? "", /mcp__alpha__tool_0/, "目录摘要应含工具名");
    assert.doesNotMatch(searchTool?.function.description ?? "", /Additional parameter documentation/, "参数 schema 不得进目录");
    // 关闭：全量 schema 在位（对照面）
    const offNames = toolNames(offRequest);
    assert.ok(offNames.filter((name) => name.startsWith("mcp__")).length === 12, "关闭目录模式应全量投影 12 个 mcp 工具");
    assert.ok(!offNames.includes(MCP_TOOL_SEARCH_NAME), "非目录模式载荷应剔除检索工具");
    // token 对比断言（估算 tokens = ceil(chars/3)，同 T5.4 cps/3 口径）：目录摘要显著小于全量 schema
    const onChars = JSON.stringify(onRequest?.tools ?? []).length;
    const offChars = JSON.stringify(offRequest?.tools ?? []).length;
    assert.ok(onChars < offChars, `目录模式载荷应更小：on=${String(onChars)} off=${String(offChars)}`);
    assert.ok(offChars > onChars * 1.5, `schema 全量体积应显著大于目录摘要：on=${String(onChars)} off=${String(offChars)}`);
  } finally {
    await on.close();
    await off.close();
  }
});

test("search 端到端：mcp_tool_search 命中 → 下一轮载荷激活 → 真实执行回传", async () => {
  const harness = await startHarness({});
  try {
    const { client, mock } = harness;
    mock.setScript([
      toolCallReply("call_1", MCP_TOOL_SEARCH_NAME, { query: "read file" }),
      toolCallReply("call_2", "mcp__alpha__tool_0", { path: "a.txt" }),
      textReply("已读取文件。"),
    ]);
    const created = await client.call<{ sessionId: string }>("session.create", { workspaceRoot: harness.workspace, title: "e2e" });
    const done = nextDone(client);
    await client.call("session.send", { sessionId: created.sessionId, input: { text: "帮我读 a.txt" } });
    await done;
    const bodies = mock.bodies();
    assert.ok(bodies.length >= 3);
    // R1：载荷无 mcp__ 工具
    assert.ok(toolNames(bodies[0]).every((name) => !name.startsWith("mcp__")));
    // R2：命中工具激活进载荷（未命中仍在目录外）
    const r2Names = toolNames(bodies[1]);
    assert.ok(r2Names.includes("mcp__alpha__tool_0"), "搜索命中工具应自下一轮起激活");
    assert.ok(!r2Names.includes("mcp__beta__tool_0"), "未命中工具保持不加载");
    // R2 消息含检索结果（mcp_tool_search 的命中列表）
    const searchMessage = bodies[1]?.messages.find((m) => m.role === "tool");
    assert.ok(typeof searchMessage?.content === "string" && searchMessage.content.includes("mcp__alpha__tool_0"));
    // R3 消息含激活工具的真实执行回传（消息序列含此前的检索结果，按内容定位执行回传）
    const toolMessage = bodies[2]?.messages.find((m) => m.role === "tool" && typeof m.content === "string" && m.content.includes("fixture-result"));
    assert.ok(typeof toolMessage?.content === "string" && toolMessage.content.includes("fixture-result(alpha/tool_0)"));
  } finally {
    await harness.close();
  }
});

test("执行安全：未加载直调 → TOOL_MCP_NOT_LOADED + 检索指引", async () => {
  const harness = await startHarness({});
  try {
    const { client, mock } = harness;
    mock.setScript([
      toolCallReply("call_1", "mcp__alpha__tool_0", { path: "a.txt" }),
      textReply("明白，先检索。"),
    ]);
    const created = await client.call<{ sessionId: string }>("session.create", { workspaceRoot: harness.workspace, title: "guard" });
    const done = nextDone(client);
    await client.call("session.send", { sessionId: created.sessionId, input: { text: "直接读" } });
    await done;
    const bodies = mock.bodies();
    assert.ok(bodies.length >= 2);
    const toolMessage = bodies[1]?.messages.find((m) => m.role === "tool");
    assert.ok(typeof toolMessage?.content === "string");
    assert.match(toolMessage.content, /TOOL_MCP_NOT_LOADED/);
    assert.match(toolMessage.content, /mcp_tool_search/);
    // 守卫先于执行：无 fixture 执行痕迹
    assert.ok(!toolMessage.content.includes("fixture-result"));
  } finally {
    await harness.close();
  }
});

test("目录热变更重发布：turn 间注册新工具 → 下一轮目录摘要含新条目", async () => {
  const harness = await startHarness({});
  try {
    const { client, mock, registry } = harness;
    mock.setScript([textReply("第一轮"), textReply("第二轮")]);
    const created = await client.call<{ sessionId: string }>("session.create", { workspaceRoot: harness.workspace, title: "hot" });
    let done = nextDone(client);
    await client.call("session.send", { sessionId: created.sessionId, input: { text: "一" } });
    await done;
    const before = mock.bodies()[0]?.tools?.find((tool) => tool.function.name === MCP_TOOL_SEARCH_NAME);
    assert.ok(!(before?.function.description ?? "").includes("mcp__gamma__fresh"));

    // turn 间热变更：新 server（gamma）工具注册进 registry（等价于 MCP server 连接成功注册）
    registry.register(fakeMcpTool("gamma", "fresh", "Fresh gamma tool", { q: "string" }), "mcp");
    done = nextDone(client);
    await client.call("session.send", { sessionId: created.sessionId, input: { text: "二" } });
    await done;
    const after = mock.bodies()[1]?.tools?.find((tool) => tool.function.name === MCP_TOOL_SEARCH_NAME);
    assert.match(after?.function.description ?? "", /mcp__gamma__fresh/, "目录摘要应重发布含新条目");
  } finally {
    await harness.close();
  }
});
