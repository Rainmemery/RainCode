/**
 * 命令权限控制 smoke（第五波）。
 * 运行：tsx scripts/smoke-permission.mts（或 pnpm run smoke:permission）
 *
 * 链路：node:http 本地 mock OpenAI SSE 服务器（按请求序号脚本化 12 轮回复）→ 临时 RAINCODE_HOME
 * → createAgentServiceNode（in-memory 绑定，normal 权限策略=默认）→ RPC session.send →
 * 五级判定链 + ApprovalBroker 审批闭环 → 断言：
 *
 * a) normal 策略 + 无规则 → permission.requested → RPC respond allow → 工具执行成功
 *    + permission_decisions 有记录（decision=allow、respondLatencyMs>0）+ 审批事件落 JSONL；
 * b) respond deny → 工具未执行、模型收到 TOOL_PERMISSION_DENIED、grantId 复用报 PC_GRANT_CONSUMED；
 * c) rules.add(global allow wildcard write) → 新会话直接 allow 无审批 + 重启 service 后仍 allow
 *    （SQLite 持久化生效；session 规则驻内存不入库）；
 * d) bash 只读命令（ls）无审批直接执行；高危根命令（rm -rf …）即使存在 bash 通配 allow 规则
 *    也不被自动放行（matchedBy=default → respond deny 收敛，02 §6.4）；
 * e) 规则优先级合并矩阵（T2.5 验收）：e1 project deny 覆盖 global allow（首个命中层级生效）；
 *    e2 global deny 收敛；e3 规则清空回归 default ask；e4 project 规则 workspace 隔离
 *    （ws1 的 project deny 不作用于 ws2 会话，对照 ws1 命中）；e5 global 规则跨 workspace 放行。
 *
 * 安全注记：高危用例取 `rm -rf ./workspace 内标记文件`（根命令 rm 的高危分类与 `rm -rf /` 完全
 * 同源，但即使判定链意外放行也只影响临时工作区内文件，smoke 绝不触碰真实系统）。
 * 全程仅本机回环与临时目录：无外呼、无真实密钥。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcCallError, createInMemoryTransportPair, createRpcClient } from "../packages/rpc/src/index.ts";
import type { RpcClient } from "../packages/rpc/src/index.ts";
import { createAgentServiceNode } from "../packages/server/src/index.ts";
import { Storage } from "../packages/storage/src/index.ts";
import { startMockLlmServer, textFrame, toolCallFrame, type MockLlmServer, type SseScript } from "./p0-lib.mts";
import type {
  DoneEventPayload,
  PermissionDecisionsListResult,
  PermissionDecisionRecord,
  PermissionRequestedPayload,
  PermissionRespondResult,
  PermissionRulesListResult,
  ToolCallCompletedEventPayload,
} from "../packages/shared/src/index.ts";

const delay = (ms: number): Promise<void> => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

// ---------------------------------------------------------------------------
// turn 执行与事件捕获（订阅先于 send，06 §1.2 串行不阻塞）
// ---------------------------------------------------------------------------

interface TurnHandle {
  done: Promise<DoneEventPayload>;
  /** 首个 permission.requested（未出现则挂起——用例层需配合超时兜底）。 */
  requestedPromise: Promise<PermissionRequestedPayload>;
  requested: PermissionRequestedPayload[];
  toolCompleted: ToolCallCompletedEventPayload[];
}

