/**
 * Turn 循环的模块级纯函数（从 SessionTurnLoop 拆出，保持单文件 ≤500 行）。
 * 不持有状态、不做 IO：usage 合并、assistant 行内容块投影、OpenAI tools 线格式投影。
 */
import type { LlmFunctionTool } from "@novacode/llm";
import { ulid } from "@novacode/storage";
import type { ContentBlock, MessageRecord, TokenUsage } from "@novacode/shared";
import type { ToolRegistry } from "@novacode/tools";

export function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
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

/** assistant 行内容：纯文本 → string；含工具调用 → text + tool_call 块数组（05 §4.2）。 */
export function buildAssistantRecord(
  text: string,
  calls: Array<{ toolCallId: string; toolName: string; argumentsJSON: string }> | null,
): MessageRecord {
  if (calls === null || calls.length === 0) {
    return { id: `msg_${ulid()}`, role: "assistant", content: text };
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
  return { id: `msg_${ulid()}`, role: "assistant", content: blocks };
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
