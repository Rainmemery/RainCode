/**
 * P1 工具 smoke（T2.7 二阶段：web_fetch / ask_user_question）。
 * 运行：tsx scripts/smoke-p1tools.mts（或 pnpm run smoke:p1tools）
 *
 * 链路：node:http mock OpenAI SSE 服务器（按请求序回放脚本 + toolCallFrame 工具调用下发）+
 * 临时 RAINCODE_HOME/workspace → createAgentServiceNode（in-memory 绑定，default-allow 权限
 * 策略——无 PermissionRuntime 装配 → askUser 交互通道缺省 = headless fail-safe 口径）→
 * RPC session.send → agent-core turn（ToolSchedule → ToolExecution → 回传）→ 断言：
 *
 * 用例 A（web_fetch SSRF 端到端）：turn 内 mock 下发 toolCallFrame("web_fetch",
 *   {url: "http://127.0.0.1:<mock 端口>/x"}) → SSRF 守卫拒绝回环地址（02 §2.4）→
 *   tool_call.completed isError 且 error.code=TOOL_SSRF_BLOCKED、错误注明原因（127.0.0.1）→
 *   模型收到错误结果后继续纯文本收束（turn 不失败）。web_fetch 正向抓取路径由单测覆盖
 *   （packages/tools/test/web-fetch.test.ts 本地 server + dns mock），冒烟不断言正向网络。
 * 用例 B（ask_user_question headless fail-safe）：无交互通道 → TOOL_UNAVAILABLE 收敛
 *   （02 §2.4），turn 继续收束；两工具经 tool.tools.list 可见（builtin 注册）。
 * 注册与回归接线：package.json smoke:p1tools + smoke-p0.mts 回归数组。
 *
 * 全程仅本机回环与临时目录：无外呼、无真实密钥。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemoryTransportPair, createRpcClient } from "../packages/rpc/src/index.ts";
import type { RpcClient } from "../packages/rpc/src/index.ts";
import { createAgentServiceNode } from "../packages/server/src/index.ts";
import type { AgentServiceNode } from "../packages/server/src/index.ts";
import type { DoneEventPayload, ToolToolsListResult } from "../packages/shared/src/index.ts";
import { beginTurn, startMockLlmServer, textScript, toolCallFrame, withTimeout } from "./p0-lib.mts";
import type { MockLlmServer } from "./p0-lib.mts";

// ---------------------------------------------------------------------------
// 场景装配：临时 RAINCODE_HOME + workspace + mock LLM + default-allow 服务节点
// ---------------------------------------------------------------------------

interface Scenario {
  home: string;
  workspace: string;
  sessionId: string;
  client: RpcClient;
  node: AgentServiceNode;
  mock: MockLlmServer;
  close: () => Promise<void>;
}

async function startScenario(): Promise<Scenario> {
  const home = await mkdtemp(join(tmpdir(), "raincode-smoke-p1tools-"));
  const workspace = join(home, "ws");
  await mkdir(workspace, { recursive: true });
  const mock = await startMockLlmServer();
  const transports = createInMemoryTransportPair();
  // default-allow（仅开发策略）：无 PermissionRuntime → askUser 通道缺省（headless 口径被测）；
  // web_fetch readOnly=true 走 metadata 快速通道直达 SSRF 守卫（normal 策略下额外多一次逐次
  // 审批，判定链行为由 smoke:permission 既有用例覆盖）
  const node = await createAgentServiceNode(transports[1], {
    env: { RAINCODE_HOME: home },
    provider: null,
    tools: { approval: "always-allow" },
    permission: { policy: "default-allow" },
  });
  const client = createRpcClient({ transport: transports[0] });
  await client.call("system.ping", {});
  // provider 走 config 域绑定（与 smoke-kernel 同口径：node 的 provider 选项为 null）
  const added = (await client.call("config.providers.add", {
    provider: {
      id: "p1tools",
      name: "p1tools",
      baseURL: mock.url,
      model: "mock-model",
      maxContextTokens: 8192,
    },
  })) as { provider: { id: string } };
  assert.equal(added.provider.id, "p1tools");
  const created = (await client.call("session.create", {
    workspaceRoot: workspace,
    providerId: "p1tools",
    title: "p1-tools",
  })) as { sessionId: string };
  return {
    home,
    workspace,
    sessionId: created.sessionId,
    client,
    node,
    mock,
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

/** 单轮工具调用：mock 脚本（tool_call + 收束文本）→ send → done 与工具完成事件。 */
async function runToolTurn(
  scenario: Scenario,
  toolCallId: string,
  toolName: string,
  args: object,
  summary: string,
): Promise<{ done: DoneEventPayload; run: ReturnType<typeof beginTurn> }> {
  const { client, mock } = scenario;
  mock.setScript([
    {
      frames: [
        { choices: [{ index: 0, delta: { role: "assistant", content: "" } }] },
        toolCallFrame(toolCallId, toolName, args),
      ],
      finish: "tool_calls" as const,
    },
    textScript(summary),
  ]);
  const run = beginTurn(client, scenario.sessionId, `P1 工具轮：${toolName}`);
  await run.sendPromise;
  const done = await withTimeout(run.done, 15000, `turn: ${toolName}`);
  return { done, run };
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

/** A：web_fetch 命中回环地址 → SSRF 防护端到端（02 §2.4 直接拒绝并注明原因）。 */
async function caseWebFetchSsrf(scenario: Scenario): Promise<void> {
  const targetUrl = `http://127.0.0.1:${String(scenario.mock.port)}/x`;
  const { done, run } = await runToolTurn(
    scenario,
    "wf-1",
    "web_fetch",
    { url: targetUrl },
    "fetch 失败已知晓，不再重试",
  );
  run.stop();
  assert.equal(done.outcome, "completed", "工具失败是数据不是协议错误，turn 应继续收束");
  // tool_call.completed 事件无 toolName 字段（06 §3.2），按 toolCallId 归因
  const hit = run.toolCompleted.find((event) => event.toolCallId === "wf-1");
  assert.ok(hit !== undefined, "应收到 web_fetch 的 tool_call.completed");
  assert.equal(hit.isError, true, "SSRF 拦截应以 isError 收敛");
  assert.equal(hit.error?.code, "TOOL_SSRF_BLOCKED", "错误码应为 TOOL_SSRF_BLOCKED");
  assert.ok(
    (hit.error?.message ?? "").includes("127.0.0.1"),
    "错误应注明被拦地址（02 §2.4「错误注明原因」）",
  );
  console.log("case A: web_fetch 回环地址 SSRF 端到端拦截（TOOL_SSRF_BLOCKED + 注明原因）OK");
}

/** B：ask_user_question 无交互通道 → TOOL_UNAVAILABLE；两工具 builtin 注册可见。 */
async function caseAskUserHeadless(scenario: Scenario): Promise<void> {
  const tools = (await scenario.client.call("tool.tools.list", {})) as ToolToolsListResult;
  const ask = tools.tools.find((tool) => tool.name === "ask_user_question");
  const fetch = tools.tools.find((tool) => tool.name === "web_fetch");
  assert.ok(ask !== undefined, "ask_user_question 应注册为 builtin");
  assert.ok(fetch !== undefined, "web_fetch 应注册为 builtin");
  assert.equal(fetch.metadata.sideEffectScope, "network");
  assert.equal(fetch.metadata.needsApproval, true);

  const { done, run } = await runToolTurn(
    scenario,
    "aq-1",
    "ask_user_question",
    { question: "继续吗？", choices: ["是", "否"] },
    "用户不可达，按默认方案继续",
  );
  run.stop();
  assert.equal(done.outcome, "completed", "headless 失效收敛不失败 turn");
  const hit = run.toolCompleted.find((event) => event.toolCallId === "aq-1");
  assert.ok(hit !== undefined, "应收到 ask_user_question 的 tool_call.completed");
  assert.equal(hit.isError, true);
  assert.equal(hit.error?.code, "TOOL_UNAVAILABLE", "无交互通道应 TOOL_UNAVAILABLE（fail-safe）");
  console.log("case B: ask_user_question headless → TOOL_UNAVAILABLE + builtin 注册可见 OK");
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const scenario = await startScenario();
  try {
    await caseWebFetchSsrf(scenario);
    await caseAskUserHeadless(scenario);
    // 等待 emitPersisted 的 fire-and-forget 写尾排干（checkpoint fsync + 末尾事件行），
    // 避免 node.close() 关闭句柄与在途写入竞态产生 EBADF 噪声（与断言无关）
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  } finally {
    await scenario.close();
  }
  console.log("");
  console.log("SMOKE OK");
}

main().catch((reason: unknown) => {
  console.error("SMOKE FAILED:", reason);
  process.exit(1);
});
