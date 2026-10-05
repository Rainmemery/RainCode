/**
 * session_search 会话历史检索工具（T5.3；02 §7「会话历史检索，裁剪候选」）。
 *
 * 模型经本工具跨会话检索历史：查询进入 storage part 级 trigram FTS（文本块 + 工具名，
 * 检索真源 events.jsonl；相对分数地板 + LIKE 兜底语义在 storage history-search），server
 * 装配 ctx.searchHistory 通道注入（同 ask_user/skill 通道形态）。命中列表已按相关性排序、
 * 由通道侧分数地板裁剪，本工具再做**候选裁剪**：逐条单行化 + 片段截断（超长正文墙不再进上下文），
 * 命中携带 sessionId 供模型在回答中引用出处（v1 无会话读取工具，仅检索）。
 *
 * fail-safe：ctx.searchHistory 缺省（未装配）→ TOOL_UNAVAILABLE（同 ask_user/skill 口径）；
 * 通道 !ok → ToolExecutionError(code, message) 原样投影（server 侧统一映射 TOOL_EXEC_FAILED）。
 */
import { z } from "zod";
import { TOOL_ERROR_CODES } from "@raincode/shared";
import type { Tool, ToolExecutionContext, ToolOutput, SessionHistoryHitView } from "../tool.js";
import { ToolExecutionError } from "../executor.js";

export interface SessionSearchInput {
  query: string;
  limit?: number;
}

export interface SessionSearchOutput {
  hits: SessionHistoryHitView[];
}

/** limit 上限（通道侧另有 50 硬顶；工具面收紧防候选爆炸）。 */
const MAX_LIMIT = 20;
/** 单条命中片段截断（裁剪候选：正文墙不进模型上下文）。 */
const SNIPPET_MAX_CHARS = 160;

function formatHitDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function formatHits(hits: SessionHistoryHitView[]): string {
  const lines = [`共 ${hits.length} 条历史命中（按相关性排序，内容截断至 ${SNIPPET_MAX_CHARS} 字符）：`];
  hits.forEach((hit, index) => {
    const label = hit.kind === "tool" ? `${hit.role} 调用工具 ${hit.content}` : hit.content;
    const oneLine = label.replace(/\s+/g, " ").trim();
    const snippet = oneLine.length > SNIPPET_MAX_CHARS ? `${oneLine.slice(0, SNIPPET_MAX_CHARS)}…` : oneLine;
    lines.push(`${index + 1}. 会话 ${hit.sessionId} · ${formatHitDate(hit.ts)} · ${hit.role}/${hit.kind}`);
    lines.push(`   ${snippet}`);
  });
  return lines.join("\n");
}

export const sessionSearchTool: Tool<SessionSearchInput, SessionSearchOutput> = {
  name: "session_search",
  description:
    "Search across past sessions of this workspace (full-text over conversation text and tool names). " +
    "Use it to recall prior decisions, pitfalls, or what was already tried in earlier conversations. " +
    "Results are ranked by relevance and trimmed; each hit cites its source session id.",
  parametersSchema: z.object({
    query: z.string().min(1).describe("Search text (keywords of what to recall; supports Chinese and English)"),
    limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe("Max hits to return (default 8)"),
  }),
  metadata: {
    readOnly: true,
    destructive: false,
    sideEffectScope: "none",
    riskLevel: "low",
    // 检索只读零副作用：不走审批（五级判定链 metadata 只读快速通道）
    needsApproval: false,
  },
  async execute(input: SessionSearchInput, ctx: ToolExecutionContext): Promise<ToolOutput<SessionSearchOutput>> {
    if (ctx.searchHistory === undefined) {
      throw new ToolExecutionError(
        TOOL_ERROR_CODES.UNAVAILABLE,
        "session history search unavailable: search channel not assembled in this runtime",
      );
    }
    const result = await ctx.searchHistory({
      query: input.query,
      ...(input.limit !== undefined && { limit: input.limit }),
    });
    if (!result.ok) {
      throw new ToolExecutionError(result.code, result.message);
    }
    return {
      data: { hits: result.hits },
      content: result.hits.length > 0 ? formatHits(result.hits) : "未找到匹配的历史记录。",
    };
  },
};
