/**
 * hooks 域接入 smoke（T5.1，06-api-spec §2.12 v1.12）。
 * 运行：tsx scripts/smoke-hooks.mts（或 pnpm run smoke:hooks）
 *
 * 链路：node:http mock OpenAI SSE + 临时 RAINCODE_HOME（user 层 hooks.json）
 * + workspace/.raincode/hooks.json（project 层）→ createAgentServiceNode（hooks 域装配）
 * → 五验收用例（07 §11.2 T5.1）：
 * 用例 1 PreToolUse deny 真实拦截（N-3）：project hook 拦截 write 工具调用 → TOOL_HOOK_DENIED
 *   结果 + hook.completed(blocked) + hook 拒绝先于权限（default-allow 政策下不可能来自审批）。
 * 用例 2 additionalContext 注入下一回合：user hook 追加上下文 → mock 请求体含
 *   [hook:UserPromptSubmit via <hookId>] provenance 标记。
 * 用例 3 超时与坏 JSON = failed 不阻塞：timed_out / failed hook 与成功 hook 同组 →
 *   工具照常执行成功；hook.result 逐 hook 落盘且 stderr 截断 ≤500 字符。
 * 用例 4 project hook 授信闭环：未授信跳过（skipped_untrusted）→ hooks.trust.grant 后生效
 *   （UserPromptSubmit block → turn failed HOOK_BLOCKED）→ revoke 后立即失效。
 * 用例 5 审计事件对落盘：events.jsonl 含 hook.invoked + hook.result（log-only，stderr 截断）。
 * 全程仅本机回环与临时目录：无外呼、无真实密钥（mock provider 用占位假 key）。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemoryTransportPair, createRpcClient } from "../packages/rpc/src/index.ts";
import type { RpcClient } from "../packages/rpc/src/index.ts";
import { Storage } from "../packages/storage/src/index.ts";
import { createAgentServiceNode } from "../packages/server/src/index.ts";
import type { AgentServiceNode } from "../packages/server/src/index.ts";
import type { DoneEventPayload } from "../packages/shared/src/index.ts";
import { startMockLlmServer, textScript, toolCallFrame } from "./p0-lib.mts";
import type { MockLlmServer, SseScript } from "./p0-lib.mts";

// ---------------------------------------------------------------------------
// 场景装配
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

/** node -e 内联 hook 脚本（argv 执行不经 shell；跨平台）。 */
function nodeHookArgs(script: string): string[] {
  return ["-e", script];
}

function emitScript(output: unknown): string {
  return `process.stdout.write(JSON.stringify(${JSON.stringify(output)}))`;
}

