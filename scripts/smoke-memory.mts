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
 *   域内白名单兜底（service 直调）→ MEMORY_SECTION_FORBIDDEN；mtime 冲突：经 SectionEditHooks
 *   .onBeforeRecheck 注入缝（prod 依赖注入选项）在 S2 复检前确定性直改 MEMORY.md →
 *   MEMORY_WRITE_CONFLICT（02 §7.4；取代旧 setImmediate 竞速法，残余时序敏感性收口）。
 * 用例 C archive 抽取：会话一轮后 archive → 抽取请求（system 含「记忆抽取器」）→ 3 条
 *   source=session-end 落盘；幂等：直调 service.extractFromSession 同会话二次抽取 → []（05 §5.4）。
 * 用例 D search：FTS/LIKE 兜底/kind 过滤/无结果空数组/confidence<0.6 不入默认召回集但在
 *   entries.list（02 §7.4）。
 * 用例 E promote：条目合入「已知坑」→ memory.read 含 `- <content>`；未知 id →
 *   MEMORY_ENTRY_NOT_FOUND（06 §2.6）。
 * 用例 F compact 抽取钩子：第二会话手动 compact（阈值 0.8×8192 不误触发）→ 摘要请求 →
 *   onBeforeReplace 抽取请求 → source=compact 条目落盘（02 §7.2 抽取先于历史替换）。
 * 用例 G 晋升草案待确认区（02 §7.2 第三层，协议 v1.7 memory.drafts.*）：抽取高置信（≥0.8）
 *   新条目自动生成草案（todo / 低置信排除）；case E 直接管晋升已收敛 decision 草案为 confirmed；
 *   confirm 合入 MEMORY.md（章节预填）→ 终态不可再变更 → MEMORY_DRAFT_NOT_FOUND 族。
 * 用例 H 全局记忆双层注入（T5.3）：RAINCODE_HOME/MEMORY.md 落位 → 新会话 system 提示含
 *   全局层标题行与内容、且先于项目层标题行（global 先 workspace 后，02 §7.4 注记）。
 * 用例 I session_search 端到端（T5.3）：tool.tools.list 含 session_search；种子会话历史落盘 →
 *   检索会话模型发起 session_search 工具调用 → 命中回传（计数/出处 sessionId/正文片段）续答收束。
 * 全程仅本机回环与临时目录：无外呼、无真实密钥（mock provider apiKey 为占位符，绝不打印）。
 */
import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcCallError, createInMemoryTransportPair, createRpcClient } from "../packages/rpc/src/index.ts";
import type { RpcClient } from "../packages/rpc/src/index.ts";
import { createAgentServiceNode } from "../packages/server/src/index.ts";
import type { AgentServiceNode } from "../packages/server/src/index.ts";
import { computeWorkspaceHash } from "../packages/storage/src/index.ts";
import { MemoryError, createProjectMemoryService } from "../packages/memory/src/index.ts";
import type { MemoryEntry, MemorySection } from "../packages/shared/src/index.ts";
import { beginTurn, startMockLlmServer, textScript, toolCallFrame, withTimeout } from "./p0-lib.mts";
import type { MockLlmServer, SseScript } from "./p0-lib.mts";

// ---------------------------------------------------------------------------
// 场景装配：临时 RAINCODE_HOME + workspace + mock LLM + memory 域装配的服务节点
// ---------------------------------------------------------------------------

