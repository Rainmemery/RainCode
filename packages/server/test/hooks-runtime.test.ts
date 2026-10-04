/**
 * HooksRuntime 单测矩阵（T5.1 · 06-api-spec §2.12）：
 * 双源装载（无配置 fast path / user 源生效 / 坏文件降级 / stat 缓存重验）、
 * project trust 授信闭环（未授信跳过 → grant 生效 → revoke 立即失效 → 文件改动 digest 失效）、
 * matcher 语义（toolName 匹配与不匹配）、hooks.list 投影、async hook 补审计。
 * hook 子进程以 node -e 内联脚本承载；Storage.open 真库 + 临时 RAINCODE_HOME。
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { Storage } from "@raincode/storage";
import { HooksRuntime } from "../src/hooks-runtime.js";

const homes: string[] = [];
const storages: Storage[] = [];
afterEach(async () => {
  for (const storage of storages.splice(0)) {
    await storage.close().catch(() => undefined);
  }
  for (const home of homes.splice(0)) {
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
  }
});

function nodeHookScript(output: unknown): string {
  return `process.stdout.write(JSON.stringify(${JSON.stringify(output)}))`;
}

/** 场景装配：临时 home（user 源根）+ workspace（project 源根）+ 已建会话的 runtime。 */
async function scenario(options?: { userHooks?: unknown; projectHooks?: unknown }) {
  const home = await mkdtemp(join(tmpdir(), "raincode-hooks-"));
  const workspace = await mkdtemp(join(tmpdir(), "raincode-ws-"));
  homes.push(home, workspace);
  if (options?.userHooks !== undefined) {
    await writeFile(join(home, "hooks.json"), JSON.stringify(options.userHooks), "utf8");
  }
  if (options?.projectHooks !== undefined) {
    await mkdir(join(workspace, ".raincode"), { recursive: true });
    await writeFile(join(workspace, ".raincode", "hooks.json"), JSON.stringify(options.projectHooks), "utf8");
  }
  const storage = await Storage.open({ dataRoot: home });
  storages.push(storage);
  const ws = await storage.ensureWorkspace(workspace);
  const meta = await storage.createSession({ workspaceHash: ws.hash, workspaceRoot: workspace, title: "t", mode: "normal" });
  const diagnostics: string[] = [];
  const runtime = new HooksRuntime({
    dataRoot: home,
    storage,
    workspaceRootOf: (sessionId) => storage.workspaceRootOf(sessionId),
    onDiagnostic: (message) => diagnostics.push(message),
  });
  return { home, workspace, storage, sessionId: meta.id, runtime, diagnostics };
}

const PRE = { event: "PreToolUse" as const, sessionId: "", turnId: "turn_1", toolName: "bash", toolInput: { command: "git push --force" } };

describe("HooksRuntime · 双源装载与 dispatch（T5.1）", () => {
  it("无任何 hooks.json：dispatch fast-path（plan 空 + 零 runs）", async () => {
    const { sessionId, runtime } = await scenario();
    const result = await runtime.port.dispatch({ ...PRE, sessionId });
    assert.equal(result.plan.length, 0);
    assert.equal(result.runs.length, 0);
    assert.equal(result.blocked, false);
  });

  it("user 源 hook 生效：additionalContext 聚合回传 + 计划明细", async () => {
    const { sessionId, runtime } = await scenario({
      userHooks: { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: process.execPath, args: ["-e", nodeHookScript({ additionalContext: "先查记忆库" })] }] }] } },
    });
    const result = await runtime.port.dispatch({ event: "UserPromptSubmit", sessionId, turnId: "turn_1", prompt: "你好" });
    assert.equal(result.plan.length, 1);
    assert.equal(result.plan[0]!.hookId, "user:UserPromptSubmit:0");
    assert.equal(result.additionalContext, "先查记忆库");
    assert.equal(result.runs.length, 1);
    assert.equal(result.runs[0]!.outcome, "success");
  });

  it("PreToolUse block：decision block → blocked + reason（deny 拦截数据源）", async () => {
    const { sessionId, runtime } = await scenario({
      userHooks: { hooks: { PreToolUse: [{ hooks: [{ type: "command", command: process.execPath, args: ["-e", nodeHookScript({ decision: "block", reason: "禁止 force push" })] }] }] } },
    });
    const result = await runtime.port.dispatch({ ...PRE, sessionId });
    assert.equal(result.blocked, true);
    assert.equal(result.reason, "禁止 force push");
  });

  it("matcher：PreToolUse matcher 限定 toolName，不匹配则跳过", async () => {
    const { sessionId, runtime } = await scenario({
      userHooks: { hooks: { PreToolUse: [{ matcher: "^write$", hooks: [{ type: "command", command: process.execPath, args: ["-e", nodeHookScript({ decision: "block" })] }] }] } },
    });
    const hit = await runtime.port.dispatch({ ...PRE, sessionId, toolName: "write" });
    assert.equal(hit.blocked, true);
    const miss = await runtime.port.dispatch({ ...PRE, sessionId, toolName: "bash" });
    assert.equal(miss.blocked, false);
    assert.equal(miss.plan.length, 0);
  });

  it("坏 hooks.json 降级：dispatch 不炸 + hooks.list error 注记", async () => {
    const { home, sessionId, runtime, diagnostics } = await scenario();
    await writeFile(join(home, "hooks.json"), "{ broken", "utf8");
    const result = await runtime.port.dispatch({ ...PRE, sessionId });
    assert.equal(result.blocked, false);
    assert.ok(diagnostics.some((line) => line.includes("hooks config")), "坏文件必须产诊断");
    const handlers = runtime.methods((_method, handler) => handler) as Record<string, (params: unknown) => Promise<unknown>>;
    const list = (await handlers["hooks.list"]!({})) as { items: Array<{ loaded: boolean; error?: string }> };
    assert.equal(list.items[0]!.loaded, false);
    assert.ok(list.items[0]!.error !== undefined);
  });
});

