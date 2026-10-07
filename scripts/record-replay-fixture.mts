/**
 * T6.2 会话录制回放 lane 录制工具（07 §12.2）：种子会话 → 测试 fixture 归档。
 * 运行：pnpm record:replay-fixtures（mock LLM 驱动真实服务节点，字节级 events.jsonl 归档）。
 *
 * 四场景（覆盖重放语义的关键面，07 §12.2 验收 ≥3）：
 * - plain-chat：两轮纯文本（基线：message/checkpoint 行双路重放）；
 * - tool-roundtrip：真实 write 工具往返（tool_call 块 + role:"tool" 结果行配对）；
 * - compaction：手动 session.compact（compaction.applied 标记 + epoch 1 + 摘要替换重放语义）+ 压缩后新轮；
 * - crash-seed：正常一轮后节点关闭，文件级注入悬挂 assistant tool_call 消息 + 半行截尾
 *   （05 §4.4 悬挂补齐 / §4.5 残尾修复的崩溃态种子；预期投影为「原会话 + 悬挂行」）。
 *
 * 纪律：
 * - 原会话终态经幂等 session.resume 快照冻结（messages = 全量内存历史，非重放产物）；
 * - events.jsonl 原字节归档不改写（checkpoint.pos 字节偏移不变量）；
 * - 归档前独立验证（replay-lane-lib 断言集）+ 凭据扫描 fail-closed（04 §5.3）。
 */
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentServiceNode } from "../packages/server/src/index.ts";
import type { AgentServiceNode } from "../packages/server/src/index.ts";
import { createInMemoryTransportPair, createRpcClient } from "../packages/rpc/src/index.ts";
import type { RpcClient } from "../packages/rpc/src/index.ts";
import { computeWorkspaceHash, sessionPaths, serializeLine, parseLine } from "../packages/storage/src/index.ts";
import {
  REPLAY_FIXTURE_ROOT,
  assertCredentialFree,
  loadExpected,
  verifyFixtureStandalone,
} from "../packages/storage/test/replay-lane-lib.ts";
import type { ReplayFixtureExpected } from "../packages/storage/test/replay-lane-lib.ts";
import { beginTurn, startMockLlmServer, textScript, waitFor, withTimeout, writeCallScript } from "./p0-lib.mts";
import type { SseScript } from "./p0-lib.mts";
import type { SessionCreateResult, SessionResumeResult } from "../packages/shared/src/index.ts";

// ---------------------------------------------------------------------------
// 场景装配：临时 RAINCODE_HOME + workspace + 真实节点 + RPC 客户端（smoke-compact 同型）
// ---------------------------------------------------------------------------

interface Scenario {
  home: string;
  workspace: string;
  sessionId: string;
  client: RpcClient;
  node: AgentServiceNode;
  setScript: (script: SseScript[]) => void;
  /** 停节点（排空落盘队列）但不删 home：crash-seed 注入与事件字节读取都依赖文件仍在。 */
  stop: () => Promise<void>;
  cleanup: () => Promise<void>;
}

async function startScenario(name: string, script: SseScript[]): Promise<Scenario> {
  const home = await mkdtemp(join(tmpdir(), `raincode-record-replay-${name}-`));
  const workspace = join(home, "ws");
  await mkdir(workspace, { recursive: true });
  const mock = await startMockLlmServer();
  mock.setScript(script);
  const transports = createInMemoryTransportPair();
  const node = await createAgentServiceNode(transports[1], {
    env: { RAINCODE_HOME: home },
    provider: {
      name: `mock-record-${name}`,
      baseURL: mock.url,
      model: "mock-model",
      apiKey: "smoke-dummy-key", // 只进 provider 配置（内存），绝不入会话流（04 §5.3）
      maxContextTokens: 200,
    },
    tools: { approval: "always-allow" },
    permission: { policy: "default-allow" },
    compaction: { keepRecentCount: 1 },
  });
  const client = createRpcClient({ transport: transports[0] });
  await client.call("system.ping", {});
  const created = (await client.call("session.create", { workspaceRoot: workspace })) as SessionCreateResult;
  return {
    home,
    workspace,
    sessionId: created.sessionId,
    client,
    node,
    setScript: mock.setScript,
    stop: async () => {
      client.close();
      await new Promise((r) => setTimeout(r, 80)); // 排空 emitPersisted fire-and-forget 队列
      await node.close();
      await transports[0].close();
      await transports[1].close();
      await mock.close();
    },
    cleanup: async () => {
      await rm(home, { recursive: true, force: true });
    },
  };
}