async function startScenario(options?: { userHooks?: unknown; projectHooks?: unknown }): Promise<Scenario> {
  const home = await mkdtemp(join(tmpdir(), "raincode-smoke-hooks-"));
  const workspace = join(home, "ws");
  await mkdir(join(workspace, ".raincode"), { recursive: true });
  if (options?.userHooks !== undefined) {
    await writeFile(join(home, "hooks.json"), JSON.stringify(options.userHooks), "utf8");
  }
  if (options?.projectHooks !== undefined) {
    await writeFile(join(workspace, ".raincode", "hooks.json"), JSON.stringify(options.projectHooks), "utf8");
  }
  const mock = await startMockLlmServer();
  const transports = createInMemoryTransportPair();
  const node = await createAgentServiceNode(transports[1], {
    env: { RAINCODE_HOME: home },
    provider: {
      name: "mock-hooks",
      baseURL: mock.url,
      model: "mock-model",
      apiKey: "smoke-dummy-key",
      maxContextTokens: 8192,
    },
    tools: { approval: "always-allow" },
    permission: { policy: "default-allow" },
    hooks: {},
  });
  const client = createRpcClient({ transport: transports[0] });
  await client.call("system.ping", {});
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

/** 建会话 + 一次 send turn（订阅先于提交；done 即收敛）。 */
async function runTurn(scenario: Scenario, input: string): Promise<{ sessionId: string; done: DoneEventPayload }> {
  const sessionId = (
    await scenario.client.call<{ sessionId: string }>("session.create", {
      workspaceRoot: scenario.workspace,
      mode: "normal",
    })
  ).sessionId;
  const done = await new Promise<DoneEventPayload>((resolvePromise, rejectPromise) => {
    const offDone = scenario.client.onEvent("done", (payload) => {
      offDone();
      resolvePromise(payload as DoneEventPayload);
    });
    scenario.client
      .call("session.send", { sessionId, input: { text: input } })
      .catch((reason: unknown) => {
        offDone();
        rejectPromise(reason);
      });
  });
  return { sessionId, done };
}

/** 收集一次会话流内的 hook.completed 事件（订阅式投影断言入口）。 */
function subscribeHookCompleted(scenario: Scenario): { events: Array<Record<string, unknown>>; stop: () => void } {
  const events: Array<Record<string, unknown>> = [];
  const off = scenario.client.onEvent("hook.completed", (payload) => events.push(payload as Record<string, unknown>));
  return { events, stop: off };
}

/** 读会话 events.jsonl 原文（审计对落盘断言入口）。 */
async function readEventsJsonl(home: string, sessionId: string): Promise<string> {
  const storage = await Storage.open({ env: { RAINCODE_HOME: home } });
  try {
    const eventsFile = await storage.sessionEventsFile(sessionId);
    return await readFile(eventsFile, "utf8");
  } finally {
    await storage.close();
  }
}

// ---------------------------------------------------------------------------
// 用例 1：PreToolUse deny 真实拦截（N-3）
// ---------------------------------------------------------------------------

{
  console.log("· 用例 1 PreToolUse deny 真实拦截");
  const scenario = await startScenario({
    projectHooks: {
      hooks: {
        PreToolUse: [
          {
            matcher: "^write$",
            hooks: [
              {
                type: "command",
                command: process.execPath,
                args: nodeHookArgs(emitScript({ decision: "block", reason: "smoke: 禁止写文件" })),
              },
            ],
          },
        ],
      },
    },
  });
  try {
    const sessionId = (
      await scenario.client.call<{ sessionId: string }>("session.create", {
        workspaceRoot: scenario.workspace,
        mode: "normal",
      })
    ).sessionId;
    await scenario.client.call("hooks.trust.grant", { sessionId }); // project hook 须先授信
    const hooked = subscribeHookCompleted(scenario);
    scenario.setScript([
      {
        frames: [
          { choices: [{ index: 0, delta: { role: "assistant", content: "" } }] },
          toolCallFrame("call_1", "write", { path: "out.txt", content: "hello" }),
        ],
        finish: "tool_calls",
      },
      textScript("收到工具结果后收束"),
    ]);
    const done = await new Promise<DoneEventPayload>((resolvePromise, rejectPromise) => {
      const offDone = scenario.client.onEvent("done", (payload) => {
        offDone();
        resolvePromise(payload as DoneEventPayload);
      });
      scenario.client.call("session.send", { sessionId, input: { text: "写一个文件" } }).catch((reason: unknown) => {
        offDone();
        rejectPromise(reason);
      });
    });
    assert.equal(done.outcome, "completed", "拦截不炸 turn（工具收敛错误结果）");

    const completed = hooked.events[0];
    assert.ok(completed, "应收到 hook.completed rpc 事件");
    assert.equal(completed["phase"], "PreToolUse");
    assert.equal(completed["outcome"], "blocked");
    assert.equal(completed["reason"], "smoke: 禁止写文件");
    hooked.stop();

    const raw = await readEventsJsonl(scenario.home, sessionId);
    assert.ok(raw.includes('"name":"tool_call.completed"'));
    assert.ok(
      raw.includes("TOOL_HOOK_DENIED"),
      "工具结果应收敛 TOOL_HOOK_DENIED（hook 拦截先于权限：default-allow 政策下无审批拒绝来源）",
    );
    console.log("  ✔ 拦截 + TOOL_HOOK_DENIED + hook.completed(blocked)");
  } finally {
    await scenario.close();
  }
}

// ---------------------------------------------------------------------------
// 用例 2：additionalContext 注入下一回合（provenance 溯源）
// ---------------------------------------------------------------------------

{
  console.log("· 用例 2 additionalContext 注入（provenance）");
  const scenario = await startScenario({
    userHooks: {
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: "command",
                command: process.execPath,
                args: nodeHookArgs(emitScript({ additionalContext: "HOOKCTX-MARKER-42" })),
              },
            ],
          },
        ],
      },
    },
  });
  try {
    scenario.setScript([textScript("好的")]);
    const { done } = await runTurn(scenario, "你好");
    assert.equal(done.outcome, "completed");
    const body = scenario.mock.bodies[0];
    assert.ok(body !== undefined, "mock 收到请求");
    const injected = body.messages.find((message) => JSON.stringify(message).includes("HOOKCTX-MARKER-42"));
    assert.ok(injected, "additionalContext 应注入模型请求上下文");
    assert.match(
      JSON.stringify(injected),
      /\[hook:UserPromptSubmit via user:UserPromptSubmit:0\]/,
      "注入消息必须带 hookPhase + hookId provenance 标记",
    );
    console.log("  ✔ 注入 + provenance 标记（hookPhase/hookId）");
  } finally {
    await scenario.close();
  }
}

