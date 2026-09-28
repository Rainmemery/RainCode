/**
 * M1 P0 控制面全集 smoke（第六波）。
 * 运行：tsx scripts/smoke-p0.mts（或 pnpm run smoke:p0）
 *
 * a) 注册表对照：METHOD_SCHEMAS ⊇ 07 清单 22 方法、EVENT_SCHEMAS ⊇ 12 事件（打印对照表）；
 * b) config.providers.add（明文 key → 密钥文件 + apiKeyRef 引用）→ providers.list/config.get
 *    响应零明文 → session.create(providerId) 绑定该 Provider → mock LLM 一轮对话成功；
 *    移除活跃 Provider 报 CONFIG_PROVIDER_ACTIVE；session.created 事件可达；
 * c) session.steer：turn 运行中注入 → 下一 turn 模型请求上下文包含 [steering] 注入内容；
 * d) session.setMode(plan) → write 工具被 deny（matchedBy=mode）→ setMode(normal) 恢复审批放行；
 * e) session.archive → 默认 list 不再显示（filter=Archived 可查、state=Archived）→ resume 报
 *    SESSION_NOT_FOUND → send 报 SESSION_ARCHIVED；events.jsonl 不删除；
 * f) 回归：spawn smoke-e2e / smoke-tools / smoke-permission / smoke-compact / smoke-mcp / smoke-subagent /
 *    smoke-memory 子进程，全部退出码 0。
 *
 * 全程仅本机回环与临时目录：无外呼、无真实密钥；明文 key 断言不落入任何响应/落盘/日志。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcCallError, createInMemoryTransportPair, createRpcClient } from "../packages/rpc/src/index.ts";
import type { RpcClient } from "../packages/rpc/src/index.ts";
import { createAgentServiceNode } from "../packages/server/src/index.ts";
import { Storage } from "../packages/storage/src/index.ts";
import type { SessionCreatedEventPayload, SessionListResult } from "../packages/shared/src/index.ts";
import {
  P0_EVENTS,
  P0_METHODS,
  assertRegistryCoverage,
  beginTurn,
  respondAllow,
  startMockLlmServer,
  textScript,
  waitFor,
  withTimeout,
  writeCallScript,
} from "./p0-lib.mts";

const DUMMY_KEY = "p0-smoke-plain-key-DO-NOT-PRINT";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function expectRpcError(reason: unknown, code: string): void {
  assert.ok(reason instanceof RpcCallError, `expected RpcCallError(${code}), got: ${String(reason)}`);
  assert.equal(reason.code, code);
}

async function main(): Promise<void> {
  // ---- a) 注册表对照 ------------------------------------------------------
  assertRegistryCoverage();
  assert.equal(P0_METHODS.length, 22, "07 清单应为 22 个 P0 方法");
  assert.equal(P0_EVENTS.length, 12, "07 清单应为 12 个 P0 事件");
  console.log("step a: 注册表对照通过（22 方法 / 12 事件全量登记）");

  // ---- 环境准备：mock LLM + 隔离 NOVACODE_HOME + in-memory 服务节点 ------
  const mock = await startMockLlmServer();
  const home = await mkdtemp(join(tmpdir(), "novacode-smoke-p0-"));
  const workspace = join(home, "ws");
  await mkdir(workspace, { recursive: true });
  const savedHome = process.env["NOVACODE_HOME"];
  process.env["NOVACODE_HOME"] = home;

  const transports = createInMemoryTransportPair();
  // provider: null —— 默认 Provider 缺席，全部会话经 config 域 providerId 绑定（用例 b 的被测路径）
  const node = await createAgentServiceNode(transports[1], { env: { NOVACODE_HOME: home }, provider: null });
  const client = createRpcClient({ transport: transports[0] });

  try {
    const ping = await client.call<{ protocolVersion: string }>("system.ping", {});
    assert.equal(ping.protocolVersion, "1.0");

    // ---- b) config 域：providers.add（明文 key 隔离）+ session.create(providerId) ----
    const addResult = await client.call<{ provider: { id: string; apiKeyRef: string; apiKeyConfigured: boolean } }>(
      "config.providers.add",
      { provider: { id: "smoke-p0", name: "Smoke P0", baseURL: mock.url, model: "mock-model", maxContextTokens: 8192, apiKey: DUMMY_KEY } },
    );
    assert.equal(addResult.provider.id, "smoke-p0");
    assert.equal(addResult.provider.apiKeyConfigured, true);
    assert.ok(!JSON.stringify(addResult).includes(DUMMY_KEY), "add 响应不得含明文 key");
    const configJson = await readFile(join(home, "config.json"), "utf8");
    assert.ok(!configJson.includes(DUMMY_KEY), "config.json 不得含明文 key");
    const secretsJson = await readFile(join(home, "config", "providers.local.json"), "utf8");
    assert.ok(secretsJson.includes(DUMMY_KEY), "明文 key 应落密钥文件（gitignore 模式）");
    assert.ok(configJson.includes("file:config/providers.local.json#smoke-p0"), "config.json 应存 apiKeyRef 引用");

    const list = await client.call<{ providers: Array<{ id: string; apiKeyConfigured: boolean }>; activeProviderId?: string }>(
      "config.providers.list",
      {},
    );
    assert.equal(list.providers.length, 1);
    assert.equal(list.activeProviderId, "smoke-p0");
    assert.ok(!JSON.stringify(list).includes(DUMMY_KEY), "providers.list 响应不得含明文 key");
    const got = await client.call<{ configVersion: number }>("config.get", {});
    assert.equal(got.configVersion, 1);
    assert.ok(!JSON.stringify(got).includes(DUMMY_KEY), "config.get 响应不得含明文 key");

    // remove 语义：活跃 Provider 拒删；非活跃可删
    await client.call("config.providers.add", {
      provider: { id: "spare", name: "spare", baseURL: mock.url, model: "m2", maxContextTokens: 4096 },
    });
    try {
      await client.call("config.providers.remove", { id: "smoke-p0" });
      assert.fail("remove active provider should fail");
    } catch (reason: unknown) {
      expectRpcError(reason, "CONFIG_PROVIDER_ACTIVE");
    }
    const removed = await client.call<{ removed: boolean }>("config.providers.remove", { id: "spare" });
    assert.equal(removed.removed, true);

    // session.create(providerId) → session.created 事件 → mock LLM 一轮对话
    let resolveCreated!: (payload: SessionCreatedEventPayload) => void;
    const createdPromise = new Promise<SessionCreatedEventPayload>((r) => (resolveCreated = r));
    const offCreated = client.onEvent("session.created", (payload) => resolveCreated(payload as SessionCreatedEventPayload));
    const session1 = await client.call<{ sessionId: string }>("session.create", {
      workspaceRoot: workspace, providerId: "smoke-p0", title: "p0 provider",
    });
    const created = await withTimeout(createdPromise, 5000, "session.created event");
    offCreated();
    assert.equal(created.sessionId, session1.sessionId);
    assert.equal(created.mode, "normal");
    assert.equal(created.workspaceRoot, workspace);
    mock.setScript([textScript("provider round ok")]);
    const run1 = beginTurn(client, session1.sessionId, "打个招呼");
    await run1.sendPromise;
    const done1 = await withTimeout(run1.done, 15000, "provider round turn");
    run1.stop();
    assert.equal(done1.outcome, "completed");
    assert.equal(mock.served(), 1, "应恰好一次模型请求（走配置 Provider）");
    console.log("step b: config.providers.add/list/get、明文 key 隔离、session.create(providerId) + 一轮对话 OK");

    // ---- c) session.steer：运行中注入 → 下一 turn 上下文包含注入内容 -------
    const session2 = await client.call<{ sessionId: string }>("session.create", {
      workspaceRoot: workspace, providerId: "smoke-p0", title: "p0 steer",
    });
    const STEER_TEXT = "补充：请聚焦单元测试";
    mock.setScript([textScript("第一轮回复", 800), textScript("第二轮回复")]);
    const bodiesStart = mock.bodies.length;
    const run2 = beginTurn(client, session2.sessionId, "第一问");
    const admission2 = (await run2.sendPromise) as { turnId: string };
    // 等待 turn1 请求体到达 mock（= 上下文组装已完成），此刻注入必然汇入「下一轮上下文」；
    // mock 响应延迟 800ms 保证 turn1 仍在运行中 → steer 判级为 injected。
    await waitFor(() => mock.bodies.length > bodiesStart, 5000, "turn1 request arrived at mock");
    const steer = await client.call<{ result: string; turnId?: string }>("session.steer", {
      sessionId: session2.sessionId, input: { text: STEER_TEXT },
    });
    assert.equal(steer.result, "injected", "turn 运行中 steer 应注入");
    assert.equal(steer.turnId, admission2.turnId, "injected 应携带运行中 turnId");
    const done2 = await withTimeout(run2.done, 15000, "steer turn1");
    run2.stop();
    assert.equal(done2.outcome, "completed");
    const run3 = beginTurn(client, session2.sessionId, "第二问");
    await run3.sendPromise;
    const done3 = await withTimeout(run3.done, 15000, "steer turn2");
    run3.stop();
    assert.equal(done3.outcome, "completed");
    const turn2Body = mock.bodies[bodiesStart + 1];
    assert.ok(turn2Body, "应捕获第二次模型请求体");
    const hasSteering = turn2Body.messages.some(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.includes(`[steering] ${STEER_TEXT}`),
    );
    assert.ok(hasSteering, "下一 turn 请求上下文应包含 [steering] 注入内容");
    console.log("step c: session.steer 运行中 injected + 下一 turn 上下文含注入内容 OK");

    // ---- d) session.setMode：plan deny（matchedBy=mode）→ normal 恢复 ------
    const session3 = await client.call<{ sessionId: string }>("session.create", {
      workspaceRoot: workspace, providerId: "smoke-p0", title: "p0 mode",
    });
    mock.setScript([
      writeCallScript("call-a", "p0-mode-a.txt", "written in normal"),
      textScript("done a"),
      writeCallScript("call-b", "p0-mode-b.txt", "should never run"),
      textScript("done b"),
      writeCallScript("call-c", "p0-mode-c.txt", "written again in normal"),
      textScript("done c"),
    ]);
    // turn A：normal + 默认 ask → respond allow → 执行成功
    const runA = beginTurn(client, session3.sessionId, "写文件 A");
    await runA.sendPromise;
    await waitFor(() => runA.requested.length > 0, 10000, "permission.requested (normal)");
    assert.equal(runA.requested[0]?.mode, "normal");
    await respondAllow(client, runA.requested[0]!.grantId);
    const doneA = await withTimeout(runA.done, 15000, "mode turn A");
    runA.stop();
    assert.equal(doneA.outcome, "completed");
    assert.equal(runA.toolCompleted[0]?.isError, false);
    await stat(join(workspace, "p0-mode-a.txt")); // 文件已写

    // turn B：plan → write 在判定链 L2 被 deny（无审批单）
    await client.call("session.setMode", { sessionId: session3.sessionId, mode: "plan" });
    const runB = beginTurn(client, session3.sessionId, "写文件 B");
    await runB.sendPromise;
    const doneB = await withTimeout(runB.done, 15000, "mode turn B");
    runB.stop();
    assert.equal(doneB.outcome, "completed");
    assert.equal(runB.requested.length, 0, "plan 模式写类应直接 deny，不出审批单");
    assert.equal(runB.toolCompleted[0]?.isError, true, "plan 模式写类工具应失败收束");
    await assert.rejects(stat(join(workspace, "p0-mode-b.txt")), "plan 模式下文件不应被写入");
    const decisions = await client.call<{ items: Array<{ toolName: string; decision: string; matchedBy: string; mode: string }> }>(
      "permission.decisions.list",
      { sessionId: session3.sessionId },
    );
    const modeDeny = decisions.items.find((d) => d.matchedBy === "mode" && d.decision === "deny");
    assert.ok(modeDeny, "审计应含 matchedBy=mode 的 deny 记录");
    assert.equal(modeDeny.toolName, "write");

    // turn C：setMode(normal) 恢复 → 审批放行 → 执行成功
    await client.call("session.setMode", { sessionId: session3.sessionId, mode: "normal" });
    const runC = beginTurn(client, session3.sessionId, "写文件 C");
    await runC.sendPromise;
    await waitFor(() => runC.requested.length > 0, 10000, "permission.requested (restored)");
    await respondAllow(client, runC.requested[0]!.grantId);
    const doneC = await withTimeout(runC.done, 15000, "mode turn C");
    runC.stop();
    assert.equal(doneC.outcome, "completed");
    assert.equal(runC.toolCompleted[0]?.isError, false);
    await stat(join(workspace, "p0-mode-c.txt"));
    console.log("step d: setMode(plan) 写类 deny（matchedBy=mode）→ setMode(normal) 审批放行恢复 OK");

    // ---- e) session.archive：list 不可见（Archived 可查）+ 只读化 + JSONL 保留 --
    const session4 = await client.call<{ sessionId: string }>("session.create", {
      workspaceRoot: workspace, providerId: "smoke-p0", title: "p0 archive",
    });
    mock.setScript([textScript("before archive")]);
    const runE = beginTurn(client, session4.sessionId, "归档前最后一句");
    await runE.sendPromise;
    const doneE = await withTimeout(runE.done, 15000, "archive pre-turn");
    runE.stop();
    assert.equal(doneE.outcome, "completed");
    const archived = await client.call<{ archived: boolean }>("session.archive", { sessionId: session4.sessionId });
    assert.equal(archived.archived, true);
    const listAll = await client.call<SessionListResult>("session.list", {});
    assert.ok(!listAll.items.some((s) => s.id === session4.sessionId), "默认 list 不再显示归档会话");
    const listArchived = await client.call<SessionListResult>("session.list", { filter: { state: "Archived" } });
    const archivedRow = listArchived.items.find((s) => s.id === session4.sessionId);
    assert.ok(archivedRow, "filter=Archived 应可查到归档会话");
    assert.equal(archivedRow.state, "Archived");
    try {
      await client.call("session.resume", { sessionId: session4.sessionId });
      assert.fail("resume archived should fail");
    } catch (reason: unknown) {
      expectRpcError(reason, "SESSION_NOT_FOUND");
    }
    try {
      await client.call("session.send", { sessionId: session4.sessionId, input: { text: "hi" } });
      assert.fail("send archived should fail");
    } catch (reason: unknown) {
      expectRpcError(reason, "SESSION_ARCHIVED");
    }
    const storage = await Storage.open({ env: { NOVACODE_HOME: home } });
    const eventsFile = await storage.sessionEventsFile(session4.sessionId);
    const raw = await readFile(eventsFile, "utf8");
    assert.ok(raw.includes("before archive"), "归档会话 JSONL 不删除且内容完整");
    await storage.close();
    console.log("step e: session.archive（list 不可见 / Archived 可查 / resume SESSION_NOT_FOUND / send SESSION_ARCHIVED / JSONL 保留）OK");

    // ---- system.version / system.shutdown ---------------------------------
    const version = await client.call<{ protocolVersion: string; appVersion: string; configVersion: number; nodeVersion?: string }>(
      "system.version",
      {},
    );
    assert.equal(version.protocolVersion, "1.0");
    assert.match(version.appVersion, /^\d+\.\d+\.\d+/);
    assert.equal(version.configVersion, 1);
    assert.ok(version.nodeVersion?.startsWith("v"));
    const shutdown = await client.call<{ shuttingDown: true }>("system.shutdown", { reason: "smoke" });
    assert.equal(shutdown.shuttingDown, true);
    try {
      await client.call("system.ping", {});
      assert.fail("ping after shutdown should fail");
    } catch (reason: unknown) {
      expectRpcError(reason, "CANCELLED");
    }
    console.log("step f0: system.version + system.shutdown（停机后请求 CANCELLED）OK");
  } finally {
    client.close();
    await node.close();
    await transports[0].close();
    await transports[1].close();
    if (savedHome === undefined) delete process.env["NOVACODE_HOME"];
    else process.env["NOVACODE_HOME"] = savedHome;
  }

  // ---- f) 既有 smoke 回归（子进程，隔离 env）------------------------------
  const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
  delete cleanEnv["NOVACODE_HOME"];
  for (const script of ["smoke-e2e.mts", "smoke-tools.mts", "smoke-permission.mts", "smoke-compact.mts", "smoke-mcp.mts", "smoke-subagent.mts", "smoke-memory.mts"]) {
    const result = spawnSync(process.execPath, ["--import", "tsx", join(REPO_ROOT, "scripts", script)], {
      cwd: REPO_ROOT,
      env: cleanEnv,
      encoding: "utf8",
      timeout: 300000,
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(
      result.status,
      0,
      `回归失败 ${script}（exit ${String(result.status)}）\n-- stdout --\n${result.stdout}\n-- stderr --\n${result.stderr}`,
    );
    console.log(`step f: 回归 ${script} OK`);
  }

  await mock.close();
  await rm(home, { recursive: true, force: true });
  console.log(`数据根（临时 NOVACODE_HOME）已清理: ${home}`);
  console.log("");
  console.log("SMOKE OK");
}

main().catch((reason: unknown) => {
  console.error("");
  console.error("SMOKE FAILED:", reason);
  process.exitCode = 1;
});
