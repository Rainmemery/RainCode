/**
 * auto-compact smoke（M2 T2.1 / NFR-6 专项用例，02-module-design §1.2.5）。
 * 运行：tsx scripts/smoke-compact.mts（或 pnpm run smoke:compact）
 *
 * 链路：node:http 本机 mock OpenAI SSE 服务器（按请求序号脚本化多轮回复 + usage 注入 +
 * 摘要响应延迟制造压缩窗口）→ 临时 NOVACODE_HOME → createAgentServiceNode（in-memory 绑定，
 * default-allow 策略，maxContextTokens=200 / keepRecentCount=1 收紧触发条件）
 * → 断言：
 * 用例 A（auto 触发 + 异步不阻塞 + 提交语义 + resume 连续性）：
 *   usage promptTokens 越阈值（500 ≥ 0.8×200）→ compact.started（trigger=auto）→ 摘要延迟窗口内
 *   send 仍受理（NFR-6 不阻塞）→ compact.completed ok:true epoch+1 → 压缩窗口期新增消息经
 *   slice 合并不丢 → 下一 turn 模型请求上下文 = [摘要消息, 保留区, 窗口期消息] →
 *   storage.resumeSession 全量重放历史与内存态一致（任务连续性）。
 * 用例 B（摘要失败）：空摘要 → ok:false + 原历史保留 + 阈值临时上调 90%（170 < 0.9×200 不再触发）。
 * 用例 C（手动 compact）：低于阈值可手动压缩；in-flight 幂等复用 ticket（alreadyRunning）；
 *   空历史手动压缩 → INVALID_PARAMS。
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
import { RpcCallError } from "../packages/rpc/src/index.ts";
import type {
  CompactCompletedEventPayload,
  CompactStartedEventPayload,
  SessionCompactResult,
  SessionCreateResult,
  SessionSendResult,
} from "../packages/shared/src/index.ts";
import { beginTurn, startMockLlmServer, withTimeout } from "./p0-lib.mts";
import type { SseScript } from "./p0-lib.mts";

const WINDOW_TOKENS = 200; // 收紧的上下文窗口（触发阈值 0.8×200=160；失败上调 0.9×200=180）
const SUMMARY_MARKER = "[上下文压缩]";

// ---------------------------------------------------------------------------
// 场景装配：临时 NOVACODE_HOME + workspace + in-memory 服务节点 + RPC 客户端
// ---------------------------------------------------------------------------

interface Scenario {
  home: string;
  client: RpcClient;
  node: AgentServiceNode;
  bodies: Array<{ messages: Array<{ role: string; content: unknown }> }>;
  setScript: (script: SseScript[]) => void;
  close: () => Promise<void>;
}

async function startScenario(name: string, script: SseScript[]): Promise<Scenario> {
  const home = await mkdtemp(join(tmpdir(), `novacode-smoke-compact-${name}-`));
  const workspace = join(home, "ws");
  await mkdir(workspace, { recursive: true });
  const mock = await startMockLlmServer();
  mock.setScript(script);
  const transports = createInMemoryTransportPair();
  const node = await createAgentServiceNode(transports[1], {
    env: { NOVACODE_HOME: home },
    provider: {
      name: `mock-compact-${name}`,
      baseURL: mock.url,
      model: "mock-model",
      apiKey: "smoke-dummy-key",
      maxContextTokens: WINDOW_TOKENS,
    },
    tools: { approval: "always-allow" },
    permission: { policy: "default-allow" },
    compaction: { keepRecentCount: 1 },
  });
  const client = createRpcClient({ transport: transports[0] });
  await client.call("system.ping", {}); // rpc 握手（首请求必须 system.ping）
  return {
    home,
    client,
    node,
    bodies: mock.bodies,
    setScript: mock.setScript,
    close: async () => {
      client.close();
      await new Promise((r) => setTimeout(r, 50)); // 排空事件落库队列（emitPersisted 为 fire-and-forget）
      await node.close();
      await transports[0].close();
      await transports[1].close();
      await mock.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

// 请求帧（usage promptTokens 可注入，驱动阈值判定）
function textReply(text: string, promptTokens: number): SseScript {
  return {
    frames: [
      { choices: [{ index: 0, delta: { role: "assistant", content: "" } }] },
      { choices: [{ index: 0, delta: { content: text } }] },
      { choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: 5 } },
    ],
    finish: "stop",
  };
}

/** 摘要请求的脚本项：正文帧 + 可选延迟（制造压缩窗口）。 */
function summaryReply(text: string, delayMs?: number): SseScript {
  return {
    frames: [{ choices: [{ index: 0, delta: { content: text } }] }],
    finish: "stop",
    ...(delayMs !== undefined && { delayMs }),
  };
}

