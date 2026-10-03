/**
 * kernel 域接入 smoke（T2.6 二阶段，06-api-spec §2.1/§2.3 / AC-9~12）。
 * 运行：tsx scripts/smoke-kernel.mts（或 pnpm run smoke:kernel）
 *
 * 链路：node:http mock OpenAI SSE（主 mockA + 第二 provider mockB，按请求序回放 + 请求体捕获）+
 * 临时 RAINCODE_HOME/workspace → createAgentServiceNode（provider: null——主客户端缺席，全部会话经
 * config 域 providerId 绑定，同 smoke-p0 被测路径；单价字段经 config.providers.add 协议路径注入）→ 断言：
 * 用例 A rename（AC-9）：session.rename title 前后空格经 schema 层 trim 落库 → session.list 读得
 *   新 title（05 §3.3 投影列）；不存在 id → SESSION_NOT_FOUND。
 * 用例 B fork（AC-9）：两轮对话后 fork → messageCount = 全量历史（2 user + 2 assistant）；fork 结果与
 *   session.created 事件 parentSessionId 回链 + session.list 出现新会话；新会话 resume 后续轮的模型
 *   请求体含分叉前历史（上下文连续性，05 §4.4）；不存在 id → SESSION_NOT_FOUND。
 * 用例 C usage（AC-10）：带单价 provider（input 3 / output 15 USD/Mtok）一轮 → inputTokens/outputTokens>0、
 *   costEstimateUsd>0（(20×3+8×15)/1M=0.00018）；换无单价 provider（add 不带单价 + switch）→ 新会话
 *   usage 无 costEstimateUsd 字段（任一单价缺失不给误导性估算）。
 * 用例 D switch（AC-11）：switch 活跃项变化 + 不存在 id → CONFIG_PROVIDER_NOT_FOUND；已建会话续轮
 *   仍走原绑定（AC-11「当前会话可继续」）；切换后新建会话缺省绑定新活跃 provider（不带 providerId
 *   的 session.create 经 llmFor(undefined) → config.activeProviderId 解析，mockB 被打到，mockA 不再
 *   增长）。
 * 用例 E 受限重试（AC-12）：write 工具 arguments 为合法 JSON 但 path 非字符串 → zod safeParse 失败
 *   （TOOL_INVALID_INPUT，入参非法不进权限，02 §2.4）连续 3 轮 → 第 3 次后 done outcome=failed、
 *   error 事件 code=TOOL_INPUT_RETRY_EXCEEDED、mock 请求数恰 3（不再续轮）。
 * CLI 层（/rename /fork /usage /providers 单价列）：本冒烟走 RPC 层验证协议行为；命令输出形态由
 *   typecheck + 人工确认（T2.6 二阶段范围）。
 * 全程仅本机回环与临时目录：无外呼、无真实密钥（mock provider 不带 apiKey，绝不打印凭据）。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcCallError, createInMemoryTransportPair, createRpcClient } from "../packages/rpc/src/index.ts";
import type { RpcClient } from "../packages/rpc/src/index.ts";
import { createAgentServiceNode } from "../packages/server/src/index.ts";
import type { AgentServiceNode } from "../packages/server/src/index.ts";
import type {
  DoneEventPayload,
  ErrorEventPayload,
  SessionCreatedEventPayload,
  SessionUsageResult,
} from "../packages/shared/src/index.ts";
import { beginTurn, startMockLlmServer, textScript, toolCallFrame, withTimeout } from "./p0-lib.mts";
import type { MockLlmServer, SseScript } from "./p0-lib.mts";

// ---------------------------------------------------------------------------
// 场景装配：临时 RAINCODE_HOME + workspace + 双 mock LLM（A/B/C/E 用 mockA，D 用 mockB）+ 服务节点
// ---------------------------------------------------------------------------

interface Scenario {
  home: string;
  workspace: string;
  client: RpcClient;
  node: AgentServiceNode;
  mockA: MockLlmServer;
  mockB: MockLlmServer;
  close: () => Promise<void>;
}

async function startScenario(): Promise<Scenario> {
  const home = await mkdtemp(join(tmpdir(), "raincode-smoke-kernel-"));
  const workspace = join(home, "ws");
  await mkdir(workspace, { recursive: true });
  const mockA = await startMockLlmServer();
  const mockB = await startMockLlmServer();
  const transports = createInMemoryTransportPair();
  // provider: null —— 主客户端缺席，全部会话经 config 域 providerId 绑定（用例 D 的被测路径）
  const node = await createAgentServiceNode(transports[1], {
    env: { RAINCODE_HOME: home },
    provider: null,
    tools: { approval: "always-allow" },
    permission: { policy: "default-allow" },
  });
  const client = createRpcClient({ transport: transports[0] });
  await client.call("system.ping", {}); // rpc 握手（首请求必须 system.ping）
  // 绑定用 provider（AC-10 单价经 config.providers.add 协议路径注入——node 的 provider 选项
  // 为 ProviderRuntimeConfig 形态，不支持单价字段；首个添加的 provider 引导为活跃，04 §5.2）
  await client.call("config.providers.add", {
    provider: {
      id: "kernel-priced",
      name: "kernel-priced",
      baseURL: mockA.url,
      model: "mock-model",
      maxContextTokens: 8192,
      inputPricePerMtok: 3,
      outputPricePerMtok: 15,
    },
  });
  return {
    home,
    workspace,
    client,
    node,
    mockA,
    mockB,
    close: async () => {
      client.close();
      await node.close();
      await transports[0].close();
      await transports[1].close();
      await mockA.close();
      await mockB.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// 共用步骤
// ---------------------------------------------------------------------------

/** 经 config 域绑定 providerId 的会话创建（provider:null 场景唯一可用绑定路径）。 */
async function createSession(scenario: Scenario, providerId: string | undefined, title: string): Promise<string> {
  const created = (await scenario.client.call("session.create", {
    workspaceRoot: scenario.workspace,
    ...(providerId !== undefined && { providerId }),
    title,
  })) as { sessionId: string };
  return created.sessionId;
}