// ---------------------------------------------------------------------------
// 用例 3：超时与坏 JSON = failed 不阻塞主流程（stderr 截断）
// ---------------------------------------------------------------------------

{
  console.log("· 用例 3 超时/坏 JSON 容错");
  const scenario = await startScenario({
    userHooks: {
      hooks: {
        PreToolUse: [
          {
            hooks: [
              { // 超时 hook（timeoutMs 覆盖缺省 60s）
                type: "command",
                command: process.execPath,
                args: nodeHookArgs("setTimeout(() => {}, 30_000)"),
                timeoutMs: 400,
              },
              { // 坏 JSON + 超长 stderr（审计截断数据源）
                type: "command",
                command: process.execPath,
                args: nodeHookArgs("process.stderr.write('e'.repeat(900));process.stdout.write('not json')"),
              },
            ],
          },
        ],
      },
    },
  });
  try {
    const hooked = subscribeHookCompleted(scenario);
    scenario.setScript([
      {
        frames: [
          { choices: [{ index: 0, delta: { role: "assistant", content: "" } }] },
          toolCallFrame("call_1", "write", { path: "ok.txt", content: "data" }),
        ],
        finish: "tool_calls",
      },
      textScript("完成"),
    ]);
    const { sessionId, done } = await runTurn(scenario, "继续");
    assert.equal(done.outcome, "completed", "failed/timed_out 不阻塞 turn");

    const completed = hooked.events[0];
    assert.ok(completed);
    assert.equal(completed["outcome"], "timed_out", "聚合口径：timed_out 压过 failed/success");
    hooked.stop();

    const raw = await readEventsJsonl(scenario.home, sessionId);
    assert.ok(raw.includes('"name":"hook.result"'), "per hook 审计落盘");
    const resultLines = raw
      .split("\n")
      .filter((line) => line.includes('"name":"hook.result"'))
      .map((line) => JSON.parse(line) as { payload: { outcome: string; stderr: string } });
    assert.equal(resultLines.length, 2);
    const outcomes = resultLines.map((line) => line.payload.outcome).sort();
    assert.deepEqual(outcomes, ["failed", "timed_out"]);
    const failed = resultLines.find((line) => line.payload.outcome === "failed");
    assert.ok(failed !== undefined);
    assert.ok(failed.payload.stderr.length <= 500, "stderr 审计截断 ≤500 字符");
    assert.ok(
      raw.includes('"isError":false') || raw.includes('"role":"tool"'),
      "容错路径下工具照常执行落库",
    );
    console.log("  ✔ timed_out/failed 不阻塞 + hook.result stderr 截断");
  } finally {
    await scenario.close();
  }
}

// ---------------------------------------------------------------------------
// 用例 4：project hook 授信闭环（未授信跳过 → grant 生效 → revoke 立即失效）
// ---------------------------------------------------------------------------

