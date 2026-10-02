/**
 * 子代理接入 smoke（T2.3 二阶段，02-module-design §4 / 06-api-spec §2.5）。
 * 运行：tsx scripts/smoke-subagent.mts（或 pnpm run smoke:subagent）
 *
 * 链路：node:http mock OpenAI SSE（主/子请求同源、按请求序回放）+ 临时 RAINCODE_HOME 双层 profile
 * 目录（global <home>/agents + workspace <ws>/.raincode/agents）→ createAgentServiceNode（subagent 域
 * 装配）→ 断言：
 * 用例 A 完成链路：主 turn 模型发 agent 工具调用 → 子会话（researcher profile）收束 → 完成通知经
 *   工具结果回传主循环 → 主 turn 纯文本收束；subagent.list 投影正确。
 * 用例 B 事件镜像：subagent.spawned → progress(started) → progress(done) → completed 时序与字段。
 * 用例 C profiles.list：workspace/global 双源投影 + tools/maxTurns 字段（解析失败跳过）。
 * 用例 D 校验错误：SUBAGENT_PROFILE_NOT_FOUND / SUBAGENT_PROFILE_INVALID / SESSION_NOT_FOUND /
 *   SUBAGENT_NOT_FOUND；inline 非法字段经协议边界 zod 单点校验（04 §4.3）先拦 → INVALID_PARAMS。
 * 用例 E stop 幂等：终态句柄 stop → stopped:false 不抛（06 §2.5）。
 * 用例 F 排队（受理即返）：直调 spawn 5 个（默认并发 4）→ 第 5 个受理即 Pending + queuePosition=1
 *   → spawned 事件恰 1 个 Pending → 槽位释放 FIFO 补位后 5 个全部 Completed。
 * 用例 G 内置角色模板（T3.6）：tester 无用户文件 → builtin 兜底 spawn 可收束；profiles.list
 *   含 source:"builtin" 项且用户同名遮蔽（case C）。
 * 用例 H 并行编排汇聚（T3.6 验收）：同轮两个 agent tool_call → 子代理并发执行（请求到达间隔
 *   < 300ms，串行基线 ≥400ms）→ 双完成通知合并回主循环。
 * 全程仅本机回环与临时目录：无外呼、无真实密钥（mock provider apiKey 为占位符，绝不打印）。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemoryTransportPair, createRpcClient, RpcCallError } from "../packages/rpc/src/index.ts";
import type { RpcClient } from "../packages/rpc/src/index.ts";
import { createAgentServiceNode } from "../packages/server/src/index.ts";
import type { AgentServiceNode } from "../packages/server/src/index.ts";
import type {
  DoneEventPayload,
  SessionCreateResult,
  SessionSendResult,
  SubagentCompletedEventPayload,
  SubagentListResult,
  SubagentProfilesListResult,
  SubagentProgressEventPayload,
  SubagentSpawnResult,
  SubagentSpawnedEventPayload,
  SubagentStopResult,
  ToolCallCompletedEventPayload,
} from "../packages/shared/src/index.ts";
import { beginTurn, startMockLlmServer, textScript, toolCallFrame, waitFor, withTimeout } from "./p0-lib.mts";
import type { MockLlmServer, SseScript } from "./p0-lib.mts";

// ---------------------------------------------------------------------------
// 场景装配：临时 RAINCODE_HOME + 双层 profile 目录 + in-memory 服务节点 + RPC 客户端
// ---------------------------------------------------------------------------

type TimelineEntry = { name: string; payload: SubagentSpawnedEventPayload | SubagentProgressEventPayload | SubagentCompletedEventPayload };

interface Scenario {
  home: string;
  workspace: string;
  client: RpcClient;
  node: AgentServiceNode;
  mock: MockLlmServer;
  /** subagent.* 事件时间线（到达序；in-memory transport 同进程 FIFO）。 */
  timeline: TimelineEntry[];
  setScript: (script: SseScript[]) => void;
  close: () => Promise<void>;
}

const RESEARCHER_MD = [
  "---",
  "name: researcher",
  "description: 上下文隔离的调研子代理（工具限 read/grep）",
  "tools: [read, grep]",
  "maxTurns: 8",
  "---",
  "",
  "你是研究员。收到任务后直接给出调研结论，不要使用任何工具。",
  "",
].join("\n");

const WRITER_MD = [
  "---",
  "name: writer",
  "description: 文稿整理子代理（继承主会话工具集，maxTurns 缺省）",
  "---",
  "",
  "你是写手。直接输出整理后的文稿。",
  "",
].join("\n");

