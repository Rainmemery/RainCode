/**
 * 上下文组装（04-architecture §1.3 第 3 步 / 02-module-design §1.2.3）：
 * 系统提示 + 历史消息（常驻内存）+ steering 合并 → OpenAI Chat 消息线格式。
 * 消息经 zod 校验落库后进入历史，此处只做内存态投影，不产生 IO。
 */
import type { ChatRequestMessage } from "@novacode/llm";
import type { ContentBlock, MessageRecord } from "@novacode/shared";

export interface AssembleContextInput {
  systemPrompt?: string;
  /** 会话历史（含本 turn 已落库的用户输入）。 */
  history: readonly MessageRecord[];
  /** steeringBuffer 注入内容（02 §1.2.1 正交通道；合并后由调用方清空）。 */
  steering: readonly string[];
}

export function assembleChatMessages(input: AssembleContextInput): ChatRequestMessage[] {
  const messages: ChatRequestMessage[] = [];
  const systemPrompt = input.systemPrompt;
  if (systemPrompt !== undefined && systemPrompt.length > 0) {
    messages.push({ role: "system", content: systemPrompt });
  }
  for (const record of input.history) {
    messages.push(toChatMessage(record));
  }
  for (const note of input.steering) {
    messages.push({ role: "user", content: `[steering] ${note}` });
  }
  return messages;
}

/** MessageRecord → OpenAI Chat 消息（llm 包线格式；tool_call 块随工具系统波次启用）。 */
function toChatMessage(record: MessageRecord): ChatRequestMessage {
  if (record.role === "user") {
    return { role: "user", content: stringifyContent(record.content) };
  }
  if (record.role === "tool") {
    return {
      role: "tool",
      tool_call_id: record.toolCallId ?? "",
      content: stringifyContent(record.content),
    };
  }
  if (typeof record.content === "string") {
    return { role: "assistant", content: record.content };
  }
  const toolCallBlocks = record.content.filter(
    (block): block is Extract<ContentBlock, { type: "tool_call" }> => block.type === "tool_call",
  );
  if (toolCallBlocks.length > 0) {
    return {
      role: "assistant",
      content: null,
      tool_calls: toolCallBlocks.map((block) => ({
        id: block.toolCallId,
        type: "function" as const,
        function: { name: block.name, arguments: JSON.stringify(block.arguments ?? {}) },
      })),
    };
  }
  return { role: "assistant", content: stringifyContent(record.content) };
}

function stringifyContent(content: MessageRecord["content"]): string {
  if (typeof content === "string") return content;
  let out = "";
  for (const block of content) {
    if (block.type === "text") out += block.text;
  }
  return out;
}
