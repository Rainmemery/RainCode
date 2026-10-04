/**
 * HookDispatcher 单测（T5.1）：fake HooksPort 驱动——
 * 事件投影（hook.started/hook.completed 配对、skipped_untrusted 口径）、
 * 审计对（hook.invoked 计划 + hook.result per hook、stderr 截断 ≤500）、
 * additionalContext provenance 缓冲（drain 排空语义）、
 * 热路径护栏（无 hook 配置零事件零审计）、port 缺省/抛错 no-op 收敛。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HookDispatcher, emptyHookDispatchResult } from "../src/hooks/dispatcher.js";
import type { HookContextEntry, HookDispatchRequest, HookDispatchResult, HookRunResult, HooksPort } from "../src/hooks/types.js";

// ---------------------------------------------------------------------------
// Fake port：预置返回值（可注入抛错）
// ---------------------------------------------------------------------------

function runOf(partial: Partial<HookRunResult>): HookRunResult {
  return {
    hookId: "user:PreToolUse:0",
    event: "PreToolUse",
    outcome: "success",
    exitCode: 0,
    durationMs: 5,
    stderr: "",
    stdout: "{}",
    ...partial,
  };
}

function resultOf(partial: Partial<HookDispatchResult>): HookDispatchResult {
  return { blocked: false, suppressOutput: false, hookIds: [], plan: [], untrustedSkipped: 0, runs: [], ...partial };
}

class FakePort implements HooksPort {
  lastRequest: HookDispatchRequest | null = null;
  constructor(private readonly impl: (request: HookDispatchRequest) => HookDispatchResult | Promise<HookDispatchResult>) {}
  dispatch(request: HookDispatchRequest): Promise<HookDispatchResult> {
    this.lastRequest = request;
    return Promise.resolve(this.impl(request));
  }
}

interface Emitted {
  name: string;
  payload: Record<string, unknown>;
}

function makeDispatcher(port: HooksPort | null) {
  const persisted: Emitted[] = [];
  const audits: Emitted[] = [];
  const dispatcher = new HookDispatcher({
    port,
    sessionId: "s1",
    emitPersisted: (name, build) => persisted.push({ name, payload: build(1, 0) as Record<string, unknown> }),
    emitAudit: (name, build) => audits.push({ name, payload: build(1, 0) as Record<string, unknown> }),
  });
  return { dispatcher, persisted, audits };
}

const BASE: HookDispatchRequest = { event: "PreToolUse", sessionId: "s1", turnId: "turn_1" };

describe("HookDispatcher · 事件投影与审计对（T5.1）", () => {
  it("正常 dispatch：started/completed 配对 + invoked/result 审计（stderr 截断 ≤500）", async () => {
    const port = new FakePort(() =>
      resultOf({
        hookIds: ["user:PreToolUse:0"],
        plan: [{ hookId: "user:PreToolUse:0", source: "user", command: "node", args: ["-e", "1"], async: false }],
        runs: [runOf({ stderr: "x".repeat(800) })],
      }),
    );
    const { dispatcher, persisted, audits } = makeDispatcher(port);
    const result = await dispatcher.run(BASE);
    assert.equal(result.blocked, false);

    assert.deepEqual(persisted.map((e) => e.name), ["hook.started", "hook.completed"]);
    assert.equal(persisted[0]!.payload["phase"], "PreToolUse");
    assert.deepEqual(persisted[0]!.payload["hookIds"], ["user:PreToolUse:0"]);
    assert.equal(persisted[1]!.payload["outcome"], "success");

    assert.deepEqual(audits.map((e) => e.name), ["hook.invoked", "hook.result"]);
    assert.equal(audits[0]!.payload["untrustedSkipped"], 0);
    const stderr = audits[1]!.payload["stderr"] as string;
    assert.equal(stderr.length, 500, "stderr 必须截断到 500 字符落盘");
  });

  it("blocked 聚合：completed outcome=blocked + decision=block + reason", async () => {
    const port = new FakePort(() =>
      resultOf({
        blocked: true,
        reason: "禁止删除 main 分支",
        hookIds: ["user:PreToolUse:0"],
        plan: [{ hookId: "user:PreToolUse:0", source: "user", command: "x", async: false }],
        runs: [runOf({ outcome: "blocked", reason: "禁止删除 main 分支" })],
      }),
    );
    const { dispatcher, persisted } = makeDispatcher(port);
    const result = await dispatcher.run(BASE);
    assert.equal(result.blocked, true);
    assert.equal(persisted[1]!.payload["outcome"], "blocked");
    assert.equal(persisted[1]!.payload["decision"], "block");
    assert.equal(persisted[1]!.payload["reason"], "禁止删除 main 分支");
  });

  it("skipped_untrusted：runs 为空且 untrustedSkipped>0 → completed 口径正确", async () => {
    const port = new FakePort(() =>
      resultOf({ untrustedSkipped: 2, plan: [] }),
    );
    const { dispatcher, persisted, audits } = makeDispatcher(port);
    await dispatcher.run(BASE);
    assert.equal(persisted[1]!.payload["outcome"], "skipped_untrusted");
    assert.deepEqual(audits.map((e) => e.name), ["hook.invoked"], "未执行进程时无 result 审计");
  });

  it("additionalContext → provenance 缓冲，drain 排空后为空", async () => {
    const port = new FakePort(() =>
      resultOf({
        hookIds: ["user:UserPromptSubmit:0"],
        plan: [{ hookId: "user:UserPromptSubmit:0", source: "user", command: "x", async: false }],
        runs: [runOf({ additionalContext: "先查记忆库" })],
        additionalContext: "先查记忆库", // 聚合属 port（HooksRuntime）职责；dispatcher 消费聚合结果
      }),
    );
    const { dispatcher, persisted } = makeDispatcher(port);
    await dispatcher.run({ ...BASE, event: "UserPromptSubmit", prompt: "hi" });
    assert.equal(persisted[1]!.payload["contextInjected"], true);

    const drained: HookContextEntry[] = dispatcher.drainContext();
    assert.equal(drained.length, 1);
    assert.equal(drained[0]!.phase, "UserPromptSubmit");
    assert.deepEqual(drained[0]!.hookIds, ["user:UserPromptSubmit:0"]);
    assert.equal(drained[0]!.text, "先查记忆库");
    assert.equal(dispatcher.drainContext().length, 0, "排空后缓冲为空");
  });

  it("热路径护栏：plan 空且无 untrusted → 零事件零审计", async () => {
    const port = new FakePort(() => resultOf({}));
    const { dispatcher, persisted, audits } = makeDispatcher(port);
    const result = await dispatcher.run(BASE);
    assert.deepEqual(result, emptyHookDispatchResult);
    assert.equal(persisted.length, 0);
    assert.equal(audits.length, 0);
  });

  it("port 缺省（null）与 port 抛错均 no-op 收敛（引擎永不抛）", async () => {
    const none = makeDispatcher(null);
    assert.deepEqual(await none.dispatcher.run(BASE), emptyHookDispatchResult);
    assert.equal(none.persisted.length, 0);

    const throwing = new FakePort(() => {
      throw new Error("boom");
    });
    const crashed = makeDispatcher(throwing);
    assert.deepEqual(await crashed.dispatcher.run(BASE), emptyHookDispatchResult);
    assert.equal(crashed.persisted.length, 0);
  });
});
