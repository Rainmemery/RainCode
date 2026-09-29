/**
 * 会话视图模型与事件 reducer（T2.9 Alpha）：服务端事件 → 会话流 UI 状态。
 * 状态机与 CLI stream.ts 同源（06 §3.2 事件语义），双端共享同一份事实（03 §7 一致性约束）。
 * 纯函数实现（不依赖 react/zustand），便于单测驱动。
 */

export interface ChatItem {
  kind: "message";
  id: string;
  role: "user" | "assistant";
  text: string;
  /** 流式中的助手消息（尾部光标呈现）。 */
  streaming: boolean;
  reasoning?: string;
  model?: string;
}

export interface ToolItem {
  kind: "tool";
  toolCallId: string;
  toolName: string;
  /** 五状态中的 Alpha 子集（03 §6.4）：排队并入 running；被拒单独呈现。 */
  state: "pending" | "running" | "ok" | "error" | "denied";
  argsPreview?: string;
  contentPreview?: string;
  errorText?: string;
  durationMs?: number;
  truncated?: boolean;
}

export type StreamItem = ChatItem | ToolItem;

export interface SessionView {
  sessionId: string;
  title: string;
  items: StreamItem[];
  contextUsage?: { tokens: number; maxTokens: number };
}

export interface ApprovalItem {
  grantId: string;
  toolName: string;
  reason: string;
  normalizedInput: unknown;
  metadata: { riskLevel?: string; readOnly?: boolean; destructive?: boolean };
  expiresAt: number;
}

export interface ProviderRow {
  id: string;
  name: string;
  baseURL: string;
  model: string;
  maxContextTokens: number;
  apiKeyConfigured: boolean;
}

export interface DesktopState {
  connection: "connecting" | "ready" | "agent-down";
  runMode: string;
  view: "chat" | "settings";
  workspace: string | null;
  sessions: Array<{ id: string; title: string; lastActiveAt: number }>;
  activeId: string | null;
  views: Record<string, SessionView>;
  approvals: ApprovalItem[];
  turnPhase: string | null;
  streaming: boolean;
  providers: ProviderRow[];
  activeProviderId: string | null;
  error: string | null;
}

export function initialDesktopState(): DesktopState {
  return {
    connection: "connecting",
    runMode: "dev",
    view: "chat",
    workspace: null,
    sessions: [],
    activeId: null,
    views: {},
    approvals: [],
    turnPhase: null,
    streaming: false,
    providers: [],
    activeProviderId: null,
    error: null,
  };
}

let itemSeq = 0;
function nextItemId(): string {
  itemSeq += 1;
  return `ui-${String(itemSeq)}`;
}

/** 幂等创建/更新工具项（tool_call.started 与 permission.requested 皆可能先于彼此到达）。 */
function upsertToolItem(
  items: StreamItem[],
  toolCallId: string,
  toolName: string,
  patch: Partial<Omit<ToolItem, "kind" | "toolCallId" | "toolName">>,
): StreamItem[] {
  const idx = items.findIndex((item) => item.kind === "tool" && item.toolCallId === toolCallId);
  if (idx >= 0) {
    const next = [...items];
    const existing = next[idx] as ToolItem;
    next[idx] = { ...existing, ...patch, toolName: toolName.length > 0 ? toolName : existing.toolName };
    return next;
  }
  return [
    ...items,
    {
      kind: "tool",
      toolCallId,
      toolName,
      state: patch.state ?? "running",
      ...(patch.argsPreview !== undefined && { argsPreview: patch.argsPreview }),
    },
  ];
}

function appendAssistantDelta(items: StreamItem[], itemId: string, text: string): StreamItem[] {
  const idx = items.findIndex((item) => item.kind === "message" && item.id === itemId);
  if (idx < 0) return items;
  const next = [...items];
  const existing = next[idx] as ChatItem;
  next[idx] = { ...existing, text: existing.text + text };
  return next;
}

/**
 * 事件应用（06 §3.2 会话域事件子集；未知事件整体忽略，06 §7.4）。
 * 返回新 state（浅拷贝 + 受影响分支重建）。
 */
