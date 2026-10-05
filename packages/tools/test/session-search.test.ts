/**
 * session_search 工具单测（T5.3）：
 * - 命中格式化（裁剪候选）：逐条单行化 + 片段截断 160+…、头部计数、sessionId/日期出处行；
 * - 空结果占位文本「未找到匹配的历史记录。」（不注入假数据，同 memory 召回口径）；
 * - ctx.searchHistory 缺省 → TOOL_UNAVAILABLE（同 ask_user/skill fail-safe 口径）；
 * - 通道 !ok → 域码/消息原样投影（TOOL_EXEC_FAILED 收敛进 ToolResult.error）；
 * - 通道请求载荷：query/limit 透传（limit 缺省不携带）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sessionSearchTool } from "../src/handlers/session-search.js";
import { ToolExecutor, ToolRegistry } from "../src/index.js";
import type { SessionHistorySearchResult, ToolExecutionContext } from "../src/index.js";
import { BackgroundTaskRegistry } from "../src/sandbox/background.js";

const WORKSPACE = process.cwd();

function baseCtx(searchHistory?: ToolExecutionContext["searchHistory"]): ToolExecutionContext {
  return {
    signal: new AbortController().signal,
    workspaceRoot: WORKSPACE,
    cwd: WORKSPACE,
    sessionKey: "test",
    background: new BackgroundTaskRegistry(),
    ...(searchHistory !== undefined && { searchHistory }),
  };
}

const HITS = [
  { sessionId: "session_a", role: "user", kind: "text" as const, content: "讨论了 renderer 冷启动问题", ts: 1759363200000 },
  {
    sessionId: "session_b",
    role: "assistant",
    kind: "text" as const,
    content: `${"很长".repeat(200)}\n第二行`,
    ts: 1759449600000,
  },
];

describe("session_search 工具（T5.3）", () => {
  it("命中格式化：单行化 + 截断 + 出处行", async () => {
    const seen: Array<{ query: string; limit?: number }> = [];
    const output = await sessionSearchTool.execute(
      { query: "冷启动", limit: 5 },
      baseCtx(async (req) => {
        seen.push(req);
        return { ok: true, hits: HITS };
      }),
    );
    assert.deepEqual(seen, [{ query: "冷启动", limit: 5 }], "query/limit 透传");
    assert.equal(output.data.hits.length, 2);
    assert.ok(output.content!.includes("共 2 条历史命中"));
    assert.ok(output.content!.includes("session_a"), "sessionId 出处");
    assert.ok(output.content!.includes("讨论了 renderer 冷启动问题"), "短命中全文");
    const longLine = output.content!.split("\n").find((line) => line.includes("很长"));
    assert.ok(longLine !== undefined && !longLine.includes("第二行"), "片段单行化");
    assert.ok((longLine!.match(/…$/g) ?? []).length === 1, "超长截断以 … 收尾");
  });

  it("空结果：占位文本（不注入假数据）", async () => {
    const output = await sessionSearchTool.execute(
      { query: "zzz" },
      baseCtx(async () => ({ ok: true, hits: [] })),
    );
    assert.equal(output.content, "未找到匹配的历史记录。");
  });

  it("通道缺省 → TOOL_UNAVAILABLE", async () => {
    const registry = new ToolRegistry();
    registry.register(sessionSearchTool);
    const result = await new ToolExecutor({ registry }).execute(
      { toolCallId: "t1", toolName: "session_search", args: { query: "冷启动" } },
      baseCtx(),
    );
    assert.equal(result.isError, true);
    assert.equal(result.error?.code, "TOOL_UNAVAILABLE");
    assert.ok(result.error?.message.includes("search channel not assembled"));
  });

  it("通道 !ok → 域码投影收敛 ToolResult.error", async () => {
    const registry = new ToolRegistry();
    registry.register(sessionSearchTool);
    const failing: SessionHistorySearchResult = { ok: false, code: "TOOL_EXEC_FAILED", message: "boom" };
    const result = await new ToolExecutor({ registry }).execute(
      { toolCallId: "t2", toolName: "session_search", args: { query: "x" } },
      baseCtx(async () => failing),
    );
    assert.equal(result.isError, true);
    assert.equal(result.error?.code, "TOOL_EXEC_FAILED");
    assert.equal(result.error?.message, "boom");
  });

  it("limit 缺省不携带（通道侧走缺省 8）", async () => {
    const seen: Array<{ query: string; limit?: number }> = [];
    await sessionSearchTool.execute(
      { query: "关键词" },
      baseCtx(async (req) => {
        seen.push(req);
        return { ok: true, hits: [] };
      }),
    );
    assert.deepEqual(seen, [{ query: "关键词" }]);
  });
});
