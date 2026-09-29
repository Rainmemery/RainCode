/**
 * ask_user_question 工具单测（T2.7 任务 2 · 02-module-design §2.3/§1.4 L322 简化落地）。
 * - ctx.askUser 注入（mock 通道）→ execute 返回 answerText 作为 content；
 * - 通道缺失（headless）→ TOOL_UNAVAILABLE；cancelled（拒绝/超时）→ TOOL_PERMISSION_DENIED；
 * - choices 透传通道 + 会话归属字段由 ctx 填充；
 * - ToolExecutor 链路：ToolExecutionError 映射为 isError 结果（通道缺失场景）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { askUserTool, ToolExecutor, ToolRegistry } from "../src/index.js";
import { ToolExecutionError } from "../src/index.js";
import { TOOL_ERROR_CODES } from "@raincode/shared";
import type { BackgroundTaskRegistry, ToolExecutionContext, ToolRunContext } from "../src/index.js";

function makeCtx(overrides?: Partial<ToolExecutionContext>): ToolExecutionContext {
  return {
    signal: new AbortController().signal,
    workspaceRoot: "/tmp/ws",
    cwd: "/tmp/ws",
    sessionKey: "session-42",
    background: {} as BackgroundTaskRegistry,
    ...overrides,
  };
}

describe("ask_user_question（02 §1.4 L322 简化落地：等答与审批同构）", () => {
  it("通道正常应答：content = answerText，data 携带应答与 choices", async () => {
    const seen: unknown[] = [];
    const ctx = makeCtx({
      askUser: async (question) => {
        seen.push(question);
        return { answerText: "用方案 A" };
      },
    });
    const output = await askUserTool.execute(
      { question: "选哪个方案？", choices: ["方案 A", "方案 B"] },
      ctx,
    );
    assert.equal(output.content, "用方案 A");
    assert.equal(output.data.answer, "用方案 A");
    assert.deepEqual(output.data.choices, ["方案 A", "方案 B"]);
    assert.deepEqual(seen[0], {
      question: "选哪个方案？",
      choices: ["方案 A", "方案 B"],
      sessionId: "session-42",
    });
  });

  it("自由文本应答（无 choices）：content = answerText", async () => {
    const ctx = makeCtx({ askUser: async () => ({ answerText: "直接发版吧" }) });
    const output = await askUserTool.execute({ question: "可以发版吗？" }, ctx);
    assert.equal(output.content, "直接发版吧");
    assert.equal(output.data.choices, undefined);
  });

  it("ctx.askUser 缺失（headless）→ TOOL_UNAVAILABLE", async () => {
    await assert.rejects(
      askUserTool.execute({ question: "在吗？" }, makeCtx()),
      (err: unknown) =>
        err instanceof ToolExecutionError && err.code === TOOL_ERROR_CODES.UNAVAILABLE,
    );
  });

  it("cancelled（拒绝/超时）→ TOOL_PERMISSION_DENIED", async () => {
    const ctx = makeCtx({ askUser: async () => ({ cancelled: true }) });
    await assert.rejects(
      askUserTool.execute({ question: "在吗？" }, ctx),
      (err: unknown) =>
        err instanceof ToolExecutionError && err.code === TOOL_ERROR_CODES.PERMISSION_DENIED,
    );
  });

  it("ToolExecutor 链路：通道缺失 → isError 结果 TOOL_UNAVAILABLE（不影响其余调用）", async () => {
    const registry = new ToolRegistry();
    registry.register(askUserTool);
    const executor = new ToolExecutor({ registry });
    const results = await executor.runBatch(
      [{ toolCallId: "c1", toolName: "ask_user_question", args: { question: "继续吗？" } }],
      {
        signal: new AbortController().signal,
        workspaceRoot: "/tmp/ws",
        cwd: "/tmp/ws",
        sessionKey: "s",
        background: {} as BackgroundTaskRegistry,
      } satisfies ToolRunContext,
    );
    assert.equal(results.length, 1);
    assert.equal(results[0]!.isError, true);
    assert.equal(results[0]!.error?.code, TOOL_ERROR_CODES.UNAVAILABLE);
  });

  it("入参校验：choices 超过 6 项 → INVALID_INPUT（不进执行）", () => {
    const parsed = askUserTool.parametersSchema.safeParse({
      question: "q",
      choices: ["1", "2", "3", "4", "5", "6", "7"],
    });
    assert.equal(parsed.success, false);
  });
});