describe("HooksRuntime · project trust 授信闭环（T5.1 验收核心）", () => {
  const projectHooks = {
    hooks: { PreToolUse: [{ hooks: [{ type: "command", command: process.execPath, args: ["-e", nodeHookScript({ decision: "block", reason: "project deny" })] }] }] },
  };

  it("未授信 → 跳过（untrustedSkipped）；grant 后生效；revoke 立即失效", async () => {
    const { sessionId, runtime } = await scenario({ projectHooks });

    const before = await runtime.port.dispatch({ ...PRE, sessionId });
    assert.equal(before.blocked, false);
    assert.equal(before.untrustedSkipped, 1, "project hook 未授信必须被跳过");
    assert.equal(before.runs.length, 0);

    const handlers = runtime.methods((_method, handler) => handler) as Record<string, (params: unknown) => Promise<unknown>>;
    const grant = (await handlers["hooks.trust.grant"]!({ sessionId })) as { digest: string; hookCount: number };
    assert.equal(grant.hookCount, 1);

    const granted = await runtime.port.dispatch({ ...PRE, sessionId });
    assert.equal(granted.blocked, true, "授信后 project hook 立即生效");
    assert.equal(granted.reason, "project deny");
    assert.equal(granted.untrustedSkipped, 0);

    await handlers["hooks.trust.revoke"]!({ sessionId });
    const revoked = await runtime.port.dispatch({ ...PRE, sessionId });
    assert.equal(revoked.blocked, false, "撤销后下一 dispatch 立即未授信");
    assert.equal(revoked.untrustedSkipped, 1);
  });

  it("授信绑定配置 digest：文件改动后授信失效（须重新授信）", async () => {
    const { workspace, sessionId, runtime } = await scenario({ projectHooks });
    const handlers = runtime.methods((_method, handler) => handler) as Record<string, (params: unknown) => Promise<unknown>>;
    await handlers["hooks.trust.grant"]!({ sessionId });
    const granted = await runtime.port.dispatch({ ...PRE, sessionId });
    assert.equal(granted.blocked, true);

    // 改文件（内容变化 → digest 变化 → 授信失效）
    await mkdir(join(workspace, ".raincode"), { recursive: true });
    await writeFile(
      join(workspace, ".raincode", "hooks.json"),
      JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: process.execPath, args: ["-e", nodeHookScript({ additionalContext: "v2" })] }] }] } }),
      "utf8",
    );
    const after = await runtime.port.dispatch({ ...PRE, sessionId });
    assert.equal(after.blocked, false, "digest 失效 → 未授信跳过");
    assert.equal(after.untrustedSkipped, 1);
  });

  it("hooks.list：project 源投影授信状态（trusted/trustedDigest）", async () => {
    const { sessionId, runtime } = await scenario({ projectHooks });
    const handlers = runtime.methods((_method, handler) => handler) as Record<string, (params: unknown) => Promise<unknown>>;
    const before = (await handlers["hooks.list"]!({ sessionId })) as { items: Array<{ trusted?: boolean }> };
    assert.equal(before.items[1]!.trusted, false);
    const grant = (await handlers["hooks.trust.grant"]!({ sessionId })) as { digest: string };
    const after = (await handlers["hooks.list"]!({ sessionId })) as { items: Array<{ trusted?: boolean; trustedDigest?: string }> };
    assert.equal(after.items[1]!.trusted, true);
    assert.equal(after.items[1]!.trustedDigest, grant.digest);
  });

  it("grant 无 project 配置 → HOOKS_CONFIG_INVALID 拒绝", async () => {
    const { sessionId, runtime } = await scenario();
    const handlers = runtime.methods((_method, handler) => handler) as Record<string, (params: unknown) => Promise<unknown>>;
    await assert.rejects(
      () => handlers["hooks.trust.grant"]!({ sessionId }),
      (err: Error) => (err as Error & { code?: string }).code === "HOOKS_CONFIG_INVALID",
    );
  });
});

describe("HooksRuntime · async hook（T5.1 command 类型 async 形态）", () => {
  it("async hook 触发即返（不进 runs），完成后经 onAsyncResult 补记", async () => {
    const { sessionId, runtime } = await scenario({
      userHooks: {
        hooks: {
          Stop: [
            { hooks: [{ type: "command", command: process.execPath, args: ["-e", nodeHookScript({ additionalContext: "async ctx" })], async: true }] },
          ],
        },
      },
    });
    const results: unknown[] = [];
    const result = await runtime.port.dispatch({
      event: "Stop", sessionId, turnId: "turn_1", stopHookActive: false,
      onAsyncResult: (run) => results.push(run),
    });
    assert.equal(result.plan.length, 1);
    assert.equal(result.runs.length, 0, "async hook 不阻塞 dispatch");
    assert.equal(result.hookIds.length, 0, "async hook 不进同步 hookIds");
    for (let i = 0; i < 100 && results.length === 0; i += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
    assert.equal(results.length, 1, "async 完成后补记审计");
    assert.equal((results[0] as { outcome: string }).outcome, "success");
  });
});