/** 幂等 resume 抓原会话终态（messages = 全量内存历史，session-support 幂等分支语义）。 */
async function captureProjection(scenario: Scenario): Promise<{ messages: ReplayFixtureExpected["messages"] }> {
  const resumed = (await scenario.client.call("session.resume", {
    sessionId: scenario.sessionId,
  })) as SessionResumeResult;
  return { messages: resumed.snapshot.messages };
}

async function runTurn(scenario: Scenario, text: string): Promise<void> {
  const turn = beginTurn(scenario.client, scenario.sessionId, text);
  await withTimeout(turn.done, 15000, `turn: ${text}`);
  turn.stop();
}

async function eventsFileOf(scenario: Scenario): Promise<string> {
  return sessionPaths(scenario.home, computeWorkspaceHash(scenario.workspace), scenario.sessionId).eventsFile;
}

// ---------------------------------------------------------------------------
// 四场景驱动
// ---------------------------------------------------------------------------

async function recordPlainChat(): Promise<{ events: Buffer; expected: Omit<ReplayFixtureExpected, "recordedAt"> }> {
  const scenario = await startScenario("plain-chat", [textScript("你好，我是回放 lane 的种子助手。")]);
  try {
    await runTurn(scenario, "第一轮：请介绍你自己。");
    scenario.setScript([textScript("第二轮：随时可以开始录制回放测试。")]);
    await runTurn(scenario, "第二轮：确认就绪。");
    const projection = await captureProjection(scenario);
    await scenario.stop();
    return {
      events: await readFile(await eventsFileOf(scenario)),
      expected: {
        scenario: "plain-chat",
        description: "两轮纯文本基线：message/checkpoint 行的双路重放与投影一致",
        messages: projection.messages,
      },
    };
  } finally {
    await scenario.cleanup();
  }
}

async function recordToolRoundtrip(): Promise<{ events: Buffer; expected: Omit<ReplayFixtureExpected, "recordedAt"> }> {
  const scenario = await startScenario("tool-roundtrip", []);
  try {
    scenario.setScript([
      writeCallScript("call_fixture_write", "notes/replay.txt", "回放 lane 种子内容\n第二行"),
      textScript("已写入 notes/replay.txt。"),
    ]);
    await runTurn(scenario, "请把种子内容写入 notes/replay.txt。");
    scenario.setScript([textScript("工具往返完成，回放 lane 种子会话就绪。")]);
    await runTurn(scenario, "第二轮：确认写入结果。");
    const projection = await captureProjection(scenario);
    await scenario.stop();
    return {
      events: await readFile(await eventsFileOf(scenario)),
      expected: {
        scenario: "tool-roundtrip",
        description: "真实 write 工具往返：tool_call 块 + role:\"tool\" 结果行配对重放",
        messages: projection.messages,
      },
    };
  } finally {
    await scenario.cleanup();
  }
}