{
  console.log("· 用例 4 project hook 授信闭环");
  const scenario = await startScenario({
    projectHooks: {
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: "command",
                command: process.execPath,
                args: nodeHookArgs(emitScript({ decision: "block", reason: "smoke: project hook 拒绝" })),
              },
            ],
          },
        ],
      },
    },
  });
  try {
    const hooked = subscribeHookCompleted(scenario);

    // 4a 未授信：hook 被跳过，turn 正常完成
    scenario.setScript([textScript("ok")]);
    const first = await runTurn(scenario, "第一问");
    assert.equal(first.done.outcome, "completed", "未授信 hook 跳过不阻塞");
    assert.equal(hooked.events[hooked.events.length - 1]!["outcome"], "skipped_untrusted");

    // 4b 授信后生效：UserPromptSubmit block → turn failed（HOOK_BLOCKED）
    await scenario.client.call("hooks.trust.grant", { sessionId: first.sessionId });
    const errorCodes: string[] = [];
    const offError = scenario.client.onEvent("error", (payload) => {
      const code = (payload as { code?: string })["code"];
      if (typeof code === "string") errorCodes.push(code);
    });
    scenario.setScript([textScript("不应到达")]);
    const second = await runTurn(scenario, "第二问");
    assert.equal(second.done.outcome, "failed", "授信后 hook block → turn failed");
    assert.ok(errorCodes.includes("HOOK_BLOCKED"), `error 事件应携带 HOOK_BLOCKED：${errorCodes.join(",")}`);
    offError();
    const blocked = hooked.events[hooked.events.length - 1]!;
    assert.equal(blocked["outcome"], "blocked");
    assert.equal(blocked["reason"], "smoke: project hook 拒绝");

    // 4c 撤销立即失效：下一 dispatch 恢复跳过
    await scenario.client.call("hooks.trust.revoke", { sessionId: second.sessionId });
    scenario.setScript([textScript("ok again")]);
    const third = await runTurn(scenario, "第三问");
    assert.equal(third.done.outcome, "completed", "撤销后立即未授信");
    assert.equal(hooked.events[hooked.events.length - 1]!["outcome"], "skipped_untrusted");
    hooked.stop();

    const raw = await readEventsJsonl(scenario.home, first.sessionId);
    assert.ok(
      raw.includes('"untrustedSkipped":1'),
      "hook.invoked 审计必须记录未授信跳过计数",
    );
    console.log("  ✔ 未授信跳过 → grant 生效（HOOK_BLOCKED）→ revoke 立即失效");
  } finally {
    await scenario.close();
  }
}

// ---------------------------------------------------------------------------
// 用例 5：审计事件对落盘（hook.invoked + hook.result，log-only 形态）
// ---------------------------------------------------------------------------

{
  console.log("· 用例 5 审计事件对落盘");
  const scenario = await startScenario({
    userHooks: {
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: process.execPath,
                args: nodeHookArgs(emitScript({ systemMessage: "收尾提醒" })),
              },
            ],
          },
        ],
      },
    },
  });
  try {
    scenario.setScript([textScript("结束")]);
    const { sessionId } = await runTurn(scenario, "收尾");
    const raw = await readEventsJsonl(scenario.home, sessionId);
    const invoked = raw.split("\n").filter((line) => line.includes('"name":"hook.invoked"'));
    const result = raw.split("\n").filter((line) => line.includes('"name":"hook.result"'));
    assert.equal(invoked.length, 1, "Stop hook 一次 dispatch 一条 hook.invoked");
    assert.equal(result.length, 1, "一个 hook 进程一条 hook.result");
    const invokedPayload = JSON.parse(invoked[0]!) as { payload: { phase: string; hooks: unknown[] } };
    assert.equal(invokedPayload.payload.phase, "Stop");
    assert.equal(invokedPayload.payload.hooks.length, 1);
    console.log("  ✔ hook.invoked + hook.result 落盘（JSONL log-only）");
  } finally {
    await scenario.close();
  }
}

// ---------------------------------------------------------------------------
// 附加：hooks.list 控制面 + 未装配域行为
// ---------------------------------------------------------------------------

{
  console.log("· 附加 hooks.list 与协议防漂移");
  const scenario = await startScenario({
    userHooks: { hooks: { Stop: [{ hooks: [{ type: "command", command: "x" }] }] } },
  });
  try {
    const sessionId = (
      await scenario.client.call<{ sessionId: string }>("session.create", {
        workspaceRoot: scenario.workspace,
        mode: "normal",
      })
    ).sessionId;
    const list = await scenario.client.call<{ items: Array<{ source: string; loaded: boolean; hookCount: number }> }>(
      "hooks.list",
      { sessionId },
    );
    assert.equal(list.items.length, 2, "user + project 双源投影");
    assert.equal(list.items[0]!.source, "user");
    assert.equal(list.items[0]!.loaded, true);
    assert.equal(list.items[0]!.hookCount, 1);
    assert.equal(list.items[1]!.source, "project");
    assert.equal(list.items[1]!.trusted, false, "project 源缺省未授信");
    console.log("  ✔ hooks.list 双源投影 + 授信状态");
  } finally {
    await scenario.close();
  }
}

console.log("\nsmoke:hooks 全部通过（5 验收用例 + 控制面附加用例）");
