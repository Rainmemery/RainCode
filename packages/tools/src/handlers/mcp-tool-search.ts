/**
 * mcp_tool_search MCP 工具目录检索工具（T5.6；02 §3.5「MCP 工具目录化」）。
 *
 * 目录模式（mcp 域装配且未显式关闭）下，MCP 工具的完整参数 schema 不再全量进模型载荷——
 * 模型侧只见 `mcp_tool_search`（description 携带预算化目录摘要）与已激活工具。本工具经
 * ctx.searchMcpTools 通道检索 server 侧 BM25 目录（K1=1.2；语料 = 工具名 + 描述 + 递归参数名），
 * 命中按相关性排序、相对分数地板裁剪（top×0.15，T5.3 同纪律）。命中工具自**下一轮**起可按名
 * 直接调用（请求域激活：turn-loop 以同索引确定性重导出登记，模型可见输出不作激活依据）。
 *
 * fail-safe：ctx.searchMcpTools 缺省（目录模式未启用）→ TOOL_UNAVAILABLE（同 ask_user/skill 口径）；
 * 通道 !ok → ToolExecutionError(code, message) 原样投影。
 */
import { z } from "zod";
import { TOOL_ERROR_CODES } from "@raincode/shared";
import type { Tool, ToolExecutionContext, ToolOutput } from "../tool.js";
import { ToolExecutionError } from "../executor.js";

/** 工具名常量（目录模式载荷按名替换 description；非目录模式自载荷剔除——turn/mcp-catalog.ts）。 */
export const MCP_TOOL_SEARCH_NAME = "mcp_tool_search";

export interface McpToolSearchInput {
  query: string;
  limit?: number;
}

/** 单次检索命中上限（MiMo 参照：BM25 检索上限 32；accumulated 激活同上限，turn-loop 侧）。 */
export const MCP_TOOL_SEARCH_MAX_LIMIT = 32;

function formatMatches(matches: Array<{ name: string; description: string; score: number }>): string {
  if (matches.length === 0) {
    return "No MCP tools matched the query. Try different keywords (tool names and descriptions are indexed).";
  }
  const lines = [`Found ${matches.length} MCP tool(s), ranked by relevance:`, ""];
  for (const match of matches) {
    const oneLine = match.description.replace(/\s+/g, " ").trim();
    lines.push(`- ${match.name} (score ${match.score.toFixed(4)})`);
    lines.push(`  ${oneLine}`);
  }
  lines.push("");
  lines.push("Matched tools become callable by name from the NEXT round of this request.");
  return lines.join("\n");
}

export const mcpToolSearchTool: Tool<McpToolSearchInput, unknown> = {
  name: MCP_TOOL_SEARCH_NAME,
  description:
    "Search the MCP tool directory by keywords (BM25 over tool names, descriptions and parameter names). " +
    "MCP tool parameter schemas are not loaded upfront; use this tool to discover which MCP tools exist, " +
    "then call matched tools by name from the next round.",
  parametersSchema: z.object({
    query: z.string().min(1).describe("Search keywords (matches tool names, descriptions and parameter names)"),
    limit: z.number().int().min(1).max(MCP_TOOL_SEARCH_MAX_LIMIT).optional().describe(`Max matches to return (default 8, hard cap ${MCP_TOOL_SEARCH_MAX_LIMIT})`),
  }),
  metadata: {
    readOnly: true,
    destructive: false,
    sideEffectScope: "none",
    riskLevel: "low",
    // 检索只读零副作用：不走审批（五级判定链 metadata 只读快速通道）
    needsApproval: false,
  },
  async execute(input: McpToolSearchInput, ctx: ToolExecutionContext): Promise<ToolOutput<unknown>> {
    if (ctx.searchMcpTools === undefined) {
      throw new ToolExecutionError(
        TOOL_ERROR_CODES.UNAVAILABLE,
        "mcp tool search unavailable: MCP tool directory mode is not enabled in this runtime",
      );
    }
    const result = await ctx.searchMcpTools({
      query: input.query,
      ...(input.limit !== undefined && { limit: input.limit }),
    });
    if (!result.ok) {
      throw new ToolExecutionError(result.code, result.message);
    }
    return {
      data: { digest: result.digest, matches: result.matches },
      content: formatMatches(result.matches),
    };
  },
};