/** 空响应（零内容帧）→ 摘要为空 → 失败路径（02 §1.4）。 */
function emptySummary(): SseScript {
  return { frames: [], finish: "stop" };
}

interface CompactWatch {
  started: CompactStartedEventPayload[];
  completed: CompactCompletedEventPayload[];
  stop: () => void;
}

function watchCompact(client: RpcClient): CompactWatch {
  const started: CompactStartedEventPayload[] = [];
  const completed: CompactCompletedEventPayload[] = [];
  const offStarted = client.onEvent("compact.started", (payload) => started.push(payload as CompactStartedEventPayload));
  const offCompleted = client.onEvent("compact.completed", (payload) =>
    completed.push(payload as CompactCompletedEventPayload));
  return { started, completed, stop: () => { offStarted(); offCompleted(); } };
}

async function sendTurn(scenario: Scenario, sessionId: string, text: string): Promise<void> {
  const run = beginTurn(scenario.client, sessionId, text);
  const admission = (await run.sendPromise) as SessionSendResult;
  assert.equal(admission.admission, "started");
  await withTimeout(run.done, 15000, `turn done: ${text}`);
  run.stop();
}

async function createSession(client: RpcClient): Promise<string> {
  const created = (await client.call("session.create", { workspaceRoot: process.cwd() })) as SessionCreateResult;
  return created.sessionId;
}

// ---------------------------------------------------------------------------
// 用例 A：auto 触发 + 异步不阻塞 + 提交语义 + resume 连续性
// ---------------------------------------------------------------------------

async function caseAutoCompact(): Promise<void> {
  const scenario = await startScenario("auto", [
    textReply("turn1-reply", 500), // req0：越阈值 usage → 下个 turn 边界触发
    summaryReply("用户要修一个登录 Bug；已确认根因在 auth.ts；下一步改 token 刷新。", 300), // req1：摘要（延迟窗口）
    textReply("turn2-reply", 500), // req2：turn2 round1（压缩期间继续）
    textReply("turn3-reply", 100), // req3：turn3 round1（压缩期间受理；usage 回落 < 阈值 → 不再重复触发）
    textReply("turn4-reply", 500), // req4：turn4 round1（应使用压缩后上下文）
  ]);
  const watch = watchCompact(scenario.client);
  try {
    const sessionId = await createSession(scenario.client);
    await sendTurn(scenario, sessionId, "u1"); // 历史 [u1, a1]；usage 500 越阈值
    await sendTurn(scenario, sessionId, "u2"); // pre-loop 触发压缩（摘要覆盖 [u1,a1]，保留 [u2]）

    assert.equal(watch.started.length, 1, "compact.started 恰一次");
    assert.equal(watch.started[0]!.trigger, "auto");
    assert.equal(watch.started[0]!.epoch, 0);
    assert.equal(watch.completed.length, 0, "摘要延迟窗口内压缩未完成");

    // NFR-6：压缩异步进行中，send 照常受理并完成（请求体仍为压缩前上下文，属允许时序）
    await sendTurn(scenario, sessionId, "u3");
    assert.equal(watch.completed.length, 0, "u3 turn 完成时摘要仍在窗口内（异步不阻塞）");

    await withTimeout(
      (async () => {
        while (watch.completed.length === 0) await new Promise((r) => setTimeout(r, 10));
      })(),
      5000,
      "compact.completed",
    );
    assert.equal(watch.completed[0]!.ok, true);
    assert.equal(watch.completed[0]!.epoch, 1, "提交 epoch+1");

    // 下一 turn 上下文 = [摘要消息, 保留区 u2, 窗口期 a2, u3, a3, u4]（窗口期新增经 slice 合并不丢）
    await sendTurn(scenario, sessionId, "u4");
    const context = scenario.bodies[4]!.messages;
    assert.equal(context.length, 6, `压缩后上下文 6 条，实得 ${String(context.length)}`);
    const first = context[0]!.content as string;
    assert.ok(first.includes(SUMMARY_MARKER), "首条为压缩摘要消息");
    assert.ok(first.includes("auth.ts"), "摘要内容为模型生成的会话摘要");
    assert.equal(context[1]!.content, "u2", "保留区消息原样保留");
    assert.equal(context[5]!.content, "u4", "最新消息在位");

    // resume 连续性：全量重放历史与内存态一致（压缩标记重放语义）
    const replay = await scenario.node.storage.resumeSession(sessionId);
    assert.equal(replay.history.length, 7, "摘要 + 保留区/窗口期消息 + u4/a4");
    assert.ok((replay.history[0]!.content as string).includes(SUMMARY_MARKER));
    assert.equal(replay.history[0]!.id.startsWith("msg_compact_"), true, "摘要消息确定性 id");
    assert.equal(replay.history[5]!.content, "u4");
    assert.equal(replay.epoch, 1, "sessions.epoch 单调到 1");

    // in-flight 期间未产生第二个 auto 触发（去重锁）
    assert.equal(watch.started.length, 1);
    console.log("case A: auto-compact 触发/异步不阻塞/提交语义/resume 连续性 OK");
  } finally {
    watch.stop();
    await scenario.close();
  }
}