export function applySessionEvent(state: DesktopState, name: string, payload: Record<string, unknown>): DesktopState {
  const sessionId = typeof payload["sessionId"] === "string" ? payload["sessionId"] : state.activeId;
  if (sessionId === null) return state;
  const view: SessionView =
    state.views[sessionId] ?? { sessionId, title: sessionId, items: [] };

  switch (name) {
    case "message.delta": {
      const delta = payload["delta"] as { type: string; text?: string } | undefined;
      if (delta === undefined || delta.type !== "text" || typeof delta.text !== "string") return state;
      const last = view.items[view.items.length - 1];
      if (last !== undefined && last.kind === "message" && last.role === "assistant" && last.streaming) {
        return patchView(state, sessionId, { items: appendAssistantDelta(view.items, last.id, delta.text) });
      }
      const item: ChatItem = {
        kind: "message",
        id: nextItemId(),
        role: "assistant",
        text: delta.text,
        streaming: true,
        model: typeof payload["model"] === "string" ? payload["model"] : undefined,
      };
      return patchView(state, sessionId, { items: [...view.items, item] });
    }
    case "message.completed": {
      const message = payload["message"] as
        | { role?: string; content?: string; usage?: { inputTokens?: number; outputTokens?: number } }
        | undefined;
      const content = typeof message?.content === "string" ? message.content : "";
      const items = [...view.items];
      const last = items[items.length - 1];
      if (last !== undefined && last.kind === "message" && last.role === "assistant" && last.streaming) {
        items[items.length - 1] = { ...last, text: content, streaming: false };
      } else if (content.length > 0) {
        items.push({
          kind: "message",
          id: nextItemId(),
          role: "assistant",
          text: content,
          streaming: false,
        });
      }
      return patchView(state, sessionId, { items });
    }
    case "tool_call.started": {
      const toolCallId = typeof payload["toolCallId"] === "string" ? payload["toolCallId"] : null;
      const toolName = typeof payload["toolName"] === "string" ? payload["toolName"] : "";
      if (toolCallId === null) return state;
      const argsPreview = summarizeInput(payload["input"]);
      return patchView(state, sessionId, {
        items: upsertToolItem(view.items, toolCallId, toolName, { state: "running", argsPreview }),
      });
    }
    case "tool_call.progress": {
      // Alpha：进度文本不进流（瞬态不落盘，06 §3.4）；耗时抖动交给运行中状态灯
      return state;
    }
    case "tool_call.completed": {
      const toolCallId = typeof payload["toolCallId"] === "string" ? payload["toolCallId"] : null;
      if (toolCallId === null) return state;
      const isError = payload["isError"] === true;
      const error = payload["error"] as { code?: string; message?: string } | undefined;
      const errorText =
        error !== undefined && typeof error.message === "string"
          ? `${String(error.code ?? "ERROR")}: ${error.message}`
          : undefined;
      return patchView(state, sessionId, {
        items: upsertToolItem(view.items, toolCallId, "", {
          state: isError ? "error" : "ok",
          contentPreview: typeof payload["contentPreview"] === "string" ? payload["contentPreview"] : undefined,
          errorText,
          durationMs: typeof payload["durationMs"] === "number" ? payload["durationMs"] : undefined,
          truncated: payload["truncated"] === true,
        }),
      });
    }
    case "permission.requested": {
      const grantId = typeof payload["grantId"] === "string" ? payload["grantId"] : null;
      if (grantId === null) return state;
      const approval: ApprovalItem = {
        grantId,
        toolName: typeof payload["toolName"] === "string" ? payload["toolName"] : "",
        reason: typeof payload["reason"] === "string" ? payload["reason"] : "",
        normalizedInput: payload["normalizedInput"],
        metadata: (payload["metadata"] ?? {}) as ApprovalItem["metadata"],
        expiresAt: typeof payload["expiresAt"] === "number" ? payload["expiresAt"] : 0,
      };
      const toolCallId = typeof payload["toolCallId"] === "string" ? payload["toolCallId"] : null;
      let items = view.items;
      if (toolCallId !== null) {
        items = upsertToolItem(items, toolCallId, approval.toolName, { state: "pending" });
      }
      return {
        ...patchView(state, sessionId, { items }),
        approvals: [...state.approvals.filter((a) => a.grantId !== grantId), approval],
        streaming: true, // 审批中 turn 挂起（03 §7 审批中横条）
      };
    }
    case "permission.resolved": {
      const grantId = typeof payload["grantId"] === "string" ? payload["grantId"] : null;
      if (grantId === null) return state;
      const decision = payload["decision"] === "allow" ? "allow" : "deny";
      // 被拒工具卡作废态（03 §6.4 error + denied 语义）
      let items = view.items;
      const pendingCard = [...view.items].reverse().find((item) => item.kind === "tool" && item.state === "pending");
      if (decision === "deny" && pendingCard !== undefined) {
        items = upsertToolItem(items, (pendingCard as ToolItem).toolCallId, "", {
          state: "denied",
          errorText: "用户拒绝了本次工具调用",
        });
      }
      return {
        ...patchView(state, sessionId, { items }),
        approvals: state.approvals.filter((a) => a.grantId !== grantId),
      };
    }
    case "turn.phase_changed": {
      const to = typeof payload["to"] === "string" ? payload["to"] : null;
      return { ...state, turnPhase: to };
    }
    case "done": {
      const items = view.items.map((item) =>
        item.kind === "message" && item.streaming ? { ...item, streaming: false } : item,
      );
      return { ...patchView(state, sessionId, { items }), streaming: false };
    }
    case "error": {
      const message = (payload["error"] as { message?: string } | undefined)?.message;
      return { ...state, error: typeof message === "string" ? message : "turn error" };
    }
    case "session.snapshot": {
      // 服务端事件形态的快照推送（重连补推；06 §3.2 C 组）——Alpha 经 resume response 消费，此处保底
      return state;
    }
    default:
      return state; // 未知事件名整体忽略（06 §7.4）
  }
}

function patchView(state: DesktopState, sessionId: string, patch: Partial<SessionView>): DesktopState {
  const current = state.views[sessionId] ?? { sessionId, title: sessionId, items: [] };
  return { ...state, views: { ...state.views, [sessionId]: { ...current, ...patch } } };
}

/** 工具入参摘要（折叠头参数摘要，03 §6.4）。 */
export function summarizeInput(input: unknown): string | undefined {
  if (input === null || input === undefined) return undefined;
  if (typeof input === "string") return input.slice(0, 120);
  try {
    const text = JSON.stringify(input);
    return text === undefined ? undefined : text.slice(0, 120);
  } catch {
    return String(input).slice(0, 120);
  }
}
