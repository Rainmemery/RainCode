/**
 * Turn 循环的模块级纯函数（从 SessionTurnLoop 拆出，保持单文件 ≤500 行）。
 * 不持有状态、不做 IO：usage 合并、assistant 行内容块投影、OpenAI tools 线格式投影。
 */
import type { LlmFunctionTool } from "@raincode/llm";
import { ulid } from "@raincode/storage";
import { TOOL_ERROR_CODES } from "@raincode/shared";
import type { ContentBlock, MessageRecord, TokenUsage, ToolResult } from "@raincode/shared";
import type { ToolRegistry } from "@raincode/tools";

export function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

// ---------------------------------------------------------------------------
// AC-12 受限重试支撑（06 §4.3 段 7 TOOL_INPUT_RETRY_EXCEEDED）：工具参数校验失败路径本身
// 已通（模型可自纠），但缺重试上限——本模块只做统计，计数与收束决策在 turn-loop（上限 3）。
// ---------------------------------------------------------------------------

/** 一轮工具阶段结果中的非法入参统计：失败计数 + 最近失败的 issues 摘要（≤200 字，收束 message 用）。 */
export function invalidInputStats(results: ToolResult[]): { invalidCount: number; invalidSummary: string } {
  const invalid = results.filter((result) => result.error?.code === TOOL_ERROR_CODES.INVALID_INPUT);
  if (invalid.length === 0) {
    return { invalidCount: 0, invalidSummary: "" };
  }
  const message = invalid[invalid.length - 1]?.error?.message ?? "";
  return {
    invalidCount: invalid.length,
    invalidSummary: message.length > 200 ? `${message.slice(0, 200)}…` : message,
  };
}

/** 多轮 usage 累计（done/outcome 携带 turn 级总量）。 */
export function mergeUsage(a: TokenUsage | undefined, b: TokenUsage | undefined): TokenUsage | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const cached = (a.cachedTokens ?? 0) + (b.cachedTokens ?? 0);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(cached > 0 && { cachedTokens: cached }),
  };
}

/** 模型 argumentsJSON → 结构化参数；非法 JSON 保留原文（不阻断落库）。 */
export function parseLooseJson(argsJSON: string): unknown {
  try {
    return JSON.parse(argsJSON);
  } catch {
    return argsJSON;
  }
}

/** assistant 行内容：纯文本 → string；含工具调用 → text + tool_call 块数组（05 §4.2）；
 * reasoning 随行落盘（协议 v1.13 additive，冷重建恢复思考块；空串省略）。 */
export function buildAssistantRecord(
  text: string,
  calls: Array<{ toolCallId: string; toolName: string; argumentsJSON: string }> | null,
  reasoning = "",
): MessageRecord {
  const reasoningField = reasoning.length > 0 ? { reasoning } : {};
  if (calls === null || calls.length === 0) {
    return { id: `msg_${ulid()}`, role: "assistant", content: text, ...reasoningField };
  }
  const blocks: ContentBlock[] = [];
  if (text.length > 0) {
    blocks.push({ type: "text", text });
  }
  for (const call of calls) {
    blocks.push({
      type: "tool_call",
      toolCallId: call.toolCallId,
      name: call.toolName,
      arguments: parseLooseJson(call.argumentsJSON),
    });
  }
  return { id: `msg_${ulid()}`, role: "assistant", content: blocks, ...reasoningField };
}

/** registry 描述符 → OpenAI tools 线格式（zod→JSON Schema 投影在 registry.list 内完成）。 */
export function toLlmFunctionTools(registry: ToolRegistry): LlmFunctionTool[] {
  return registry.list().map((descriptor) => ({
    type: "function" as const,
    function: {
      name: descriptor.name,
      description: descriptor.description,
      parameters: descriptor.parametersSchema,
    },
  }));
}
