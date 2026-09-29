/**
 * memory 域接入 smoke（T2.4 二阶段，02-module-design §7 / 06-api-spec §2.6）。
 * 运行：tsx scripts/smoke-memory.mts（或 pnpm run smoke:memory）
 *
 * 链路：node:http mock OpenAI SSE（主/抽取请求同源、按请求序回放 + 请求体捕获）+ 临时
 * RAINCODE_HOME/workspace → createAgentServiceNode（memory 域装配 + compaction keepRecent=1
 * 供用例 F 手动 compact）→ 断言：
 * 用例 A 模板与注入：memory.read 不存在 → exists:false + 模板骨架；session.create + 一轮对话 →
 *   模型请求体 system 含标题行与模板章节标题（04 L86 启动全文注入，02 §7.4 不存在时注入模板）。
 * 用例 B write：工作约定落盘；用户章节经协议边界 zod 先拦（04 §4.3）→ INVALID_PARAMS，
 *   域内白名单兜底（service 直调）→ MEMORY_SECTION_FORBIDDEN；mtime 冲突：RPC write 在途时
 *   脚本同步直改 MEMORY.md（模拟并发窗口）→ MEMORY_WRITE_CONFLICT（02 §7.4）。
 * 用例 C archive 抽取：会话一轮后 archive → 抽取请求（system 含「记忆抽取器」）→ 3 条
 *   source=session-end 落盘；幂等：直调 service.extractFromSession 同会话二次抽取 → []（05 §5.4）。
 * 用例 D search：FTS/LIKE 兜底/kind 过滤/无结果空数组/confidence<0.6 不入默认召回集但在
 *   entries.list（02 §7.4）。
 * 用例 E promote：条目合入「已知坑」→ memory.read 含 `- <content>`；未知 id →
 *   MEMORY_ENTRY_NOT_FOUND（06 §2.6）。
 * 用例 F compact 抽取钩子：第二会话手动 compact（阈值 0.8×8192 不误触发）→ 摘要请求 →
 *   onBeforeReplace 抽取请求 → source=compact 条目落盘（02 §7.2 抽取先于历史替换）。
 * 全程仅本机回环与临时目录：无外呼、无真实密钥（mock provider apiKey 为占位符，绝不打印）。
 */
import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcCallError, createInMemoryTransportPair, createRpcClient } from "../packages/rpc/src/index.ts";
import type { RpcClient } from "../packages/rpc/src/index.ts";
import { createAgentServiceNode } from "../packages/server/src/index.ts";
import type { AgentServiceNode } from "../packages/server/src/index.ts";
import { computeWorkspaceHash } from "../packages/storage/src/index.ts";
import { MemoryError, createProjectMemoryService } from "../packages/memory/src/index.ts";
import type { MemoryEntry, MemorySection } from "../packages/shared/src/index.ts";
import { beginTurn, startMockLlmServer, textScript, withTimeout } from "./p0-lib.mts";
import type { MockLlmServer, SseScript } from "./p0-lib.mts";

// ---------------------------------------------------------------------------
// 场景装配：临时 RAINCODE_HOME + workspace + mock LLM + memory 域装配的服务节点
// ---------------------------------------------------------------------------

interface Scenario {
  home: string;
  workspace: string;
  client: RpcClient;
  node: AgentServiceNode;
  mock: MockLlmServer;
  setScript: (script: SseScript[]) => void;
  close: () => Promise<void>;
}

/** 抽取请求应答（JSON 正文一帧交付；由 LLM 抽取端口宽容解析）。 */
function jsonReply(payload: unknown): SseScript {
  return { frames: [{ choices: [{ index: 0, delta: { content: JSON.stringify(payload) } }] }], finish: "stop" };
}

/** 用例 C 抽取素材：3 条（含一条 confidence<0.6 供用例 D 阈值断言）。 */
const EXTRACT_SESSION_END = {
  entries: [
    { kind: "decision", content: "采用 pnpm workspace 管理 monorepo", confidence: 0.9 },
    { kind: "preference", content: "回复使用中文交流", confidence: 0.8 },
    { kind: "preference", content: "回答尽量简短", confidence: 0.5 },
  ],
};

/** 用例 F compact 抽取素材。 */
const EXTRACT_COMPACT = {
  entries: [{ kind: "todo", content: "compact 抽取验证待办", confidence: 0.9 }],
};