async function recordCompaction(): Promise<{ events: Buffer; expected: Omit<ReplayFixtureExpected, "recordedAt"> }> {
  const scenario = await startScenario("compaction", [textScript("第一轮回复：回放 lane 压缩场景就绪。")]);
  try {
    await runTurn(scenario, "第一轮：开始对话。");
    scenario.setScript([textScript("第二轮回复：继续记录上下文。")]);
    await runTurn(scenario, "第二轮：继续对话。");
    // 手动压缩（确定性触发，免阈值时序）：摘要请求走同一 mock LLM
    scenario.setScript([{ frames: [{ choices: [{ index: 0, delta: { content: "本会话摘要：用户与助手进行了两轮问候并确认回放 lane 就绪。" } }] }], finish: "stop" }]);
    const completed: Array<{ ok: boolean; epoch: number }> = [];
    const offCompleted = scenario.client.onEvent("compact.completed", (payload) =>
      completed.push(payload as { ok: boolean; epoch: number }));
    await scenario.client.call("session.compact", { sessionId: scenario.sessionId });
    await waitFor(() => completed.length > 0, 15000, "compact.completed");
    offCompleted();
    if (!completed[0]!.ok) {
      throw new Error("manual compact 失败，录制中止");
    }
    scenario.setScript([textScript("压缩后的新一轮回复。")]);
    await runTurn(scenario, "压缩后的第三轮：继续。");
    const projection = await captureProjection(scenario);
    await scenario.stop();
    return {
      events: await readFile(await eventsFileOf(scenario)),
      expected: {
        scenario: "compaction",
        description: "手动 compact：compaction.applied 标记 + epoch 1 + 摘要替换重放 + 压缩后新轮",
        messages: projection.messages,
      },
    };
  } finally {
    await scenario.cleanup();
  }
}

async function recordCrashSeed(): Promise<{ events: Buffer; expected: Omit<ReplayFixtureExpected, "recordedAt"> }> {
  const scenario = await startScenario("crash-seed", [textScript("第一轮正常完成。")]);
  try {
    await runTurn(scenario, "第一轮：正常完成。");
    const projection = await captureProjection(scenario);
    await scenario.stop();
    // 节点关闭后文件级注入崩溃态（单写者已停，无覆写风险）：悬挂 assistant tool_call + 半行截尾
    const eventsFile = await eventsFileOf(scenario);
    const raw = await readFile(eventsFile, "utf8");
    const lastLine = raw.trimEnd().split("\n").at(-1)!;
    const parsed = parseLine(lastLine);
    if (!parsed.ok) {
      throw new Error("录制流尾行损坏，无法定 seq");
    }
    const dangling = {
      v: 1,
      type: "message" as const,
      seq: parsed.line.seq + 1,
      ts: Date.now(),
      message: {
        id: "msg_seed_dangling",
        role: "assistant" as const,
        content: [{ type: "tool_call" as const, toolCallId: "call_seed_interrupt", name: "write", arguments: { path: "interrupted.txt", content: "崩溃前未完成的写入" } }],
      },
    };
    const half = `{"v":1,"type":"message","seq":${String(parsed.line.seq + 2)},"ts":${String(Date.now())},"message":{"id":"msg_seed_half`;
    await appendFile(eventsFile, `${serializeLine(dangling)}\n${half}`, "utf8");
    return {
      events: await readFile(eventsFile),
      expected: {
        scenario: "crash-seed",
        description: "崩溃态种子：悬挂 assistant tool_call（合成恢复结果）+ 半行截尾（残尾修复前提）",
        messages: projection.messages,
        seeded: { assistantMessageId: "msg_seed_dangling", danglingToolCallId: "call_seed_interrupt", truncatedTail: true },
      },
    };
  } finally {
    await scenario.cleanup();
  }
}

// ---------------------------------------------------------------------------
// 主流程：录制 → 落盘 → 独立验证（含凭据扫描 fail-closed）
// ---------------------------------------------------------------------------

const recorders = [
  { run: recordPlainChat },
  { run: recordToolRoundtrip },
  { run: recordCompaction },
  { run: recordCrashSeed },
];

for (const recorder of recorders) {
  const { events, expected } = await recorder.run();
  assertCredentialFree(events.toString("utf8"), `recorded ${expected.scenario}`);
  const dir = join(REPLAY_FIXTURE_ROOT, expected.scenario);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "events.jsonl"), events);
  const expectedWithStamp = { ...expected, recordedAt: new Date().toISOString() } satisfies ReplayFixtureExpected;
  await writeFile(join(dir, "expected.json"), `${JSON.stringify(expectedWithStamp, null, 2)}\n`);
  await verifyFixtureStandalone(join(dir, "events.jsonl"), await loadExpected(expected.scenario));
  console.log(`recorded + verified: ${expected.scenario} (${String(events.byteLength)} bytes, ${String(expected.messages.length)} messages)`);
}
console.log(`全部 ${String(recorders.length)} 个 fixture 录制并验证通过 → ${REPLAY_FIXTURE_ROOT}`);
