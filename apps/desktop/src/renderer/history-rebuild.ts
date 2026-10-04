/**
 * 冷重建（resume history → 流视图，06 §3.4；store.ts restoreSession 消费，与 Web 端同语义镜像）：
 * 消息 / 思考块 / 工具卡三投影。reasoning 自协议 v1.13 随 assistant 行落盘（思考块跨重启恢复）；
 * 工具卡参数摘要与活路径同用 summarizeInput v2（此前冷重建裸 JSON.stringify 退化 JSON 墙，已修）。
 * 自 session-view.ts 抽出（纯函数 + 500 行上限），便于单测驱动。
 */
import { summarizeInput } from "./session-view.js";
import type { SessionView } from "./session-view.js";

export function rebuildItemsFromHistory(history: unknown[]): SessionView["items"] {
  const items: SessionView["items"] = [];
  const toolCards = new Map<string, Extract<SessionView["items"][number], { kind: "tool" }>>();
  for (const raw of history) {
    const record = raw as { role?: string; content?: unknown; toolCallId?: string; isError?: boolean; reasoning?: unknown };
    if (record.role === "user" && typeof record.content === "string") {
      items.push({ kind: "message", id: `m-${items.length}`, role: "user", text: record.content, streaming: false });
    } else if (record.role === "assistant" && typeof record.content === "string" && record.content.length > 0) {
      items.push({
        kind: "message",
        id: `m-${items.length}`,
        role: "assistant",
        text: record.content,
        streaming: false,
        ...(typeof record.reasoning === "string" && record.reasoning.length > 0 && { reasoning: record.reasoning }),
      });
    } else if (record.role === "assistant" && Array.isArray(record.content)) {
      for (const block of record.content as Array<Record<string, unknown>>) {
        if (block.type === "tool_call" && typeof block.toolCallId === "string") {
          const card: Extract<SessionView["items"][number], { kind: "tool" }> = {
            kind: "tool",
            toolCallId: block.toolCallId,
            toolName: typeof block.name === "string" ? block.name : "unknown",
            state: "ok",
            ...(block.arguments !== undefined && { argsPreview: summarizeInput(block.arguments) }),
          };
          toolCards.set(block.toolCallId, card);
          items.push(card);
        }
      }
    } else if (record.role === "tool" && typeof record.toolCallId === "string") {
      const card = toolCards.get(record.toolCallId);
      if (card !== undefined) {
        card.state = record.isError === true ? "error" : "ok";
        if (typeof record.content === "string") card.contentPreview = record.content.slice(0, 2000);
      }
    }
  }
  return items;
}