/** 单轮对话收束（send → done；返回 done 供调用方断言 outcome）。 */
async function sendAndAwait(scenario: Scenario, sessionId: string, text: string): Promise<DoneEventPayload> {
  const run = beginTurn(scenario.client, sessionId, text);
  await run.sendPromise;
  const done = await withTimeout(run.done, 15000, `turn: ${text}`);
  run.stop();
  return done;
}

/**
 * 轮询 session.usage 至 inputTokens 落库（recordUsage 为 done 后的旁路异步写，不 sleep 硬等）。
 * 超时返回末次读数交由调用方断言给出明确差异。
 */
async function pollUsage(scenario: Scenario, sessionId: string): Promise<SessionUsageResult> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const usage = (await scenario.client.call("session.usage", { sessionId })) as SessionUsageResult;
    if (usage.inputTokens > 0 || Date.now() > deadline) {
      return usage;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** 单轮非法 write 调用脚本项（arguments 为合法 JSON 但 path 非字符串 → zod safeParse 失败）。 */
function invalidWriteCall(id: string): SseScript {
  return {
    frames: [toolCallFrame(id, "write", { path: 123, content: "bad args" })],
    finish: "tool_calls",
  };
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

/** A：rename（title trim 落库 + session.list 读得 + 不存在 id SESSION_NOT_FOUND）。 */
async function caseRename(scenario: Scenario): Promise<string> {
  const { client } = scenario;
  const sessionId = await createSession(scenario, "kernel-priced", "kernel-a");
  // AC-9：title 由 schema 层 trim（1~200），前后空格不入库（06 §2.1）
  const renamed = (await client.call("session.rename", {
    sessionId,
    title: "  重命名后的标题  ",
  })) as { sessionId: string; title: string };
  assert.equal(renamed.sessionId, sessionId);
  assert.equal(renamed.title, "重命名后的标题", "schema 层 trim 应去除 title 前后空格");
  const list = (await client.call("session.list", {})) as { items: Array<{ id: string; title: string }> };
  const row = list.items.find((item) => item.id === sessionId);
  assert.ok(row !== undefined, "session.list 应含被重命名会话");
  assert.equal(row.title, "重命名后的标题", "session.list 读库即得新 title（05 §3.3）");
  await assert.rejects(
    client.call("session.rename", { sessionId: "session_missing", title: "任意" }),
    (err: unknown) => err instanceof RpcCallError && err.code === "SESSION_NOT_FOUND",
  );
  console.log("case A: rename（title trim 落库 + list 读得 + SESSION_NOT_FOUND）OK");
  return sessionId;
}

/** B：fork（messageCount + parentSessionId 回链 + list 可见 + 续轮上下文连续 + SESSION_NOT_FOUND）。 */
async function caseFork(scenario: Scenario): Promise<void> {
  const { client, mockA } = scenario;
  const sessionId = await createSession(scenario, "kernel-priced", "kernel-b");
  mockA.setScript([textScript("B 回复一"), textScript("B 回复二")]);
  assert.equal((await sendAndAwait(scenario, sessionId, "B 第一问")).outcome, "completed");
  assert.equal((await sendAndAwait(scenario, sessionId, "B 第二问")).outcome, "completed");

  // fork：结果回链 + session.created 事件携带 kind=main/parentSessionId（06 §3.2 A 组 T2.6 扩展）
  let resolveCreated!: (payload: SessionCreatedEventPayload) => void;
  const createdPromise = new Promise<SessionCreatedEventPayload>((r) => (resolveCreated = r));
  const offCreated = client.onEvent("session.created", (payload) => resolveCreated(payload as SessionCreatedEventPayload));
  const fork = (await client.call("session.fork", { sessionId, title: "kernel-b-fork" })) as {
    sessionId: string;
    parentSessionId: string;
    title: string;
    messageCount: number;
  };
  const created = await withTimeout(createdPromise, 5000, "fork session.created event");
  offCreated();
  assert.equal(fork.parentSessionId, sessionId, "fork 结果回链源会话");
  assert.equal(fork.title, "kernel-b-fork");
  assert.equal(fork.messageCount, 4, "全量历史复制：2 轮对话 = 2 user + 2 assistant");
  assert.equal(created.sessionId, fork.sessionId, "session.created 指向分叉新会话");
  assert.equal(created.parentSessionId, sessionId, "事件 parentSessionId 回链源会话");
  assert.equal(created.kind, "main", "分叉会话 kind=main");
  const list = (await client.call("session.list", {})) as { items: Array<{ id: string }> };
  assert.ok(list.items.some((item) => item.id === fork.sessionId), "session.list 出现分叉新会话");

  // 上下文连续性：resume（幂等）→ 续发一轮 → mock 捕获请求体含分叉前历史（05 §4.4）
  await client.call("session.resume", { sessionId: fork.sessionId });
  const bodiesStart = mockA.bodies.length;
  assert.equal((await sendAndAwait(scenario, fork.sessionId, "B 分叉后第一问")).outcome, "completed");
  const body = mockA.bodies[bodiesStart];
  assert.ok(body !== undefined, "应捕获续轮模型请求体");
  assert.ok(
    body.messages.some((m) => m.role === "user" && m.content === "B 第一问"),
    "续轮上下文含分叉前第一轮历史",
  );
  assert.ok(
    body.messages.some((m) => m.role === "user" && m.content === "B 第二问"),
    "续轮上下文含分叉前第二轮历史",
  );

  await assert.rejects(
    client.call("session.fork", { sessionId: "session_missing" }),
    (err: unknown) => err instanceof RpcCallError && err.code === "SESSION_NOT_FOUND",
  );
  console.log("case B: fork（messageCount + 回链 + list 可见 + 续轮上下文连续 + SESSION_NOT_FOUND）OK");
}

/** C：usage（带单价估算 (20×3+8×15)/1M=0.00018 / 无单价省略 costEstimateUsd 字段）。 */
async function caseUsage(scenario: Scenario): Promise<void> {
  const { client, mockA } = scenario;
  // 生效视图含单价字段（06 §2.3 providerInfo）；首个添加的 provider 引导为活跃（04 §5.2）
  const list1 = (await client.call("config.providers.list", {})) as {
    providers: Array<{ id: string; inputPricePerMtok?: number; outputPricePerMtok?: number }>;
    activeProviderId?: string;
  };
  assert.equal(list1.activeProviderId, "kernel-priced", "首个 provider 引导为活跃");
  const pricedInfo = list1.providers.find((p) => p.id === "kernel-priced");
  assert.ok(
    pricedInfo !== undefined && pricedInfo.inputPricePerMtok === 3 && pricedInfo.outputPricePerMtok === 15,
    "providers.list 生效视图含单价字段",
  );

  const sessionId = await createSession(scenario, "kernel-priced", "kernel-usage-priced");
  mockA.setScript([textScript("C 带单价回复")]);
  assert.equal((await sendAndAwait(scenario, sessionId, "C 第一问")).outcome, "completed");
  const usage = await pollUsage(scenario, sessionId);
  assert.ok(usage.inputTokens > 0, "inputTokens > 0（usage 帧累计）");
  assert.ok(usage.outputTokens > 0, "outputTokens > 0");
  // T4.5 修复后语义：turns_count 随 completed turn 原子自增（此前恒为 0 的失真读数）
  assert.ok(Number.isInteger(usage.turnsCount) && usage.turnsCount >= 1, "turnsCount 读数应为完成回合数（≥1）");
  assert.ok(
    usage.costEstimateUsd !== undefined && usage.costEstimateUsd > 0,
    "活跃 provider 带单价 → costEstimateUsd > 0",
  );
  // 估算口径（06 §2.1）：input×inputPrice/1M + output×outputPrice/1M = (20×3+8×15)/1e6
  assert.ok(
    Math.abs(usage.costEstimateUsd - 0.00018) < 1e-9,
    `估算应为 0.00018，实得 ${String(usage.costEstimateUsd)}`,
  );

  // 换无单价 provider：add 不带单价 → switch → 新会话 usage 无 costEstimateUsd 字段
  await client.call("config.providers.add", {
    provider: { id: "kernel-plain", name: "kernel-plain", baseURL: mockA.url, model: "mock-model", maxContextTokens: 8192 },
  });
  const switched = (await client.call("config.providers.switch", { providerId: "kernel-plain" })) as {
    activeProviderId: string;
  };
  assert.equal(switched.activeProviderId, "kernel-plain");
  const plainSessionId = await createSession(scenario, "kernel-plain", "kernel-usage-plain");
  mockA.setScript([textScript("C 无单价回复")]);
  assert.equal((await sendAndAwait(scenario, plainSessionId, "C 第二问")).outcome, "completed");
  const plainUsage = await pollUsage(scenario, plainSessionId);
  assert.ok(plainUsage.inputTokens > 0, "无单价 provider 会话仍有用量读数");
  assert.equal(plainUsage.costEstimateUsd, undefined, "任一单价缺失 → 省略 costEstimateUsd（06 §2.1）");
  console.log("case C: usage（带单价估算 0.00018 / 无单价省略字段 / turnsCount 读数）OK");
}

/** D：switch（活跃项切换 / NOT_FOUND / 已建会话不动 / 新会话走新 provider，旧 mock 不再增长）。 */
async function caseSwitch(scenario: Scenario): Promise<void> {
  const { client, mockA, mockB } = scenario;
  // 第二个 provider 指向第二 mock server
  await client.call("config.providers.add", {
    provider: { id: "kernel-alt", name: "kernel-alt", baseURL: mockB.url, model: "mock-model", maxContextTokens: 8192 },
  });

  // 对照基线：切换前按 config 域绑定 p1（mockA）的会话
  const preId = await createSession(scenario, "kernel-priced", "kernel-switch-pre");
  mockA.setScript([textScript("D 前段回复")]);
  assert.equal((await sendAndAwait(scenario, preId, "D 切换前一轮")).outcome, "completed");
  const baseA = mockA.bodies.length;
  assert.ok(baseA >= 1, "切换前会话请求打到第一 mock");
  assert.equal(mockB.bodies.length, 0, "第二 mock 未被打到");

  // switch：活跃项变化；不存在 id → CONFIG_PROVIDER_NOT_FOUND 且活跃项不动
  const switched = (await client.call("config.providers.switch", { providerId: "kernel-alt" })) as {
    activeProviderId: string;
  };
  assert.equal(switched.activeProviderId, "kernel-alt");
  const list = (await client.call("config.providers.list", {})) as { activeProviderId?: string };
  assert.equal(list.activeProviderId, "kernel-alt", "providers.list 读得切换后的活跃项");
  await assert.rejects(
    client.call("config.providers.switch", { providerId: "kernel-missing" }),
    (err: unknown) => err instanceof RpcCallError && err.code === "CONFIG_PROVIDER_NOT_FOUND",
  );
  const stillActive = (await client.call("config.providers.list", {})) as { activeProviderId?: string };
  assert.equal(stillActive.activeProviderId, "kernel-alt", "切换失败不影响当前活跃项");

  // AC-11「当前会话可继续」：已建会话续轮仍走原绑定 provider（llm 实例与历史不动）
  assert.equal((await sendAndAwait(scenario, preId, "D 切换后原会话续轮")).outcome, "completed");
  assert.equal(mockA.bodies.length, baseA + 1, "已建会话仍走原绑定 provider");
  assert.equal(mockB.bodies.length, 0);

  // 切换后新会话走新 provider（AC-11 字面语义：createSession 不带 providerId → 缺省绑定
  // config.activeProviderId，agent-service.llmFor(undefined) 解析链路）；旧 mock 不再增长
  mockB.setScript([textScript("D 新 provider 回复")]);
  const postId = await createSession(scenario, undefined, "kernel-switch-post");
  assert.equal((await sendAndAwait(scenario, postId, "D 切换后新会话一轮")).outcome, "completed");
  assert.ok(mockB.bodies.length >= 1, "新会话请求打到第二 mock");
  assert.equal(mockA.bodies.length, baseA + 1, "第一 mock 不再增长");
  console.log("case D: switch（活跃项切换 / NOT_FOUND / 已建会话不动 / 新会话走新 provider）OK");
}

/** E：受限重试（3 次非法入参 → failed + TOOL_INPUT_RETRY_EXCEEDED + 恰 3 次模型请求）。 */
async function caseRestrictedRetry(scenario: Scenario): Promise<void> {
  const { client, mockA } = scenario;
  const sessionId = await createSession(scenario, "kernel-plain", "kernel-retry");
  // 非法参数形态：arguments 为合法 JSON（toolCallFrame 内 JSON.stringify）但 path 非字符串 →
  // write 工具 zod safeParse 失败（TOOL_INVALID_INPUT，入参非法不进权限，02 §2.4）；
  // mock 脚本单项耗尽后重放 → 每轮「自纠」请求拿到同一非法 tool_call，直至 AC-12 上限收束。
  mockA.setScript([invalidWriteCall("t1")]);
  const errors: ErrorEventPayload[] = [];
  const offError = client.onEvent("error", (payload) => errors.push(payload as ErrorEventPayload));
  const run = beginTurn(client, sessionId, "E 触发非法工具参数");
  await run.sendPromise;
  const done = await withTimeout(run.done, 15000, "E restricted retry turn");
  run.stop();
  offError();
  assert.equal(done.outcome, "failed", "受限重试超限 → failed 收束（AC-12）");
  const exceeded = errors.find((e) => e.code === "TOOL_INPUT_RETRY_EXCEEDED");
  assert.ok(exceeded !== undefined, "error 事件 code=TOOL_INPUT_RETRY_EXCEEDED（06 §4.3 段 7）");
  assert.equal(exceeded.scope, "turn");
  assert.ok(exceeded.message.includes("受限重试上限（3）"), "message 含受限重试上限说明");
  assert.equal(mockA.served(), 3, "恰 3 次模型请求（第 3 次失败后不再续轮）");
  assert.equal(run.toolCompleted.length, 3, "每轮 1 次工具调用收敛 completed");
  for (const completed of run.toolCompleted) {
    assert.equal(completed.isError, true, "非法入参工具调用以 isError 收敛");
  }
  console.log("case E: 受限重试（3 次非法入参 → failed + TOOL_INPUT_RETRY_EXCEEDED + 不再续轮）OK");
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const scenario = await startScenario();
  try {
    await caseRename(scenario);
    await caseFork(scenario);
    await caseUsage(scenario);
    await caseSwitch(scenario);
    await caseRestrictedRetry(scenario);
  } finally {
    await scenario.close();
  }
  console.log("");
  console.log("SMOKE OK");
}

main().catch((err: unknown) => {
  console.error("SMOKE FAILED:", err);
  process.exit(1);
});