function runTurn(client: RpcClient, sessionId: string, text: string): TurnHandle {
  const requested: PermissionRequestedPayload[] = [];
  const toolCompleted: ToolCallCompletedEventPayload[] = [];
  let resolveRequested!: (payload: PermissionRequestedPayload) => void;
  let resolveDone!: (payload: DoneEventPayload) => void;
  let rejectSend!: (reason: unknown) => void;
  const requestedPromise = new Promise<PermissionRequestedPayload>((resolvePromise) => {
    resolveRequested = resolvePromise;
  });
  const done = new Promise<DoneEventPayload>((resolvePromise, rejectPromise) => {
    resolveDone = resolvePromise;
    rejectSend = rejectPromise;
  });

  const offRequested = client.onEvent("permission.requested", (payload) => {
    const event = payload as PermissionRequestedPayload;
    requested.push(event);
    resolveRequested(event);
  });
  const offToolCompleted = client.onEvent("tool_call.completed", (payload) => {
    toolCompleted.push(payload as ToolCallCompletedEventPayload);
  });
  const offDone = client.onEvent("done", (payload) => {
    offRequested();
    offToolCompleted();
    offDone();
    resolveDone(payload as DoneEventPayload);
  });

  client.call("session.send", { sessionId, input: { text } }).catch((reason: unknown) => {
    offRequested();
    offToolCompleted();
    offDone();
    rejectSend(reason);
  });
  return { done, requestedPromise, requested, toolCompleted };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf8");
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  // 脚本：24 次模型请求（A 两轮 / B 两轮 / C 首会话两轮 / C 重启会话两轮 / D-ls 两轮 / D-rm 两轮 / e 组十二轮）
  const writeA = { path: "out/file-a.txt", content: "approved by user" };
  const writeB = { path: "out/file-b.txt", content: "should not exist" };
  const writeC = { path: "out/file-c.txt", content: "allowed by global rule" };
  const writeC2 = { path: "out/file-c2.txt", content: "allowed after restart" };
  const writeE = { path: "out/file-e.txt", content: "matrix probe" };
  const script: SseScript[] = [
    { finish: "tool_calls", frames: [toolCallFrame("call_a", "write", writeA)] },
    { finish: "stop", frames: [textFrame("A：write 已获审批并执行完成。")] },
    { finish: "tool_calls", frames: [toolCallFrame("call_b", "write", writeB)] },
    { finish: "stop", frames: [textFrame("B：write 被用户拒绝，不再重试。")] },
    { finish: "tool_calls", frames: [toolCallFrame("call_c", "write", writeC)] },
    { finish: "stop", frames: [textFrame("C：全局规则放行，直接执行。")] },
    { finish: "tool_calls", frames: [toolCallFrame("call_c2", "write", writeC2)] },
    { finish: "stop", frames: [textFrame("C2：重启后全局规则仍放行。")] },
    { finish: "tool_calls", frames: [toolCallFrame("call_ls", "bash", { command: "ls" })] },
    { finish: "stop", frames: [textFrame("D1：只读命令已直接执行。")] },
    { finish: "tool_calls", frames: [toolCallFrame("call_rm", "bash", { command: "rm -rf ./pwn-marker.txt" })] },
    { finish: "stop", frames: [textFrame("D2：高危命令被拒绝。")] },
    // 用例 e：合并矩阵（每轮 write 尝试 = tool_calls + stop 两请求）
    { finish: "tool_calls", frames: [toolCallFrame("call_e1", "write", writeE)] },
    { finish: "stop", frames: [textFrame("E1：project deny 覆盖 global allow。")] },
    { finish: "tool_calls", frames: [toolCallFrame("call_e2", "write", writeE)] },
    { finish: "stop", frames: [textFrame("E2：global deny 收敛。")] },
    { finish: "tool_calls", frames: [toolCallFrame("call_e3", "write", writeE)] },
    { finish: "stop", frames: [textFrame("E3：规则清空回归 default ask。")] },
    { finish: "tool_calls", frames: [toolCallFrame("call_e4w2", "write", writeE)] },
    { finish: "stop", frames: [textFrame("E4-ws2：project 规则不跨 workspace。")] },
    { finish: "tool_calls", frames: [toolCallFrame("call_e4w1", "write", writeE)] },
    { finish: "stop", frames: [textFrame("E4-ws1：project deny 命中。")] },
    { finish: "tool_calls", frames: [toolCallFrame("call_e5", "write", writeE)] },
    { finish: "stop", frames: [textFrame("E5：global 规则跨 workspace 放行。")] },
  ];

  const mock: MockLlmServer = await startMockLlmServer();
  mock.setScript(script);
  const home = await mkdtemp(join(tmpdir(), "raincode-smoke-permission-"));
  const workspace = join(home, "ws");
  await mkdir(workspace, { recursive: true });

  const provider = {
    name: "mock-permission",
    baseURL: `http://127.0.0.1:${String(mock.port)}/v1`,
    model: "mock-model",
    apiKey: "smoke-dummy-key",
    maxContextTokens: 8192,
  };

  let client: RpcClient | null = null;
  let closeNode: (() => Promise<void>) | null = null;
  const startNode = async (): Promise<RpcClient> => {
    const transports = createInMemoryTransportPair();
    const node = await createAgentServiceNode(transports[1], {
      env: { RAINCODE_HOME: home },
      provider,
      systemPrompt: "You are RainCode (permission smoke).",
      // normal 为默认策略；此处显式声明以自文档化
      permission: { policy: "normal" },
    });
    closeNode = async () => {
      await node.close();
      await transports[0].close();
      await transports[1].close();
    };
    client = createRpcClient({ transport: transports[0] });
    return client;
  };

  try {
    // =========================================================================
    // 用例 a：normal + 无规则 → 审批 allow → 执行成功 + 审计 + 事件落盘
    // =========================================================================
    {
      client = await startNode();
      await client.call("system.ping", {});
      const created = await client.call<{ sessionId: string }>("session.create", {
        workspaceRoot: workspace,
        title: "smoke-permission a",
      });
      const sessionId = created.sessionId;

      const turn = runTurn(client, sessionId, "把审批通过的内容写入 out/file-a.txt");
      const requestedEvent = await turn.requestedPromise;
      assert.equal(requestedEvent.toolName, "write", "用例 a 应对 write 工具产生审批单");
      assert.equal(requestedEvent.matchedBy, "default", "无规则时命中来源应为 default");
      assert.ok(requestedEvent.expiresAt > Date.now() - 1000, "审批单应携带过期时间");

      await delay(10); // 模拟人类审批时延，保证 respondLatencyMs 可观测
      const responded = await client.call<PermissionRespondResult>("permission.respond", {
        grantId: requestedEvent.grantId,
        decision: "allow",
      });
      assert.equal(responded.resolved, true);
      const done = await turn.done;
      assert.equal(done.outcome, "completed", "用例 a turn 应 completed");

      // 工具真实执行 + 审计记录 + 事件落盘
      assert.equal(
        await fileExists(join(workspace, "out", "file-a.txt")),
        true,
        "审批 allow 后 write 应真实执行",
      );
      const decisions = await client.call<PermissionDecisionsListResult>("permission.decisions.list", {
        sessionId,
      });
      const record = decisions.items.find((item) => item.grantId === requestedEvent.grantId);
      assert.ok(record !== undefined, "permission_decisions 应有本审批的终判记录");
      assert.equal(record.decision, "allow");
      assert.equal(record.matchedBy, "default");
      assert.ok(
        (record.respondLatencyMs ?? 0) > 0,
        `respondLatencyMs 应 > 0，实际 ${String(record.respondLatencyMs)}`,
      );
      assert.ok(record.inputDigest.length > 0 && !record.inputDigest.includes("smoke-dummy-key"), "审计摘要应脱敏");

      const storage = await Storage.open({ env: { RAINCODE_HOME: home } });
      const eventsFile = await storage.sessionEventsFile(sessionId);
      const raw = await readFile(eventsFile, "utf8");
      assert.ok(raw.includes('"name":"permission.requested"'), "permission.requested 应落 JSONL");
      assert.ok(raw.includes('"name":"permission.resolved"'), "permission.resolved 应落 JSONL");
      await storage.close();
      console.log("用例 a：审批 allow 闭环成功，审计含 respondLatencyMs，审批事件落 JSONL");

      // =========================================================================
      // 用例 b：respond deny → 未执行 + 模型收到拒绝 + grantId 单消费
      // =========================================================================
      const turnB = runTurn(client, sessionId, "把内容写入 out/file-b.txt");
      const requestedB = await turnB.requestedPromise;
      await client.call("permission.respond", { grantId: requestedB.grantId, decision: "deny" });
      const doneB = await turnB.done;
      assert.equal(doneB.outcome, "completed", "拒绝路径 turn 仍应正常收束");
      assert.equal(
        await fileExists(join(workspace, "out", "file-b.txt")),
        false,
        "被拒 write 不得产生文件副作用",
      );
      const deniedCompleted = turnB.toolCompleted.find((event) => event.toolCallId !== undefined);
      assert.equal(deniedCompleted?.isError, true, "被拒调用应 isError 收敛");
      assert.equal(deniedCompleted?.error?.code, "TOOL_PERMISSION_DENIED", "模型应收到权限拒绝错误码");

      const decisionsB = await client.call<PermissionDecisionsListResult>("permission.decisions.list", {
        sessionId,
        decision: "deny",
      });
      assert.ok(
        decisionsB.items.some((item) => item.grantId === requestedB.grantId),
        "deny 终判应落审计",
      );

      // grantId 复用 → PC_GRANT_CONSUMED（单消费，任务交付语义）
      await assert.rejects(
        client.call("permission.respond", { grantId: requestedB.grantId, decision: "allow" }),
        (err: unknown) =>
          err instanceof RpcCallError && err.code === "PC_GRANT_CONSUMED",
        "重复 respond 同一 grantId 应报 PC_GRANT_CONSUMED",
      );
      console.log("用例 b：deny 后未执行、模型收到拒绝结果，grantId 复用报 PC_GRANT_CONSUMED");
    }

    // =========================================================================
    // 用例 c：global allow 通配规则 → 新会话免审批；重启 service 后仍免审批
    // =========================================================================
    {
      const added = await client!.call<PermissionRulesAddResult>("permission.rules.add", {
        scope: "global",
        tool: "write",
        behavior: "allow",
      });
      assert.ok(added.rule.id.length > 0, "rules.add 应返回规则 id");
      assert.equal(added.rule.scope, "global");

      const created = await client!.call<{ sessionId: string }>("session.create", {
        workspaceRoot: workspace,
        title: "smoke-permission c1",
      });
      const turnC = runTurn(client!, created.sessionId, "把全局放行的内容写入 out/file-c.txt");
      const doneC = await turnC.done;
      assert.equal(doneC.outcome, "completed");
      assert.equal(turnC.requested.length, 0, "命中 global allow 规则应无审批单");
      assert.equal(await fileExists(join(workspace, "out", "file-c.txt")), true, "规则放行后 write 应直接执行");

      // 重启 service（同一数据根 + 同一 mock 服务器）：SQLite 持久化规则仍生效
      client!.close();
      await closeNode?.();
      client = await startNode();
      await client.call("system.ping", {});

      const rules = await client.call<PermissionRulesListResult>("permission.rules.list", {
        scope: "global",
      });
      assert.ok(
        rules.rules.some((rule) => rule.id === added.rule.id && rule.tool === "write"),
        "重启后 global 规则应从 SQLite 重新加载",
      );

      const created2 = await client.call<{ sessionId: string }>("session.create", {
        workspaceRoot: workspace,
        title: "smoke-permission c2",
      });
      const turnC2 = runTurn(client, created2.sessionId, "重启后再写 out/file-c2.txt");
      const doneC2 = await turnC2.done;
      assert.equal(doneC2.outcome, "completed");
      assert.equal(turnC2.requested.length, 0, "重启后规则仍应放行（无审批单）");
      assert.equal(await fileExists(join(workspace, "out", "file-c2.txt")), true, "重启后 write 应直接执行");
      console.log("用例 c：global allow 通配规则新会话免审批，重启 service 后持久化生效");
    }

    // =========================================================================
    // 用例 d：bash 只读命令免审批直接执行；高危根命令即使有通配 allow 也不放行
    // =========================================================================
    {
      await client!.call("permission.rules.add", { scope: "global", tool: "bash", behavior: "allow" });

      const created = await client!.call<{ sessionId: string }>("session.create", {
        workspaceRoot: workspace,
        title: "smoke-permission d",
      });
      const sessionIdD = created.sessionId;

      // d1：ls（只读白名单）无审批直接执行
      const turnLs = runTurn(client!, sessionIdD, "列出当前目录文件");
      const doneLs = await turnLs.done;
      assert.equal(doneLs.outcome, "completed");
      assert.equal(turnLs.requested.length, 0, "只读命令 ls 不应产生审批单");
      assert.equal(turnLs.toolCompleted.length, 1);
      assert.equal(turnLs.toolCompleted[0]?.isError, false, "ls 应执行成功");
      console.log("用例 d1：bash 只读命令（ls）无审批直接执行");

      // d2：rm -rf（高危根命令）即使存在 bash 通配 allow 规则也进入逐次审批 → deny 收敛
      const turnRm = runTurn(client!, sessionIdD, "删除 pwn-marker.txt");
      const requestedRm = await turnRm.requestedPromise;
      assert.equal(requestedRm.toolName, "bash");
      assert.equal(requestedRm.matchedBy, "default", "通配 allow 不应命中高危根命令（02 §6.4）");
      assert.ok(requestedRm.reason.includes("高危"), `理由应说明高危降级：${requestedRm.reason}`);
      await client!.call("permission.respond", { grantId: requestedRm.grantId, decision: "deny" });
      const doneRm = await turnRm.done;
      assert.equal(doneRm.outcome, "completed");
      const rmCompleted = turnRm.toolCompleted[turnRm.toolCompleted.length - 1];
      assert.equal(rmCompleted?.isError, true, "高危命令被拒应以 isError 收敛");

      const decisionsRm = await client!.call<PermissionDecisionsListResult>("permission.decisions.list", {
        sessionId: sessionIdD,
        toolName: "bash",
        decision: "deny",
      });
      assert.ok(decisionsRm.items.length >= 1, "高危命令 deny 终判应落审计");
      console.log("用例 d2：高危根命令不被通配 allow 放行（matchedBy=default），deny 收敛并落审计");
    }

    // =========================================================================
    // 用例 e：规则优先级合并矩阵（T2.5 验收：跨层首个命中生效 / removeRule 即时生效 /
    // project 规则 workspace 隔离 / global 规则跨 workspace）
    // =========================================================================
    {
      const ePath = join(workspace, "out", "file-e.txt");
      await rm(ePath, { force: true }).catch(() => undefined);
      const removeRules = async (scope: string, tool: string, behavior?: string): Promise<void> => {
        const rules = ((await client!.call("permission.rules.list", { scope, tool })) as PermissionRulesListResult)
          .rules.filter((rule) => behavior === undefined || rule.behavior === behavior);
        for (const rule of rules) await client!.call("permission.rules.remove", { id: rule.id });
      };
      const addRule = async (scope: string, tool: string, behavior: "allow" | "deny"): Promise<void> => {
        await client!.call("permission.rules.add", { scope, tool, behavior });
      };
      const latestWriteRecord = async (sid: string): Promise<PermissionDecisionRecord> => {
        const decisions = await client!.call<PermissionDecisionsListResult>("permission.decisions.list", {
          sessionId: sid,
          toolName: "write",
        });
        assert.ok(decisions.items.length > 0, "应存在新增的 write 判定记录");
        return decisions.items[0]!; // decisions.list 按 ts DESC，首条即最新
      };

      // e1：project deny 覆盖 global allow（判定链 session→project→global 首个命中层级生效，02 §6.2）
      await addRule("project", "write", "deny");
      const createdE1 = await client!.call<{ sessionId: string }>("session.create", {
        workspaceRoot: workspace,
        title: "smoke-permission e (ws1)",
      });
      const sessionIdE1 = createdE1.sessionId;
      const turnE1 = runTurn(client!, sessionIdE1, "e1 尝试写入");
      await turnE1.done;
      assert.equal(turnE1.requested.length, 0, "e1：project deny 命中应无审批单");
      assert.equal(turnE1.toolCompleted[0]?.isError, true, "e1：deny 应以 isError 收敛");
      assert.equal(await fileExists(ePath), false, "e1：deny 后不应写入文件");
      assert.equal((await latestWriteRecord(sessionIdE1)).matchedBy, "project-rule", "e1：审计应记录 project-rule");
      console.log("用例 e1：project deny 覆盖 global allow（首个命中层级生效）");

      // e2：移除 project deny → global deny 收敛（removeRule 即时生效 + global 层命中；
      //     global+write+无 pattern 为唯一键 05 §3.6，先删 c 遗留 allow 再加 deny）
      await removeRules("project", "write");
      await removeRules("global", "write", "allow");
      await addRule("global", "write", "deny");
      const turnE2 = runTurn(client!, sessionIdE1, "e2 尝试写入");
      await turnE2.done;
      assert.equal(turnE2.requested.length, 0, "e2：global deny 命中应无审批单");
      assert.equal(turnE2.toolCompleted[0]?.isError, true, "e2：deny 应以 isError 收敛");
      assert.equal((await latestWriteRecord(sessionIdE1)).matchedBy, "global-rule", "e2：审计应记录 global-rule");
      console.log("用例 e2：移除 project 规则即时生效，global deny 收敛");

      // e3：清空规则 → 回归 default ask（兜底链路）
      await removeRules("global", "write", "deny");
      const turnE3 = runTurn(client!, sessionIdE1, "e3 尝试写入");
      const e3Requested = await turnE3.requestedPromise;
      assert.equal(e3Requested.matchedBy, "default", "e3：清空后应回归 default ask");
      await client!.call("permission.respond", { grantId: e3Requested.grantId, decision: "deny" });
      await turnE3.done;
      assert.equal(await fileExists(ePath), false, "e3：审批 deny 后不应写入");
      console.log("用例 e3：规则清空回归 default ask（兜底）");

      // e4：project 规则 workspace 隔离——ws1 的 project deny 不作用于 ws2 会话（05 §3.6 workspace_id 过滤）
      const workspace2 = join(home, "ws2");
      await mkdir(workspace2, { recursive: true });
      await addRule("project", "write", "deny");
      const createdE4 = await client!.call<{ sessionId: string }>("session.create", {
        workspaceRoot: workspace2,
        title: "smoke-permission e4 (ws2)",
      });
      const sessionIdE4 = createdE4.sessionId;
      const turnE4w2 = runTurn(client!, sessionIdE4, "e4 ws2 尝试写入");
      const e4w2Requested = await turnE4w2.requestedPromise;
      assert.equal(e4w2Requested.matchedBy, "default", "e4：ws1 的 project deny 不应作用于 ws2（隔离）");
      await client!.call("permission.respond", { grantId: e4w2Requested.grantId, decision: "deny" });
      await turnE4w2.done;
      const turnE4w1 = runTurn(client!, sessionIdE1, "e4 ws1 尝试写入");
      await turnE4w1.done;
      assert.equal(turnE4w1.requested.length, 0, "e4：对照 ws1 应命中 project deny 无审批单");
      assert.equal(turnE4w1.toolCompleted[0]?.isError, true, "e4：ws1 deny 收敛");
      console.log("用例 e4：project 规则 workspace 隔离（ws2 免疫 ws1 的 project deny，ws1 命中）");

      // e5：global 规则跨 workspace 放行（对照隔离语义；e3 已删 global deny，add allow 无同键冲突）
      await removeRules("project", "write");
      await addRule("global", "write", "allow");
      const turnE5 = runTurn(client!, sessionIdE4, "e5 ws2 尝试写入");
      await turnE5.done;
      assert.equal(turnE5.requested.length, 0, "e5：global allow 对 ws2 生效应无审批单");
      assert.equal(turnE5.toolCompleted[0]?.isError, false, "e5：global allow 放行执行");
      assert.equal(
        await fileExists(join(workspace2, "out", "file-e.txt")),
        true,
        "e5：global allow 跨 workspace 放行写入",
      );
      assert.equal((await latestWriteRecord(sessionIdE4)).matchedBy, "global-rule", "e5：审计应记录 global-rule");
      console.log("用例 e5：global 规则跨 workspace 放行（对照 project 隔离）");
    }

    void mock.served;
    console.log("");
    console.log(`数据根（临时 RAINCODE_HOME）: ${home}`);
    console.log("");
    console.log("SMOKE OK");
  } finally {
    client?.close();
    await closeNode?.();
    await mock.close();
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((reason: unknown) => {
  console.error("");
  console.error("SMOKE FAILED:", reason);
  process.exitCode = 1;
});
