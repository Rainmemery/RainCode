/**
 * mcp_tool_search 工具单测（T5.6）：
 * - 命中格式化：排名列表 + score + 「下一轮可调用」指引；空结果占位文本；
 * - ctx.searchMcpTools 缺省（目录模式未启用）→ TOOL_UNAVAILABLE（同 ask_user/skill fail-safe 口径）；
 * - 通道 !ok → 域码/消息原样投影；通道请求载荷 query/limit 透传（limit 缺省不携带）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mcpToolSearchTool } from "../src/handlers/mcp-tool-search.js";
import type { McpToolSearchResult, ToolExecutionContext } from "../src/index.js";
import { BackgroundTaskRegistry } from "../src/sandbox/background.js";

const WORKSPACE = process.cwd();

function baseCtx(searchMcpTools?: ToolExecutionContext["searchMcpTools"]): ToolExecutionContext {
  return {
    signal: new AbortController().signal,
    workspaceRoot: WORKSPACE,
    cwd: WORKSPACE,
    sessionKey: "test",
    background: new BackgroundTaskRegistry(),
    ...(searchMcpTools !== undefined && { searchMcpTools }),
  };
}

describe("mcp_tool_search 工具（T5.6）", () => {
  it("命中格式化：排名 + score + 下一轮可调用指引", async () => {
    const seen: Array<{ query: string; limit?: number }> = [];
    const output = await mcpToolSearchTool.execute(
      { query: "read file" },
      baseCtx(async (req) => {
        seen.push(req);
        return {
          ok: true,
          digest: "d02",
          matches: [
            { name: "mcp__alpha__read_file", description: "Read a file\nwith newlines   and spaces", score: 2.34567 },
            { name: "mcp__beta__edit_file", description: "Edit a file", score: 0.5 },
          ],
        };
      }),
    );
    assert.deepEqual(seen, [{ query: "read file" }], "limit 缺省不携带");
    assert.ok(output.content!.includes("mcp__alpha__read_file"));
    assert.ok(output.content!.includes("2.3457"), "score 四舍五入 4 位");
    assert.ok(!output.content!.includes("\nwith"), "描述单行化");
    assert.match(output.content!, /NEXT round/);
  });

  it("空结果：占位文本（不注入假数据）", async () => {
    const output = await mcpToolSearchTool.execute(
      { query: "zzz" },
      baseCtx(async () => ({ ok: true, digest: "d02", matches: [] })),
    );
    assert.match(output.content!, /No MCP tools matched/);
  });

  it("ctx.searchMcpTools 缺省 → TOOL_UNAVAILABLE", async () => {
    await assert.rejects(
      mcpToolSearchTool.execute({ query: "anything" }, baseCtx()),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal((err as { code?: string }).code, "TOOL_UNAVAILABLE");
        return true;
      },
    );
  });

  it("通道 !ok → 域码原样投影；query/limit 透传", async () => {
    const seen: Array<{ query: string; limit?: number }> = [];
    const failing: McpToolSearchResult = { ok: false, code: "TOOL_EXEC_FAILED", message: "index broken" };
    await assert.rejects(
      mcpToolSearchTool.execute(
        { query: "q", limit: 3 },
        baseCtx(async (req) => {
          seen.push(req);
          return failing;
        }),
      ),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal((err as { code?: string }).code, "TOOL_EXEC_FAILED");
        assert.match(err.message, /index broken/);
        return true;
      },
    );
    assert.deepEqual(seen, [{ query: "q", limit: 3 }]);
  });
});
