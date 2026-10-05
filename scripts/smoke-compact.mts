/**
 * auto-compact smoke（M2 T2.1 / NFR-6 专项用例，02-module-design §1.2.5）。
 * 运行：tsx scripts/smoke-compact.mts（或 pnpm run smoke:compact）
 *
 * 链路：node:http 本机 mock OpenAI SSE 服务器（按请求序号脚本化多轮回复 + usage 注入 +
 * 摘要响应延迟制造压缩窗口）→ 临时 RAINCODE_HOME → createAgentServiceNode（in-memory 绑定，
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
 * 用例 D（microcompact 预剪枝，T5.4）：白名单内 read 大结果（940 cps > 600）在 T13 边界被
 *   head+marker+tail 剪枝（350 ≥ 0.9×0.8×400 触发；节省回落 usage 估算后 184 < 320，
 *   full compact 让位不触发）→ compaction.pruned 事件 sourceMessageId 回指原文 + 剪后内容
 *   内联 → 下一请求模型所见与 resume 重放一致（resume 后一致）。
 * 用例 E（白名单外不动）：compactableTools 限 bash，read 大结果原样保留、无剪枝事件。
 * 全程仅本机回环与临时目录：无外呼、无真实密钥。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemoryTransportPair, createRpcClient } from "../packages/rpc/src/index.ts";
import type { RpcClient } from "../packages/rpc/src/index.ts";
import { createAgentServiceNode } from "../packages/server/src/index.ts";
import type { AgentServiceNode } from "../packages/server/src/index.ts";
import { RpcCallError } from "../packages/rpc/src/index.ts";
import { computeWorkspaceHash } from "../packages/storage/src/index.ts";
import type {
  CompactCompletedEventPayload,
  CompactStartedEventPayload,
  SessionCompactResult,
  SessionCreateResult,
  SessionSendResult,
} from "../packages/shared/src/index.ts";
import { beginTurn, startMockLlmServer, toolCallFrame, withTimeout } from "./p0-lib.mts";
import type { SseScript } from "./p0-lib.mts";

const WINDOW_TOKENS = 200; // 收紧的上下文窗口（触发阈值 0.8×200=160；失败上调 0.9×200=180）
const SUMMARY_MARKER = "[上下文压缩]";

// ---------------------------------------------------------------------------
// 场景装配：临时 RAINCODE_HOME + workspace + in-memory 服务节点 + RPC 客户端
// ---------------------------------------------------------------------------

interface Scenario {
  home: string;
  workspace: string;
  client: RpcClient;
  node: AgentServiceNode;
  bodies: Array<{ messages: Array<{ role: string; content: unknown }> }>;
  setScript: (script: SseScript[]) => void;
  close: () => Promise<void>;
}

interface ScenarioOptions {
  windowTokens?: number;
  compaction?: { keepRecentCount?: number; microcompact?: Record<string, unknown> };
}

async function startScenario(name: string, script: SseScript[], options: ScenarioOptions = {}): Promise<Scenario> {
  const home = await mkdtemp(join(tmpdir(), `raincode-smoke-compact-${name}-`));
  const workspace = join(home, "ws");
  await mkdir(workspace, { recursive: true });
  const mock = await startMockLlmServer();
  mock.setScript(script);
  const transports = createInMemoryTransportPair();
  const node = await createAgentServiceNode(transports[1], {
    env: { RAINCODE_HOME: home },
    provider: {
      name: `mock-compact-${name}`,
      baseURL: mock.url,
      model: "mock-model",
      apiKey: "smoke-dummy-key",
      maxContextTokens: options.windowTokens ?? WINDOW_TOKENS,
    },
    tools: { approval: "always-allow" },
    permission: { policy: "default-allow" },
    compaction: options.compaction ?? { keepRecentCount: 1 },
  });
  const client = createRpcClient({ transport: transports[0] });
  await client.call("system.ping", {}); // rpc 握手（首请求必须 system.ping）
  return {
    home,
    workspace,
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

/** 工具调用请求帧（usage 可注入驱动阈值判定）。 */
function toolReply(id: string, name: string, args: object, promptTokens: number): SseScript {
  return {
    frames: [
      { choices: [{ index: 0, delta: { role: "assistant", content: "" } }] },
      toolCallFrame(id, name, args),
      { choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: 5 } },
    ],
    finish: "tool_calls",
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

async function createSessionAt(client: RpcClient, workspaceRoot: string, title: string): Promise<string> {
  const created = (await client.call("session.create", { workspaceRoot, title })) as SessionCreateResult;
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
// 用例 D：microcompact 预剪枝（T5.4）——触发 / full compact 让位 / 回指 / resume 一致
// ---------------------------------------------------------------------------

/** 剪枝素材：单行 1540 code points（head 锚 320 H / 中段 900 Q / tail 锚 320 T）；
 * 剪除 1098 cps ≈ 366 tokens ≥ 256 门槛（过 min savings）。 */
function bigToolText(): string {
  return "H".repeat(320) + "Q".repeat(900) + "T".repeat(320);
}

/** type=tool 消息内容断言辅助。 */
function toolContentOf(messages: Array<{ role: string; content: unknown }>): string {
  const tool = messages.find((message) => message.role === "tool");
  assert.ok(tool !== undefined, "请求上下文含 tool 消息");
  return tool.content as string;
}

interface PrunedPayload {
  replacements: Array<{ sourceMessageId: string; toolName: string; charsBefore: number; charsAfter: number; prunedContent: string }>;
  tokensSaved: number;
  tokensBefore: number;
}

/** 从原始 events.jsonl 找 compaction.pruned 事件行（replay.events 只含末 checkpoint 后增量，剪枝事件在 turn 中途落盘不可见）。 */
async function readPrunedEvent(scenario: Scenario, sessionId: string): Promise<PrunedPayload | null> {
  const eventsFile = join(
    scenario.node.storage.dataRoot,
    "workspaces",
    computeWorkspaceHash(scenario.workspace),
    "sessions",
    sessionId,
    "events.jsonl",
  );
  const raw = await readFile(eventsFile, "utf8");
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    const parsed = JSON.parse(line) as { type: string; name?: string; payload?: unknown };
    if (parsed.type === "event" && parsed.name === "compaction.pruned") {
      return parsed.payload as PrunedPayload;
    }
  }
  return null;
}

async function caseMicrocompact(): Promise<void> {
  const bigText = bigToolText();
  // 窗口 400：full 线 0.8×400=320；micro 线 0.9×320=288。单条剪枝 600/300/100 → 剪后 442 cps
  const scenario = await startScenario("micro", [
    toolReply("call_read_1", "read", { path: "big.txt" }, 350), // req0：u1 r1（350 ≥ 288 触发预剪枝）
    textReply("done1", 50), // req1：u1 r2（剪枝后上下文）
    textReply("done2", 50), // req2：u2 r1
  ], {
    windowTokens: 400,
    compaction: {
      keepRecentCount: 1,
      microcompact: { keepRecentCount: 0, thresholdChars: 600, headChars: 300, tailChars: 100 },
    },
  });
  const watch = watchCompact(scenario.client);
  try {
    await writeFile(join(scenario.workspace, "big.txt"), bigText, "utf8");
    const sessionId = await createSessionAt(scenario.client, scenario.workspace, "micro-prune");
    await sendTurn(scenario, sessionId, "u1");

    // 预剪枝足够：节省 366 tokens 回落 usage 估算（350→0 < 320），full compact 让位
    assert.equal(watch.started.length, 0, "预剪枝后 full compact 未触发");

    // 回指校验：事件行 sourceMessageId 回指原文 message 行 + 尺寸账目
    const payload = await readPrunedEvent(scenario, sessionId);
    assert.ok(payload !== null, "compaction.pruned 事件落盘");
    assert.equal(payload.replacements.length, 1);
    const replacement = payload.replacements[0]!;
    assert.equal(replacement.toolName, "read");
    assert.equal(replacement.charsBefore, 1540);
    assert.equal(replacement.charsAfter, 442);
    assert.ok(replacement.sourceMessageId.length > 0);
    assert.equal(payload.tokensSaved, Math.floor((1540 - 442) / 3));

    // resume 重放一致：重放历史按回指替换为同一剪后内容（head + marker + tail）
    const replay = await scenario.node.storage.resumeSession(sessionId);
    const toolRecord = replay.history.find((message) => message.role === "tool");
    assert.ok(toolRecord !== undefined, "重放历史含 tool 消息");
    const content = toolRecord.content as string;
    assert.equal(replacement.sourceMessageId, toolRecord.id, "回指命中重放历史中的原文消息");
    assert.equal(replacement.prunedContent, content);
    assert.ok(content.startsWith("H".repeat(300)), "head 锚点保留（300 code points）");
    assert.ok(content.endsWith("T".repeat(100)), "tail 锚点保留（100 code points）");
    assert.ok(content.includes("中段已预剪枝"), "中段标记在位");
    assert.ok(!content.includes("Q".repeat(900)), "中段已剪除");
    assert.equal(content.length, 442, "剪后 442 = head 300 + marker 42 + tail 100（≤ 单条阈值 600）");

    // 内存侧一致：下一请求模型所见 = 重放剪后内容
    await sendTurn(scenario, sessionId, "u2");
    assert.equal(toolContentOf(scenario.bodies[1]!.messages), content, "round2 请求上下文 = 剪后内容（内存侧）");
    assert.equal(toolContentOf(scenario.bodies[2]!.messages), content, "下 turn 请求仍为剪后内容");
    console.log("case D: microcompact 预剪枝触发 / full compact 让位 / 回指 / resume 一致 OK");
  } finally {
    watch.stop();
    await scenario.close();
  }
}

// ---------------------------------------------------------------------------
// 用例 E：白名单外不动（compactableTools 限 bash，read 大结果原样保留）
// ---------------------------------------------------------------------------

async function caseWhitelistExclude(): Promise<void> {
  const bigText = bigToolText();
  const scenario = await startScenario("micro-wl", [
    toolReply("call_read_1", "read", { path: "big.txt" }, 300), // req0：300 ≥ 288 触发判定
    textReply("done1", 50), // req1
  ], {
    windowTokens: 400,
    compaction: {
      keepRecentCount: 1,
      microcompact: { keepRecentCount: 0, thresholdChars: 600, headChars: 300, tailChars: 100, compactableTools: ["bash"] },
    },
  });
  const watch = watchCompact(scenario.client);
  try {
    await writeFile(join(scenario.workspace, "big.txt"), bigText, "utf8");
    const sessionId = await createSessionAt(scenario.client, scenario.workspace, "micro-whitelist");
    await sendTurn(scenario, sessionId, "u1");

    const replay = await scenario.node.storage.resumeSession(sessionId);
    assert.equal(await readPrunedEvent(scenario, sessionId), null, "白名单外工具结果不产生剪枝事件");
    const toolRecord = replay.history.find((message) => message.role === "tool");
    assert.ok(toolRecord !== undefined);
    assert.equal(toolRecord.content, bigText, "read 大结果原样保留（白名单外不动）");
    assert.equal(watch.started.length, 0, "无候选无节省，full compact 亦未触发（300 < 320）");
    console.log("case E: 白名单外工具结果不动 OK");
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
  await caseMicrocompact();
  await caseWhitelistExclude();
  console.log("");
  console.log("SMOKE OK");
}

main().catch((err: unknown) => {
  console.error("SMOKE FAILED:", err);
  process.exit(1);
});
