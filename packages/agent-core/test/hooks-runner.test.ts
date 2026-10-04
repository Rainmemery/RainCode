/**
 * HookRunner 单测矩阵（T5.1 · 06-api-spec §2.12）：
 * stdout JSON 契约全形态（block 三来源 / additionalContext / systemMessage / suppressOutput /
 * exit 2 显式 block / 空 stdout no-op / 非 JSON failed / schema 不符 failed / 非零退出 failed /
 * 超时 timed_out / stdin 输入回读 / 字节上限截断）。
 * hook 子进程全部以 node -e 内联脚本承载（跨平台；argv 执行不经 shell）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import process from "node:process";
import { runHook, DEFAULT_HOOK_TIMEOUT_MS } from "../src/hooks/runner.js";
import type { HookCommand } from "@raincode/shared";

/** node -e 内联 hook 脚本命令（argv 形态，无 shell 拼接）。 */
function nodeHook(script: string, extra?: Partial<HookCommand>): HookCommand {
  return {
    type: "command",
    command: process.execPath,
    args: ["-e", script],
    ...extra,
  };
}

/** 输出 JSON 到 stdout 的 hook 脚本模板。 */
function emitHook(output: unknown): HookCommand {
  return nodeHook(`process.stdout.write(JSON.stringify(${JSON.stringify(output)}))`);
}

const BASE_INPUT = { event: "PreToolUse" as const, sessionId: "s1", turnId: "t1" };

describe("HookRunner · stdout JSON 契约（T5.1）", () => {
  it("decision:block → blocked + reason 透传", async () => {
    const run = await runHook({
      hook: emitHook({ decision: "block", reason: "禁止删除 main 分支" }),
      hookId: "user:PreToolUse:0",
      event: "PreToolUse",
      input: BASE_INPUT,
    });
    assert.equal(run.outcome, "blocked");
    assert.equal(run.reason, "禁止删除 main 分支");
    assert.equal(run.exitCode, 0);
    assert.ok(run.durationMs >= 0);
  });

  it("continue:false → blocked（CC 兼容语义）", async () => {
    const run = await runHook({
      hook: emitHook({ continue: false, reason: "stop here" }),
      hookId: "h",
      event: "PreToolUse",
      input: BASE_INPUT,
    });
    assert.equal(run.outcome, "blocked");
    assert.equal(run.reason, "stop here");
  });

  it("hookSpecificOutput.permissionDecision:deny → blocked + permissionDecisionReason", async () => {
    const run = await runHook({
      hook: emitHook({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Blocked by project hook." } }),
      hookId: "h",
      event: "PreToolUse",
      input: BASE_INPUT,
    });
    assert.equal(run.outcome, "blocked");
    assert.equal(run.reason, "Blocked by project hook.");
  });

  it("additionalContext / systemMessage / suppressOutput 全部捕获", async () => {
    const run = await runHook({
      hook: emitHook({
        additionalContext: "使用内部 API 迁移清单",
        systemMessage: "提醒：先跑测试",
        suppressOutput: true,
      }),
      hookId: "h",
      event: "UserPromptSubmit",
      input: BASE_INPUT,
    });
    assert.equal(run.outcome, "success");
    assert.equal(run.additionalContext, "使用内部 API 迁移清单");
    assert.equal(run.systemMessage, "提醒：先跑测试");
    assert.equal(run.suppressOutput, true);
  });

  it("空 stdout = no-op success（exit 0）", async () => {
    const run = await runHook({
      hook: nodeHook("/* no output */"),
      hookId: "h",
      event: "Stop",
      input: BASE_INPUT,
    });
    assert.equal(run.outcome, "success");
    assert.equal(run.stdout, "");
  });

  it("exit code 2 = 显式 block（CC 兼容，即便无 stdout）", async () => {
    const run = await runHook({
      hook: nodeHook("process.exit(2)"),
      hookId: "h",
      event: "PreToolUse",
      input: BASE_INPUT,
    });
    assert.equal(run.outcome, "blocked");
    assert.equal(run.exitCode, 2);
    assert.match(run.reason ?? "", /code 2/);
  });

  it("非 JSON stdout → failed（不阻塞主流程口径）", async () => {
    const run = await runHook({
      hook: nodeHook("process.stdout.write('not json')"),
      hookId: "h",
      event: "PreToolUse",
      input: BASE_INPUT,
    });
    assert.equal(run.outcome, "failed");
    assert.match(run.reason ?? "", /not valid hook-output JSON/);
  });

  it("schema 不符（未知字段，strict）→ failed", async () => {
    const run = await runHook({
      hook: emitHook({ decision: "approve", evilField: 1 }),
      hookId: "h",
      event: "PreToolUse",
      input: BASE_INPUT,
    });
    assert.equal(run.outcome, "failed");
    assert.match(run.reason ?? "", /not valid hook-output JSON/);
  });

  it("其余非零退出码（stdout 空）→ failed", async () => {
    const run = await runHook({
      hook: nodeHook("process.exit(1)"),
      hookId: "h",
      event: "PreToolUse",
      input: BASE_INPUT,
    });
    assert.equal(run.outcome, "failed");
    assert.equal(run.exitCode, 1);
  });

  it("超时 → timed_out 且进程被终止（timeoutMs 覆盖缺省 60s）", async () => {
    const run = await runHook({
      hook: nodeHook("setTimeout(() => {}, 30_000)", { timeoutMs: 300 }),
      hookId: "h",
      event: "PreToolUse",
      input: BASE_INPUT,
      onDiagnostic: () => undefined,
    });
    assert.equal(run.outcome, "timed_out");
    assert.ok(run.durationMs < 10_000);
    assert.match(run.reason ?? "", /timed out/);
  });

  it("stdin 输入回读：hook 收到 JSON 事件输入", async () => {
    let captured = "";
    const run = await runHook({
      hook: nodeHook("let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(d))"),
      hookId: "h",
      event: "PreToolUse",
      input: { ...BASE_INPUT, toolName: "bash", toolInput: { command: "rm -rf /" } },
    });
    captured = run.stdout;
    const parsed = JSON.parse(captured) as { event: string; toolName: string; toolInput: { command: string } };
    assert.equal(parsed.event, "PreToolUse");
    assert.equal(parsed.toolName, "bash");
    assert.equal(parsed.toolInput.command, "rm -rf /");
  });

  it("stderr 捕获（供审计截断落盘）", async () => {
    const run = await runHook({
      hook: nodeHook("process.stderr.write('boom detail');process.exit(1)"),
      hookId: "h",
      event: "PreToolUse",
      input: BASE_INPUT,
    });
    assert.equal(run.outcome, "failed");
    assert.equal(run.stderr, "boom detail");
  });

  it("不可执行命令 → failed（引擎永不抛）", async () => {
    const run = await runHook({
      hook: { type: "command", command: "definitely-not-a-real-binary-xyz" },
      hookId: "h",
      event: "PreToolUse",
      input: BASE_INPUT,
    });
    assert.equal(run.outcome, "failed");
    assert.ok((run.reason ?? "").length > 0);
  });

  it("缺省 timeoutMs = 60000（ZCode 口径常量）", () => {
    assert.equal(DEFAULT_HOOK_TIMEOUT_MS, 60_000);
  });
});