// ---------------------------------------------------------------------------
// 用例 B：摘要失败 → 保留原历史 + 阈值临时上调 90%
// ---------------------------------------------------------------------------

async function caseFailure(): Promise<void> {
  const scenario = await startScenario("fail", [
    textReply("b1", 500), // req0：越阈值
    emptySummary(), // req1：摘要为空 → 失败
    textReply("b2", 170), // req2：170 < 0.9×200 → 失败后不再触发
    textReply("b3", 170), // req3
  ]);
  const watch = watchCompact(scenario.client);
  try {
    const sessionId = await createSession(scenario.client);
    await sendTurn(scenario, sessionId, "u1");
    await sendTurn(scenario, sessionId, "u2"); // pre-loop 触发 → 摘要失败

    await withTimeout(
      (async () => {
        while (watch.completed.length === 0) await new Promise((r) => setTimeout(r, 10));
      })(),
      5000,
      "compact.completed（失败）",
    );
    assert.equal(watch.completed[0]!.ok, false);
    assert.ok(watch.completed[0]!.failure !== undefined, "failure.reason 存在");
    assert.equal(watch.started.length, 1);

    // 原历史保留：u3 的请求上下文无摘要消息（首条仍为 u1）
    await sendTurn(scenario, sessionId, "u3");
    const context = scenario.bodies[2]!.messages;
    assert.equal(context[0]!.content, "u1", "压缩失败后历史原样保留");

    // 阈值临时上调 90%：170 ≥ 0.8×200 但 < 0.9×200 → u4 边界不再触发
    await sendTurn(scenario, sessionId, "u4");
    assert.equal(watch.started.length, 1, "失败后阈值上调，未再触发");
    console.log("case B: 摘要失败保留原历史 + 阈值临时上调 OK");
  } finally {
    watch.stop();
    await scenario.close();
  }
}

// ---------------------------------------------------------------------------
// 用例 C：手动 compact（低于阈值可压缩 / in-flight 幂等 / 空历史 INVALID_PARAMS）
// ---------------------------------------------------------------------------

async function caseManual(): Promise<void> {
  const scenario = await startScenario("manual", [
    textReply("c1", 20), // 低于阈值：20 < 160 → 不自动触发
    textReply("c2", 20),
    textReply("c3", 20),
    summaryReply("手动压缩摘要：任务 A 已完成；任务 B 待办。", 250),
  ]);
  const watch = watchCompact(scenario.client);
  try {
    const sessionId = await createSession(scenario.client);
    await sendTurn(scenario, sessionId, "u1");
    await sendTurn(scenario, sessionId, "u2");
    await sendTurn(scenario, sessionId, "u3");
    assert.equal(watch.started.length, 0, "低于阈值不自动触发");

    // 手动触发 + in-flight 幂等复用 ticket
    const ticket1 = (await scenario.client.call("session.compact", { sessionId })) as SessionCompactResult;
    assert.equal(ticket1.alreadyRunning, false);
    const ticket2 = (await scenario.client.call("session.compact", { sessionId })) as SessionCompactResult;
    assert.equal(ticket2.alreadyRunning, true, "in-flight 幂等复用");
    assert.equal(ticket1.compactionId, ticket2.compactionId);

    await withTimeout(
      (async () => {
        while (watch.completed.length === 0) await new Promise((r) => setTimeout(r, 10));
      })(),
      5000,
      "manual compact.completed",
    );
    assert.equal(watch.completed[0]!.ok, true);
    assert.equal(watch.started[0]!.trigger, "manual");
    const replay = await scenario.node.storage.resumeSession(sessionId);
    assert.ok((replay.history[0]!.content as string).includes(SUMMARY_MARKER));
    console.log("case C: 手动压缩 / in-flight 幂等 OK");

    // 空历史手动压缩 → INVALID_PARAMS
    const scenario2 = await startScenario("manual-empty", [textReply("x", 20)]);
    try {
      const sessionId2 = await createSession(scenario2.client);
      await assert.rejects(
        scenario2.client.call("session.compact", { sessionId: sessionId2 }),
        (err: unknown) => err instanceof RpcCallError && err.code === "INVALID_PARAMS",
      );
      console.log("case C: 空历史 INVALID_PARAMS OK");
    } finally {
      await scenario2.close();
    }
  } finally {
    watch.stop();
    await scenario.close();
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await caseAutoCompact();
  await caseFailure();
  await caseManual();
  console.log("");
  console.log("SMOKE OK");
}

main().catch((err: unknown) => {
  console.error("SMOKE FAILED:", err);
  process.exit(1);
});