async function startScenario(): Promise<Scenario> {
  const home = await mkdtemp(join(tmpdir(), "raincode-smoke-memory-"));
  const workspace = join(home, "ws");
  await mkdir(workspace, { recursive: true });
  const mock = await startMockLlmServer();
  const transports = createInMemoryTransportPair();
  const node = await createAgentServiceNode(transports[1], {
    env: { RAINCODE_HOME: home },
    provider: {
      name: "mock-memory",
      baseURL: mock.url,
      model: "mock-model",
      apiKey: "smoke-dummy-key",
      maxContextTokens: 8192, // 阈值 0.8×8192 远高于冒烟用量 → auto-compact 不误触发
    },
    tools: { approval: "always-allow" },
    permission: { policy: "default-allow" },
    compaction: { keepRecentCount: 1 }, // 用例 F 手动 compact 需要 cutIndex>0
    memory: { workspaceRoot: workspace },
  });
  const client = createRpcClient({ transport: transports[0] });
  await client.call("system.ping", {}); // rpc 握手（首请求必须 system.ping）
  return {
    home,
    workspace,
    client,
    node,
    mock,
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

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

/** 单轮对话收束（send → done completed）。 */
async function sendAndAwait(scenario: Scenario, sessionId: string, text: string): Promise<void> {
  const run = beginTurn(scenario.client, sessionId, text);
  await run.sendPromise;
  const done = await withTimeout(run.done, 15000, `turn: ${text}`);
  run.stop();
  assert.equal(done.outcome, "completed");
}

/** 轮询 memory.entries.list 至条目数达标（异步落盘防御性等待，不 sleep 硬等）。 */
async function pollEntries(scenario: Scenario, filter: { source?: string; kind?: string }, minCount: number): Promise<MemoryEntry[]> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const res = (await scenario.client.call("memory.entries.list", { ...filter })) as { items: MemoryEntry[] };
    if (res.items.length >= minCount) {
      return res.items;
    }
    if (Date.now() > deadline) {
      throw new Error(`timeout waiting ${String(minCount)} entries (filter: ${JSON.stringify(filter)})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A：模板与注入（memory.read 模板骨架 + session.create 后 system 注入生效）。 */
async function caseTemplateAndInjection(scenario: Scenario): Promise<string> {
  const { client } = scenario;
  const read = (await client.call("memory.read", { workspaceRoot: scenario.workspace })) as { content: string; exists: boolean };
  assert.equal(read.exists, false, "MEMORY.md 未创建 → exists:false");
  assert.ok(read.content.includes("## 项目概览"), "模板骨架含章节标题（02 §7.3）");

  scenario.setScript([textScript("A 收到")]);
  const sessionId = ((await client.call("session.create", {
    workspaceRoot: scenario.workspace,
    title: "memory-smoke",
  })) as { sessionId: string }).sessionId;
  const bodiesStart = scenario.mock.bodies.length;
  await sendAndAwait(scenario, sessionId, "A 第一问");
  const body = scenario.mock.bodies[bodiesStart];
  assert.ok(body !== undefined, "应捕获模型请求体");
  const system = body.messages.find((m) => m.role === "system");
  assert.ok(system !== undefined && typeof system.content === "string", "system 消息存在（04 L86 全文注入）");
  assert.ok(system.content.includes("# 项目记忆（MEMORY.md"), "注入含标题行");
  assert.ok(system.content.includes("## 项目概览"), "不存在时注入模板骨架空章节说明（02 §7.4）");
  console.log("case A: 模板与注入（exists:false + 模板骨架进 system 提示）OK");
  return sessionId;
}

/** B：write（Agent 章节落盘 / 用户章节越界 / mtime 并发冲突）。 */
async function caseWrite(scenario: Scenario): Promise<void> {
  const { client, workspace } = scenario;
  const updated = (await client.call("memory.write", {
    workspaceRoot: workspace,
    section: "工作约定",
    content: "提交信息使用中文",
  })) as { updated: boolean };
  assert.equal(updated.updated, true);
  const read = (await client.call("memory.read", { workspaceRoot: workspace })) as { content: string; exists: boolean };
  assert.equal(read.exists, true);
  assert.ok(read.content.includes("提交信息使用中文"), "工作约定章节已落盘");

  // 用户章节「项目概览」：协议边界 zod 单点校验先拦（04 §4.3）→ INVALID_PARAMS
  await assert.rejects(
    client.call("memory.write", { workspaceRoot: workspace, section: "项目概览", content: "越界" }),
    (err: unknown) => err instanceof RpcCallError && err.code === "INVALID_PARAMS",
  );
  // 域内白名单兜底（schema 之后的第二道防线）：service 直调 → MEMORY_SECTION_FORBIDDEN（02 §7.1）
  const svc = createProjectMemoryService({
    storage: scenario.node.storage,
    extractPort: { extract: async () => null },
  });
  await assert.rejects(
    svc.writeAgentSection(workspace, "项目概览" as MemorySection, "越界"),
    (err: unknown) => err instanceof MemoryError && err.code === "MEMORY_SECTION_FORBIDDEN",
  );

  // mtime 冲突（02 §7.4）：handler 的「记 mtime(S1) → 提交前复检(S2)」两步 stat 之间若观测到
  // 外部修改即 MEMORY_WRITE_CONFLICT。真实窗口 <1ms，外部写以「在途期间 setImmediate 逐轮持续直写」
  // 尽量覆盖 handler 的 await 间隙（每轮直至 promise 收敛，10 轮重放直至命中）；残余时序敏感性见
  // PROGRESS §4——确定性方案（prod 注入 stat 钩子）随 T3.3 记忆波次落地。ESM 静态导入绑定原函数，
  // 进程内事后 patch fs.promises.stat 不可行（实测不传播），故不改走 spy 路线。
  const memPath = join(workspace, ".raincode", "MEMORY.md");
  let conflicted = false;
  for (let round = 0; round < 10 && !conflicted; round += 1) {
    const base = await readFile(memPath, "utf8");
    const pending = client
      .call("memory.write", { workspaceRoot: workspace, section: "工作约定", content: `并发探测 ${String(round)}` })
      .catch((reason: unknown) => reason);
    const writer = setInterval(() => {
      appendFileSync(memPath, `<!-- 外部并发修改 ${String(round)}.${String(Date.now())} -->\n`, "utf8");
    }, 0);
    const outcome = await pending;
    clearInterval(writer);
    if (outcome instanceof RpcCallError) {
      assert.equal(outcome.code, "MEMORY_WRITE_CONFLICT", `并发窗口应报写冲突，实得 ${outcome.code}`);
      conflicted = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20)); // 轮间让步，隔离下一轮首读
  }
  assert.ok(conflicted, "并发修改窗口内应触发 MEMORY_WRITE_CONFLICT（02 §7.4）");
  console.log("case B: write（工作约定落盘 / 用户章节越界拦截 / mtime 冲突放弃）OK");
}

/** C：archive 抽取（source=session-end 落盘 + 幂等键二次抽取返回空）。 */
async function caseArchiveExtraction(scenario: Scenario, sessionId: string): Promise<{ decisionId: string; preferenceHighId: string; preferenceLowId: string }> {
  const { client, mock } = scenario;
  mock.setScript([textScript("C 归档前回复"), jsonReply(EXTRACT_SESSION_END)]);
  await sendAndAwait(scenario, sessionId, "C 讨论了 monorepo 方案与中文偏好");
  await client.call("session.archive", { sessionId }); // archive 内联抽取（应答前完成落盘）

  // 抽取请求经同一 mock（同会话模型一次调用，02 §7.2）：system 含「记忆抽取器」
  const extractBody = mock.bodies.find((b) =>
    b.messages.some((m) => m.role === "system" && typeof m.content === "string" && m.content.includes("记忆抽取器")),
  );
  assert.ok(extractBody !== undefined, "应发出 LLM 抽取请求");

  const items = await pollEntries(scenario, { source: "session-end" }, 3);
  assert.equal(items.length, 3, `session-end 条目 3 条，实得 ${String(items.length)}`);
  const workspaceId = computeWorkspaceHash(scenario.workspace);
  const decision = items.find((e) => e.kind === "decision");
  const preferences = items.filter((e) => e.kind === "preference");
  assert.ok(decision !== undefined && preferences.length === 2, "kind 投影正确");
  for (const entry of items) {
    assert.equal(entry.workspaceId, workspaceId, "条目归属当前 workspace（跨项目不串味）");
    assert.equal(entry.source, "session-end");
  }
  const high = preferences.find((e) => e.confidence >= 0.6);
  const low = preferences.find((e) => e.confidence < 0.6);
  assert.ok(decision !== undefined && high !== undefined && low !== undefined, "confidence 投影正确");
  assert.ok(decision.content.includes("pnpm workspace"), "decision 内容落盘");
  assert.ok(high!.content.includes("中文"), "高置信 preference 落盘");
  assert.ok(low!.content.includes("简短"), "低置信 preference 仍落盘（仅召回隔离）");

  // 幂等（05 §5.4 末行 settings 键）：同会话二次抽取 → []，且不触发抽取端口
  const svc = createProjectMemoryService({
    storage: scenario.node.storage,
    extractPort: { extract: async () => { throw new Error("幂等命中时不应调用抽取端口"); } },
  });
  const second = await svc.extractFromSession({
    sessionId,
    workspaceId,
    transcript: [],
    source: "session-end",
  });
  assert.deepEqual(second, []);
  console.log("case C: archive 抽取（session-end 3 条落盘 + settings 幂等键）OK");
  return { decisionId: decision!.id, preferenceHighId: high!.id, preferenceLowId: low!.id };
}

/** D：search（FTS / LIKE 兜底 / kind 过滤 / 召回阈值隔离 / 无结果空数组）。 */
async function caseSearch(scenario: Scenario, ids: { decisionId: string; preferenceHighId: string; preferenceLowId: string }): Promise<void> {
  const { client } = scenario;
  const search = async (query: string, kind?: string): Promise<MemoryEntry[]> => {
    const res = (await client.call("memory.search", { query, ...(kind !== undefined && { kind }) })) as { entries: MemoryEntry[] };
    return res.entries;
  };

  const fts = await search("pnpm workspace"); // ≥3 字 → FTS trigram phrase
  assert.ok(fts.some((e) => e.id === ids.decisionId), "FTS 命中 decision 条目");
  const like = await search("中"); // <3 字 → LIKE 兜底
  assert.ok(like.some((e) => e.id === ids.preferenceHighId), "LIKE 兜底命中高置信 preference");
  assert.equal((await search("pnpm workspace", "preference")).length, 0, "kind 过滤排除 decision");
  assert.ok((await search("pnpm workspace", "decision")).some((e) => e.id === ids.decisionId), "kind 过滤放行 decision");
  assert.deepEqual(await search("zzz 不存在的检索词"), [], "无结果返回空数组（02 §7.4）");
  assert.deepEqual(await search("简短"), [], "confidence<0.6 不入默认召回集（02 §7.4 幻觉防线）");

  // 管理视图不过滤 confidence：0.5 条目仅在 entries.list 可见
  const list = (await client.call("memory.entries.list", {})) as { items: MemoryEntry[] };
  assert.ok(list.items.some((e) => e.id === ids.preferenceLowId), "0.5 条目在 entries.list");
  console.log("case D: search（FTS/LIKE/kind 过滤/召回阈值隔离/无结果空数组）OK");
}

/** E：promote（条目合入 MEMORY.md 指定章节 + 未知 id NOT_FOUND）。 */
async function casePromote(scenario: Scenario, decisionId: string): Promise<void> {
  const { client, workspace } = scenario;
  const promoted = (await client.call("memory.promote", { entryId: decisionId, section: "已知坑" })) as { promoted: boolean };
  assert.equal(promoted.promoted, true);
  const read = (await client.call("memory.read", { workspaceRoot: workspace })) as { content: string };
  assert.ok(read.content.includes("## 已知坑"), "已知坑章节存在");
  assert.ok(read.content.includes("- 采用 pnpm workspace 管理 monorepo"), "promote 追加 `- <content>`（05 §5.1）");
  await assert.rejects(
    client.call("memory.promote", { entryId: "mem_missing", section: "已知坑" }),
    (err: unknown) => err instanceof RpcCallError && err.code === "MEMORY_ENTRY_NOT_FOUND",
  );
  console.log("case E: promote（合入已知坑 + MEMORY_ENTRY_NOT_FOUND）OK");
}

/** F：compact 抽取钩子（onBeforeReplace 先于历史替换，source=compact 落盘）。 */
async function caseCompactExtraction(scenario: Scenario): Promise<void> {
  const { client, mock, workspace } = scenario;
  mock.setScript([
    textScript("F 第一回合"),
    textScript("F 第二回合"),
    textScript("压缩摘要：早期上下文被本摘要替换"), // 摘要请求（compaction summarize）
    jsonReply(EXTRACT_COMPACT), // onBeforeReplace 抽取请求（02 §7.2）
  ]);
  const sessionId = ((await client.call("session.create", {
    workspaceRoot: workspace,
    title: "memory-compact",
  })) as { sessionId: string }).sessionId;
  await sendAndAwait(scenario, sessionId, "F 第一问");
  await sendAndAwait(scenario, sessionId, "F 第二问");

  const ticket = (await client.call("session.compact", { sessionId })) as { compactionId: string; alreadyRunning: boolean };
  assert.equal(ticket.alreadyRunning, false, "手动 compact 受理即返");

  const items = await pollEntries(scenario, { source: "compact" }, 1);
  const todo = items.find((e) => e.content.includes("compact 抽取验证待办"));
  assert.ok(todo !== undefined, "compact 抽取条目落盘");
  assert.equal(todo.kind, "todo");
  assert.equal(todo.source, "compact");
  console.log("case F: compact 抽取钩子（抽取先于历史替换，source=compact 落盘）OK");
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const scenario = await startScenario();
  try {
    const sessionId = await caseTemplateAndInjection(scenario);
    await caseWrite(scenario);
    const ids = await caseArchiveExtraction(scenario, sessionId);
    await caseSearch(scenario, ids);
    await casePromote(scenario, ids.decisionId);
    await caseCompactExtraction(scenario);
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