/** 非法 profile（缺 description）——用例 D 的 SUBAGENT_PROFILE_INVALID 数据源。 */
const BAD_MD = ["---", "name: bad", "maxTurns: 4", "---", "", "缺少 description 的非法 profile。", ""].join("\n");

async function startScenario(): Promise<Scenario> {
  const home = await mkdtemp(join(tmpdir(), "raincode-smoke-subagent-"));
  const workspace = join(home, "ws");
  await mkdir(join(home, "agents"), { recursive: true });
  await mkdir(join(workspace, ".raincode", "agents"), { recursive: true });
  await writeFile(join(home, "agents", "researcher.md"), RESEARCHER_MD, "utf8"); // global 源
  await writeFile(join(workspace, ".raincode", "agents", "writer.md"), WRITER_MD, "utf8"); // workspace 源
  const mock = await startMockLlmServer();
  const transports = createInMemoryTransportPair();
  const node = await createAgentServiceNode(transports[1], {
    env: { RAINCODE_HOME: home },
    provider: {
      name: "mock-subagent",
      baseURL: mock.url,
      model: "mock-model",
      apiKey: "smoke-dummy-key",
      maxContextTokens: 8192,
    },
    tools: { approval: "always-allow" },
    permission: { policy: "default-allow" },
    subagent: { workspaceRoot: workspace },
  });
  const client = createRpcClient({ transport: transports[0] });
  await client.call("system.ping", {});
  const timeline: TimelineEntry[] = [];
  const offSpawned = client.onEvent("subagent.spawned", (payload) => timeline.push({ name: "subagent.spawned", payload: payload as SubagentSpawnedEventPayload }));
  const offProgress = client.onEvent("subagent.progress", (payload) => timeline.push({ name: "subagent.progress", payload: payload as SubagentProgressEventPayload }));
  const offCompleted = client.onEvent("subagent.completed", (payload) => timeline.push({ name: "subagent.completed", payload: payload as SubagentCompletedEventPayload }));
  return {
    home,
    workspace,
    client,
    node,
    mock,
    timeline,
    setScript: mock.setScript,
    close: async () => {
      offSpawned();
      offProgress();
      offCompleted();
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

/** A+B：主 turn 模型 agent 工具派发 → 子会话收束 → 完成通知回传 → 事件镜像时序。 */
async function caseCompleteAndMirror(scenario: Scenario): Promise<void> {
  const { client, timeline } = scenario;
  // 请求序：主1（agent 工具调用）→ 子（文本收束）→ 主2（纯文本收束）；主/子经同一 mock（同 provider）
  scenario.setScript([
    {
      frames: [
        { choices: [{ index: 0, delta: { role: "assistant", content: "" } }] },
        toolCallFrame("call_agent_1", "agent", { profile: "researcher", task: "调研 X" }),
        { choices: [], usage: { prompt_tokens: 30, completion_tokens: 10 } },
      ],
      finish: "tool_calls",
    },
    textScript("调研结论：OK"),
    textScript("主任务收束：子代理调研结论已回传"),
  ]);
  const sessionId = ((await client.call("session.create", {
    workspaceRoot: scenario.workspace,
    title: "subagent-smoke",
  })) as SessionCreateResult).sessionId;
  const run = beginTurn(client, sessionId, "派发子代理调研 X");
  const admission = (await run.sendPromise) as SessionSendResult;
  assert.equal(admission.admission, "started");
  const done = (await withTimeout(run.done, 20000, "model turn done")) as DoneEventPayload;
  run.stop();
  assert.equal(done.outcome, "completed");

  // A：agent 工具结果（完成通知）回传主循环
  const agentCompleted: ToolCallCompletedEventPayload | undefined = run.toolCompleted.find((event) =>
    event.contentPreview?.includes("调研结论：OK"),
  );
  assert.ok(agentCompleted !== undefined, `agent 工具结果回传（${JSON.stringify(run.toolCompleted)}）`);
  assert.equal(agentCompleted.isError, false);
  // A：subagent.list 投影
  const list = (await client.call("subagent.list", { sessionId })) as SubagentListResult;
  assert.equal(list.items.length, 1);
  const info = list.items[0]!;
  assert.equal(info.status, "Completed");
  assert.ok(info.turnsUsed >= 1, `turnsUsed ≥ 1（实际 ${String(info.turnsUsed)}）`);
  assert.ok(info.usage !== undefined, "usage 字段存在");
  assert.equal(info.usage.inputTokens, 20);
  assert.equal(info.usage.outputTokens, 8);
  console.log("case A: 完成链路（agent 工具派发 → 子会话收束 → 完成通知回传）OK");

  // B：镜像事件时序与字段（按 A 的 subagentId 过滤）
  const sid = info.id;
  const flow = timeline.filter((entry) => entry.payload.subagentId === sid).map((entry) => entry.name);
  assert.deepEqual(flow, ["subagent.spawned", "subagent.progress", "subagent.progress", "subagent.completed"]);
  const spawnedPayload = timeline.find((entry) => entry.name === "subagent.spawned" && entry.payload.subagentId === sid)!
    .payload as SubagentSpawnedEventPayload;
  assert.equal(spawnedPayload.profileName, "researcher");
  assert.equal(spawnedPayload.status, "Running");
  assert.ok(spawnedPayload.taskPreview.includes("调研 X"));
  const progressStages = timeline
    .filter((entry) => entry.name === "subagent.progress" && entry.payload.subagentId === sid)
    .map((entry) => (entry.payload as SubagentProgressEventPayload).stage);
  assert.deepEqual(progressStages, ["started", "done"]);
  const completedPayload = timeline.find((entry) => entry.name === "subagent.completed" && entry.payload.subagentId === sid)!
    .payload as SubagentCompletedEventPayload;
  assert.equal(completedPayload.status, "Completed");
  assert.ok(completedPayload.summary.includes("调研结论：OK"));
  console.log("case B: 事件镜像（spawned → started → done → completed）OK");
}

/** C：profiles.list 双源投影 + 内置角色模板（T3.6：用户同名遮蔽 builtin）。 */
async function caseProfilesList(scenario: Scenario): Promise<void> {
  const { profiles } = (await scenario.client.call("subagent.profiles.list", {})) as SubagentProfilesListResult;
  // researcher（global 用户定义遮蔽同名内置）+ writer（workspace）+ reviewer/tester（builtin 兜底）
  assert.equal(profiles.length, 4, `researcher+writer+reviewer+tester 在列、bad.md 解析失败跳过（实际 ${JSON.stringify(profiles)}）`);
  const researcher = profiles.find((profile) => profile.name === "researcher");
  assert.ok(researcher !== undefined, "researcher 在列");
  assert.equal(researcher.source, "global");
  assert.deepEqual(researcher.tools, ["read", "grep"]);
  assert.equal(researcher.maxTurns, 8);
  const writer = profiles.find((profile) => profile.name === "writer");
  assert.ok(writer !== undefined, "writer 在列");
  assert.equal(writer.source, "workspace");
  assert.equal(writer.tools, undefined); // 缺省继承主会话全集
  assert.equal(writer.maxTurns, 20); // 缺省 20
  // T3.6 内置角色模板：用户未定义的名字以 source:"builtin" 兜底在列
  for (const name of ["reviewer", "tester"]) {
    const builtin = profiles.find((profile) => profile.name === name);
    assert.ok(builtin !== undefined, `内置角色 ${name} 在列`);
    assert.equal(builtin.source, "builtin", `内置角色 ${name} source=builtin`);
    assert.ok(builtin.maxTurns !== undefined && builtin.maxTurns >= 1, "内置模板 maxTurns 给定");
  }
  console.log("case C: profiles.list（双源投影 + builtin 兜底 + 用户同名遮蔽）OK");
}

/** D：校验错误码。 */
async function caseValidationErrors(scenario: Scenario): Promise<void> {
  const { client } = scenario;
  const sessionId = ((await client.call("session.create", { workspaceRoot: scenario.workspace })) as SessionCreateResult)
    .sessionId;
  // 非法 profile 仅在用例 D 期间落盘：agent 工具 description 每次列工具都会扫描目录，
  // 常驻坏文件会让其他用例每次模型轮次都产出解析诊断（噪声）
  const badPath = join(scenario.home, "agents", "bad.md");
  await writeFile(badPath, BAD_MD, "utf8");
  try {
    const rejects = async (method: string, params: unknown, code: string): Promise<void> => {
      await assert.rejects(client.call(method, params), (err: unknown) => {
        assert.ok(err instanceof RpcCallError, `${method} 应抛 RpcCallError`);
        assert.equal(err.code, code);
        return true;
      });
    };
    await rejects("subagent.spawn", { sessionId, profile: "no-such-profile", task: "x" }, "SUBAGENT_PROFILE_NOT_FOUND");
    await rejects("subagent.spawn", { sessionId, profile: "bad", task: "x" }, "SUBAGENT_PROFILE_INVALID");
    // inline 非法字段（name 大写）：协议边界 zod 单点校验先拦（04 §4.3）→ INVALID_PARAMS；
    // 域码 SUBAGENT_PROFILE_INVALID 在协议路径仅可由文件 profile 触发（上一行已覆盖）
    await rejects(
      "subagent.spawn",
      { sessionId, profile: { name: "Researcher", description: "x" }, task: "x" },
      "INVALID_PARAMS",
    );
    await rejects("subagent.spawn", { sessionId: "session_missing", profile: "researcher", task: "x" }, "SESSION_NOT_FOUND");
    await rejects("subagent.stop", { subagentId: "sub_missing" }, "SUBAGENT_NOT_FOUND");
  } finally {
    await rm(badPath, { force: true });
  }
  console.log("case D: 校验错误（NOT_FOUND/INVALID/SESSION_NOT_FOUND/SUBAGENT_NOT_FOUND）OK");
}

/** E：stop 幂等（06 §2.5：终态句柄 stopped:false 不抛）。 */
async function caseStopIdempotent(scenario: Scenario): Promise<void> {
  const list = (await scenario.client.call("subagent.list", {})) as SubagentListResult;
  const completed = list.items.find((item) => item.status === "Completed");
  assert.ok(completed !== undefined, "存在终态子代理");
  const stop = (await scenario.client.call("subagent.stop", { subagentId: completed.id })) as SubagentStopResult;
  assert.equal(stop.stopped, false);
  assert.equal(stop.status, "Completed");
  console.log("case E: stop 幂等（终态 stopped:false 不抛）OK");
}

/** F：排队（受理即返，02 §4.2 S1/S6）：并发 4 + 第 5 个 Pending → 槽位释放 FIFO 补位后全部完成。 */
async function caseQueueing(scenario: Scenario): Promise<void> {
  const { client, timeline } = scenario;
  // 5 个子代理各消费 1 个子请求（250ms 延迟保证 spawn 窗口内 4 槽位全忙）；脚本耗尽后按末项回放
  scenario.setScript(Array.from({ length: 5 }, () => textScript("子任务收束：完成", 250)));
  const fSession = ((await client.call("session.create", {
    workspaceRoot: scenario.workspace,
    title: "queue-smoke",
  })) as SessionCreateResult).sessionId;
  const marker = timeline.length;
  const spawned: SubagentSpawnResult[] = [];
  for (let i = 0; i < 5; i += 1) {
    spawned.push(
      (await client.call("subagent.spawn", { sessionId: fSession, profile: "researcher", task: `批量任务 ${String(i)}` })) as SubagentSpawnResult,
    );
  }
  for (let i = 0; i < 4; i += 1) {
    assert.equal(spawned[i]!.status, "Running", `第 ${String(i + 1)} 个受理即 Running`);
  }
  assert.equal(spawned[4]!.status, "Pending", "第 5 个受理即 Pending");
  assert.equal(spawned[4]!.queuePosition, 1, "排队位次 1");

  // spawned 镜像事件：恰 1 个 Pending（事件在受理时同步派发，状态为受理时点快照）
  await waitFor(
    () => timeline.slice(marker).filter((entry) => entry.name === "subagent.spawned").length >= 5,
    10000,
    "5 条 spawned 事件",
  );
  const fSpawned = timeline
    .slice(marker)
    .filter((entry) => entry.name === "subagent.spawned")
    .map((entry) => entry.payload as SubagentSpawnedEventPayload);
  assert.equal(fSpawned.filter((payload) => payload.status === "Pending").length, 1);
  assert.equal(fSpawned.find((payload) => payload.status === "Pending")?.queuePosition, 1);

  // 槽位释放 FIFO 补位：5 个全部自然完成（无 stop 中断，规避在途请求 abort）
  const fIds = new Set(spawned.map((result) => result.subagentId));
  await waitFor(() => {
    const completed = timeline
      .slice(marker)
      .filter((entry) => entry.name === "subagent.completed")
      .map((entry) => entry.payload as SubagentCompletedEventPayload);
    return completed.filter((payload) => payload.status === "Completed" && fIds.has(payload.subagentId)).length === 5;
  }, 20000, "5 个排队子代理完成");
  const fList = (await client.call("subagent.list", { sessionId: fSession })) as SubagentListResult;
  assert.equal(fList.items.length, 5);
  assert.ok(fList.items.every((item) => item.status === "Completed"), "排队补位后全部 Completed");
  console.log("case F: 排队（并发 4 + 第 5 个 Pending/queuePosition=1 + FIFO 补位）OK");
}

/** G：内置角色模板 spawn（T3.6）：tester 无用户文件 → 内置兜底可派发可收束。 */
async function caseBuiltinRoleSpawn(scenario: Scenario): Promise<void> {
  const { client, timeline } = scenario;
  scenario.setScript([textScript("测试结论：全部通过")]);
  const sessionId = ((await client.call("session.create", {
    workspaceRoot: scenario.workspace,
    title: "builtin-role",
  })) as SessionCreateResult).sessionId;
  const marker = timeline.length;
  const spawned = (await client.call("subagent.spawn", {
    sessionId,
    profile: "tester", // 目录未命中（global 只有 researcher；workspace 只有 writer）→ 内置角色兜底
    task: "运行测试套件",
  })) as SubagentSpawnResult;
  assert.equal(spawned.status, "Running");
  await waitFor(
    () =>
      timeline
        .slice(marker)
        .some((entry) => entry.name === "subagent.completed" && (entry.payload as SubagentCompletedEventPayload).status === "Completed"),
    20000,
    "内置角色子代理完成",
  );
  const spawnedPayload = timeline
    .slice(marker)
    .find((entry) => entry.name === "subagent.spawned")!.payload as SubagentSpawnedEventPayload;
  assert.equal(spawnedPayload.profileName, "tester", "内置角色名派发");
  const completedPayload = timeline
    .slice(marker)
    .find((entry) => entry.name === "subagent.completed")!.payload as SubagentCompletedEventPayload;
  assert.ok(completedPayload.summary.includes("测试结论：全部通过"));
  console.log("case G: 内置角色模板 spawn（tester 目录未命中 → builtin 兜底可运行）OK");
}

/** H：并行编排汇聚（T3.6 验收用例）：同轮两个 agent tool_call → 子代理并发执行 → 双完成通知合并回主循环。 */
async function caseParallelFanOut(scenario: Scenario): Promise<void> {
  const { client, mock } = scenario;
  // main1（同轮两个 agent 调用，index 0/1）→ 两个子请求（各 400ms 延迟）→ main2 汇总收束
  scenario.setScript([
    {
      frames: [
        { choices: [{ index: 0, delta: { role: "assistant", content: "" } }] },
        toolCallFrame("call_agent_p1", "agent", { profile: "researcher", task: "调研 A" }, 0),
        toolCallFrame("call_agent_p2", "agent", { profile: "writer", task: "撰写 B" }, 1),
        { choices: [], usage: { prompt_tokens: 30, completion_tokens: 10 } },
      ],
      finish: "tool_calls",
    },
    textScript("子结论A：并行", 400),
    textScript("子结论B：并行", 400),
    textScript("汇总：两路子代理结论已合并"),
  ]);
  const sessionId = ((await client.call("session.create", {
    workspaceRoot: scenario.workspace,
    title: "parallel-fanout",
  })) as SessionCreateResult).sessionId;
  const run = beginTurn(client, sessionId, "并行派发两个子任务");
  const admission = (await run.sendPromise) as SessionSendResult;
  assert.equal(admission.admission, "started");
  const done = (await withTimeout(run.done, 30000, "parallel fan-out turn done")) as DoneEventPayload;
  run.stop();
  assert.equal(done.outcome, "completed");

  // 汇聚：两个 agent 工具结果（完成通知）均回传主循环，各自携带子结论
  const agentResults = run.toolCompleted.filter((event) => event.contentPreview?.includes("子结论"));
  assert.equal(
    agentResults.length,
    2,
    `两个完成通知合并回主循环（实际 ${JSON.stringify(run.toolCompleted.map((e) => e.contentPreview))}）`,
  );
  assert.ok(agentResults.some((e) => e.contentPreview?.includes("子结论A")));
  assert.ok(agentResults.some((e) => e.contentPreview?.includes("子结论B")));

  // 并发：两个子代理的 LLM 请求到达间隔 < 300ms（串行执行因 400ms 响应延迟必然 ≥400ms）
  const subRequestGap = Math.abs(mock.bodyTimes[2]! - mock.bodyTimes[1]!);
  assert.ok(
    subRequestGap < 300,
    `子代理请求并发到达（间隔 ${subRequestGap.toFixed(0)}ms < 300ms；串行基线 ≥400ms）`,
  );
  console.log(`case H: 并行编排汇聚（同轮双派发并发执行，请求间隔 ${subRequestGap.toFixed(0)}ms，双结果合并）OK`);
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const scenario = await startScenario();
  try {
    await caseCompleteAndMirror(scenario);
    await caseProfilesList(scenario);
    await caseValidationErrors(scenario);
    await caseStopIdempotent(scenario);
    await caseQueueing(scenario);
    await caseBuiltinRoleSpawn(scenario);
    await caseParallelFanOut(scenario);
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