interface Scenario {
  home: string;
  workspace: string;
  sectionEditHooks: { onBeforeRecheck?: () => Promise<void> };
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
  // 用例 B 冲突注入缝：未装填时零开销直通（SectionEditHooks 属性按次解引用，可事后装填）
  const sectionEditHooks: { onBeforeRecheck?: () => Promise<void> } = {};
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
    memory: { workspaceRoot: workspace, sectionEditHooks: sectionEditHooks },
  });
  const client = createRpcClient({ transport: transports[0] });
  await client.call("system.ping", {}); // rpc 握手（首请求必须 system.ping）
  return {
    home,
    workspace,
    sectionEditHooks,
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

  // mtime 冲突（02 §7.4）：经 SectionEditHooks.onBeforeRecheck 注入缝在 S2 复检 snapshot 前
  // 确定性直改文件（一次性自拆），S2 观测到 mtime 变更即 MEMORY_WRITE_CONFLICT——
  // 取代旧「setInterval(0) 竞速 + 10 轮重放」法（残余时序敏感性 ~1/6，PROGRESS §4 收口记录）。
  const memPath = join(workspace, ".raincode", "MEMORY.md");
  scenario.sectionEditHooks.onBeforeRecheck = async () => {
    delete scenario.sectionEditHooks.onBeforeRecheck; // 一次性：本轮冲突后恢复零开销直通
    appendFileSync(memPath, `<!-- 外部并发修改 ${String(Date.now())} -->\n`, "utf8");
  };
  const outcome = await client
    .call("memory.write", { workspaceRoot: workspace, section: "工作约定", content: "并发探测一次命中" })
    .catch((reason: unknown) => reason);
  assert.ok(outcome instanceof RpcCallError, "注入窗口内必现冲突（不再依赖竞速命中）");
  assert.equal((outcome as RpcCallError).code, "MEMORY_WRITE_CONFLICT");
  assert.equal(scenario.sectionEditHooks.onBeforeRecheck, undefined, "注入缝一次性自拆");
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

/**
 * G：晋升草案待确认区（memory.drafts.list/resolve，06 §2.6 v1.7）。
 * 生成规则：confidence ≥ 0.8 且 kind ≠ todo（0.5 preference 与 compact todo 无草案）；
 * 直接管晋升收敛：case E promote decision → 其草案 confirmed；confirm 合入 → 终态。
 */
async function caseDrafts(scenario: Scenario): Promise<void> {
  const { client, workspace } = scenario;

  const listDrafts = async (status?: string): Promise<Array<Record<string, unknown>>> => {
    const res = (await client.call("memory.drafts.list", status === undefined ? {} : { status })) as {
      drafts: Array<Record<string, unknown>>;
    };
    return res.drafts;
  };

  // 生成规则：0.9 decision + 0.8 preference 有草案；0.5 preference 与 0.9 todo（compact）无
  const all = await listDrafts();
  assert.equal(all.length, 2, `草案 2 条（decision 0.9 / preference 0.8），实得 ${String(all.length)}`);
  const byEntry = new Map(all.map((row) => [String(row["entryId"]), row]));
  const listed = (await client.call("memory.entries.list", {})) as { items: MemoryEntry[] };
  const items = listed.items;
  const decision = items.find((e) => e.kind === "decision");
  const highPref = items.find((e) => e.kind === "preference" && e.confidence >= 0.6);
  const lowPref = items.find((e) => e.confidence < 0.6);
  const compactTodo = items.find((e) => e.source === "compact");
  assert.ok(decision !== undefined && highPref !== undefined && lowPref !== undefined && compactTodo !== undefined);
  assert.ok(byEntry.has(decision.id) && byEntry.has(highPref.id), "高置信条目有草案");
  assert.ok(!byEntry.has(lowPref.id), "0.5 条目无草案（低于晋升线）");
  assert.ok(!byEntry.has(compactTodo.id), "todo 无草案（当前进行为 Agent 专用章节）");

  // 直接管晋升收敛（case E promote decision）：草案终态 confirmed，pending 只剩 preference
  const decisionDraft = byEntry.get(decision.id)!;
  assert.equal(decisionDraft["status"], "confirmed", "case E 直接管晋升已收敛 decision 草案");
  assert.notEqual(decisionDraft["resolvedAt"], null);
  const pending = await listDrafts("pending");
  assert.equal(pending.length, 1, `pending 仅 preference，实得 ${String(pending.length)}`);
  const prefDraft = pending[0]!;
  assert.equal(prefDraft["section"], "工作约定", "kind→章节预填（preference → 工作约定）");
  assert.equal((prefDraft["entry"] as MemoryEntry).id, highPref.id, "条目本体随行投影");

  // confirm 合入（调用本身即用户确认动作）→ MEMORY.md 工作约定章节追加
  const resolved = (await client.call("memory.drafts.resolve", {
    draftId: prefDraft["id"],
    action: "confirm",
    section: "工作约定",
  })) as { resolved: boolean; promoted: boolean };
  assert.equal(resolved.resolved, true);
  assert.equal(resolved.promoted, true);
  const read = (await client.call("memory.read", { workspaceRoot: workspace })) as { content: string };
  assert.ok(read.content.includes("- 回复使用中文交流"), "confirm 经 promote 链合入 MEMORY.md");

  // 终态不可再变更 + 未知 id → MEMORY_DRAFT_NOT_FOUND（06 §4.3 段 6）
  for (const draftId of [String(prefDraft["id"]), "draft_missing"]) {
    await assert.rejects(
      client.call("memory.drafts.resolve", { draftId, action: "confirm" }),
      (err: unknown) => err instanceof RpcCallError && err.code === "MEMORY_DRAFT_NOT_FOUND",
    );
  }
  const pendingAfter = await listDrafts("pending");
  assert.equal(pendingAfter.length, 0, "处置后待确认区清空");
  const confirmed = await listDrafts("confirmed");
  assert.equal(confirmed.length, 2, "两草案均 confirmed");
  console.log("case G: 晋升草案待确认区（生成规则 / 直接管晋升收敛 / confirm 合入 / 终态与 NOT_FOUND）OK");
}

/** H：全局记忆双层注入（T5.3：RAINCODE_HOME/MEMORY.md 先于项目层，02 §7.4 注记）。 */
async function caseGlobalMemoryInjection(scenario: Scenario): Promise<void> {
  const { client, mock, home, workspace } = scenario;
  writeFileSync(join(home, "MEMORY.md"), "# 全局约定\n\n回复始终使用中文交流\n", "utf8");

  mock.setScript([textScript("H 收到")]);
  const sessionId = ((await client.call("session.create", {
    workspaceRoot: workspace,
    title: "memory-global",
  })) as { sessionId: string }).sessionId;
  const bodiesStart = mock.bodies.length;
  await sendAndAwait(scenario, sessionId, "H 第一问");
  const body = mock.bodies[bodiesStart];
  const system = body?.messages.find((m) => m.role === "system");
  assert.ok(system !== undefined && typeof system.content === "string", "system 消息存在");
  assert.ok(system.content.includes("# 全局记忆（RAINCODE_HOME/MEMORY.md"), "全局层标题行");
  assert.ok(system.content.includes("回复始终使用中文交流"), "全局层内容注入");
  assert.ok(system.content.includes("# 项目记忆（MEMORY.md"), "项目层标题行仍在");
  assert.ok(
    system.content.indexOf("# 全局记忆") < system.content.indexOf("# 项目记忆"),
    "global 先 workspace 后（02 §7.4）",
  );
  console.log("case H: 全局记忆双层注入（global 先 workspace 后）OK");
}

/** I：session_search 端到端（T5.3：tools.list 可见 + 种子历史检索命中回传续答）。 */
async function caseSessionSearch(scenario: Scenario): Promise<void> {
  const { client, mock, workspace } = scenario;

  const list = (await client.call("tool.tools.list", {})) as { tools: Array<{ name: string }> };
  assert.ok(list.tools.some((t) => t.name === "session_search"), "session_search 进 tools.list（模型侧可见）");

  // 种子会话：历史文本落盘 → part 级索引可检索
  mock.setScript([textScript("I 种子回复")]);
  const seedId = ((await client.call("session.create", {
    workspaceRoot: workspace,
    title: "search-seed",
  })) as { sessionId: string }).sessionId;
  await sendAndAwait(scenario, seedId, "I 记住部署流水线采用 GitHub Actions");

  // 检索会话：模型发起 session_search（唯一种子命中）→ 工具结果回传 → 续答收束
  const searchCall: SseScript = {
    frames: [
      { choices: [{ index: 0, delta: { role: "assistant", content: "" } }] },
      toolCallFrame("call_search_1", "session_search", { query: "部署流水线" }),
    ],
    finish: "tool_calls",
  };
  mock.setScript([searchCall, textScript("I 检索完成")]);
  const searchId = ((await client.call("session.create", {
    workspaceRoot: workspace,
    title: "search-run",
  })) as { sessionId: string }).sessionId;
  const bodiesStart = mock.bodies.length;
  await sendAndAwait(scenario, searchId, "I 帮我找部署流水线的历史");

  const toolMsg = mock.bodies
    .slice(bodiesStart)
    .flatMap((b) => b.messages)
    .find((m) => m.role === "tool");
  assert.ok(toolMsg !== undefined, "第二轮请求应携带工具结果消息");
  const content = typeof toolMsg.content === "string" ? toolMsg.content : JSON.stringify(toolMsg.content);
  assert.ok(content.includes("共 1 条历史命中"), `命中计数（种子唯一），实得：${content.slice(0, 120)}`);
  assert.ok(content.includes(seedId), "命中出处 sessionId");
  assert.ok(content.includes("部署流水线"), "命中正文片段");
  console.log("case I: session_search 端到端（tools.list 可见 + 历史检索命中回传）OK");
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
    await caseDrafts(scenario);
    await caseGlobalMemoryInjection(scenario);
    await caseSessionSearch(scenario);
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
