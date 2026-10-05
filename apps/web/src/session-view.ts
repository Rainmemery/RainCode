/**
 * 会话视图模型与事件 reducer（T3.8 Web 工作台，UI-5）：与桌面端 session-view 同一状态机
 * （06 §3.2 事件语义），双端共享同一份事实（03 §7 一致性约束）；纯函数实现。
 * Web 特有：connection 四态由 ReconnectingRpcClient 驱动（connecting/ready/reconnecting/closed）。
 */
import type { ThemePref } from "./theme.js";
import type { SubagentRecord } from "./subagent-view.js";
import type { CompactionBanner } from "./compact-view.js";

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
  state: "pending" | "running" | "ok" | "error" | "denied";
  argsPreview?: string;
  contentPreview?: string;
  errorText?: string;
  durationMs?: number;
  truncated?: boolean;
}

/** hook 执行行（T5.1：hook.started/hook.completed 投影；invocationId 配对；与桌面端同构）。 */
export interface HookItem {
  kind: "hook";
  id: string;
  phase: string;
  outcome: "running" | "success" | "blocked" | "failed" | "timed_out" | "skipped_untrusted";
  hookCount: number;
  durationMs?: number;
  reason?: string;
}

export type StreamItem = ChatItem | ToolItem | HookItem;

export interface SessionView {
  sessionId: string;
  title: string;
  items: StreamItem[];
  contextUsage?: { tokens: number; maxTokens: number };
}

/** 会话列表行（session.list 投影；contextUsage 右栏/用量条直消费，服务端已算好无需近似）。 */
export interface SessionListEntry {
  id: string;
  title: string;
  lastActiveAt: number;
  /** 归档态（06 §2.1；旧服务端缺省时按 Active 处理，session-filters 消费）。 */
  state?: "Active" | "Archived";
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

export type ConnectionState = "connecting" | "ready" | "reconnecting" | "closed";

export interface WebState {
  connection: ConnectionState;
  fatal: string | null; // 鉴权失败等不可恢复错误（停止重连）
  /** 视图路由（T4.5 面板对齐：chat / settings / memory / extensions）。 */
  view: "chat" | "settings" | "memory" | "extensions";
  workspace: string | null;
  sessions: SessionListEntry[];
  activeId: string | null;
  views: Record<string, SessionView>;
  approvals: ApprovalItem[];
  turnPhase: string | null;
  streaming: boolean;
  providers: ProviderRow[];
  activeProviderId: string | null;
  error: string | null;
  /** 活跃会话用量（session.usage；done 后与切会话时刷新，UI-4 用量统计 T4.5 对齐）。 */
  usage: { inputTokens: number; outputTokens: number; turnsCount: number; costEstimateUsd?: number } | null;
  /** 扩展域全局事件通道：mcp.server_status_changed / plugin.status_changed 到达即自增，
   * 面板监听 tick 重拉全量投影（桌面端 extensionsTick 同口径）。 */
  extTick: number;
  /** 子代理派发记录（subagent.* 全局事件归并，03 §6.1 右栏子代理 Tab + 会话流进度卡共用）。 */
  subagents: SubagentRecord[];
  /** 右侧上下文面板折叠态（03 §6.1：折叠后右缘竖条唤起；仅 chat 视图挂载）。 */
  contextPanelCollapsed: boolean;
  /** 主题偏好（03 §3.2）：dark / light / system，localStorage 持久化（theme.ts）。 */
  theme: ThemePref;
  /** 侧栏检索关键字（refreshSessions 存放；session.list filter.keyword 服务端过滤口径）。 */
  sidebarSearch: string;
  /** 侧栏过滤：已归档会话显隐（localStorage raincode.showArchived，"1" 为真）。 */
  showArchived: boolean;
  /** 侧栏过滤：子会话（[subagent: 前缀）显隐（localStorage raincode.showSubsessions，"1" 为真）。 */
  showSubsessions: boolean;
  /** 压缩提示条（compact.started/completed 归并投影；selectSession 切会话重置瞬态）。 */
  compaction: CompactionBanner | null;
}

export function initialWebState(themePref: ThemePref = "dark"): WebState {
  return {
    connection: "connecting",
    fatal: null,
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
    usage: null,
    extTick: 0,
    subagents: [],
    contextPanelCollapsed: false,
    theme: themePref,
    sidebarSearch: "",
    showArchived: false,
    showSubsessions: false,
    compaction: null,
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

/** reasoning delta 累积（思考块，03 §6.1 v1.2；delta.type=reasoning 此前被丢弃）。 */
function appendAssistantReasoning(items: StreamItem[], itemId: string, text: string): StreamItem[] {
  const idx = items.findIndex((item) => item.kind === "message" && item.id === itemId);
  if (idx < 0) return items;
  const next = [...items];
  const existing = next[idx] as ChatItem;
  next[idx] = { ...existing, reasoning: (existing.reasoning ?? "") + text };
  return next;
}

/**
 * 事件应用（06 §3.2 会话域事件子集；未知事件整体忽略，06 §7.4）。
 * 返回新 state（浅拷贝 + 受影响分支重建）。
 */
export function applySessionEvent(state: WebState, name: string, payload: Record<string, unknown>): WebState {
  const sessionId = typeof payload["sessionId"] === "string" ? payload["sessionId"] : state.activeId;
  if (sessionId === null) return state;
  const view: SessionView = state.views[sessionId] ?? { sessionId, title: sessionId, items: [] };

  switch (name) {
    case "message.delta": {
      const delta = payload["delta"] as { type: string; text?: string } | undefined;
      if (delta === undefined || typeof delta.text !== "string") return state;
      if (delta.type !== "text" && delta.type !== "reasoning") return state;
      const last = view.items[view.items.length - 1];
      if (last !== undefined && last.kind === "message" && last.role === "assistant" && last.streaming) {
        const items =
          delta.type === "reasoning"
            ? appendAssistantReasoning(view.items, last.id, delta.text)
            : appendAssistantDelta(view.items, last.id, delta.text);
        return patchView(state, sessionId, { items });
      }
      // 新建流式助手消息：reasoning 先于 text 到达时 text 以空串起步（思考块先行展开）
      const item: ChatItem = {
        kind: "message",
        id: nextItemId(),
        role: "assistant",
        text: delta.type === "text" ? delta.text : "",
        streaming: true,
        ...(delta.type === "reasoning" && { reasoning: delta.text }),
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
        items.push({ kind: "message", id: nextItemId(), role: "assistant", text: content, streaming: false });
      }
      return patchView(state, sessionId, { items });
    }
    case "tool_call.started": {
      const toolCallId = typeof payload["toolCallId"] === "string" ? payload["toolCallId"] : null;
      const toolName = typeof payload["toolName"] === "string" ? payload["toolName"] : "";
      if (toolCallId === null) return state;
      return patchView(state, sessionId, {
        items: upsertToolItem(view.items, toolCallId, toolName, { state: "running", argsPreview: summarizeInput(payload["input"]) }),
      });
    }
    case "tool_call.progress":
      return state; // 进度文本不进流（瞬态不落盘，06 §3.4）
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
        streaming: true,
      };
    }
    case "permission.resolved": {
      const grantId = typeof payload["grantId"] === "string" ? payload["grantId"] : null;
      if (grantId === null) return state;
      const decision = payload["decision"] === "allow" ? "allow" : "deny";
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
    case "hook.started": {
      const invocationId = typeof payload["invocationId"] === "string" ? payload["invocationId"] : null;
      const phase = typeof payload["phase"] === "string" ? payload["phase"] : "";
      if (invocationId === null) return state;
      const item: HookItem = {
        kind: "hook",
        id: invocationId,
        phase,
        outcome: "running",
        hookCount: Array.isArray(payload["hookIds"]) ? payload["hookIds"].length : 0,
      };
      return patchView(state, sessionId, { items: [...view.items, item] });
    }
    case "hook.completed": {
      const invocationId = typeof payload["invocationId"] === "string" ? payload["invocationId"] : null;
      const phase = typeof payload["phase"] === "string" ? payload["phase"] : "";
      if (invocationId === null) return state;
      const outcomeRaw = typeof payload["outcome"] === "string" ? payload["outcome"] : "success";
      const settledOutcome = ["success", "blocked", "failed", "timed_out", "skipped_untrusted"] as const;
      const outcome = (settledOutcome as readonly string[]).includes(outcomeRaw) ? (outcomeRaw as HookItem["outcome"]) : "success";
      const durationMs = typeof payload["durationMs"] === "number" ? payload["durationMs"] : undefined;
      const reason = typeof payload["reason"] === "string" ? payload["reason"] : undefined;
      const fields = {
        phase,
        outcome,
        hookCount: Array.isArray(payload["hookIds"]) ? payload["hookIds"].length : 0,
        ...(durationMs !== undefined && { durationMs }),
        ...(reason !== undefined && { reason }),
      };
      const idx = view.items.findIndex((item) => item.kind === "hook" && item.id === invocationId);
      if (idx >= 0) {
        const items = [...view.items];
        items[idx] = { ...(items[idx] as HookItem), ...fields };
        return patchView(state, sessionId, { items });
      }
      const item: HookItem = { kind: "hook", id: invocationId, ...fields };
      return patchView(state, sessionId, { items: [...view.items, item] });
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
    case "session.snapshot":
      return state; // 重连补推经 resume response 消费，此处保底
    default:
      return state; // 未知事件名整体忽略（06 §7.4）
  }
}

function patchView(state: WebState, sessionId: string, patch: Partial<SessionView>): WebState {
  const current = state.views[sessionId] ?? { sessionId, title: sessionId, items: [] };
  return { ...state, views: { ...state.views, [sessionId]: { ...current, ...patch } } };
}

// ---------------------------------------------------------------------------
// 子代理呈现（refine-ui-context-panel 轮）：实现拆分至 subagent-view.ts（500 行治理），
// SubagentRecord/applySubagentEvent/groupSessions/ctxLevel 由该模块导出。
// ---------------------------------------------------------------------------

/**
 * 斜杠命令解析（T4.5 对齐桌面端同语义）："/name args" → { name, args }；
 * 名字域 [a-z0-9-]，无参时省略 args；非斜杠或非法名 → null（端层只做形态预判，
 * SKILL_NOT_FOUND 等业务判定仍在服务端）。
 */
export function parseSlashInvocation(text: string): { name: string; args?: string } | null {
  const match = /^\/([a-z0-9-]+)(?:\s+([\s\S]+))?$/.exec(text.trim());
  if (match === null) return null;
  const args = match[2];
  return { name: match[1]!, ...(args !== undefined && { args }) };
}

/** 单行截断（多行命令折叠为单行；超长省略号收尾）。 */
function clipOneLine(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/**
 * 工具入参摘要 v2（折叠头参数摘要，03 §6.4；UI 重设计二轮）：按工具域提炼主参数——
 * bash 命令行 / grep·glob 模式+范围 / read·write·edit 路径 / web_fetch URL /
 * agent profile·task / skill /name；未知形状回退紧凑 JSON。纯展示，权限判定在服务端。
 */
export function summarizeInput(input: unknown): string | undefined {
  if (input === null || input === undefined) return undefined;
  if (typeof input === "string") return clipOneLine(input, 120);
  if (typeof input !== "object") return clipOneLine(String(input), 120);
  const record = input as Record<string, unknown>;
  const str = (key: string): string | undefined => {
    const value = record[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };
  const command = str("command");
  if (command !== undefined) return clipOneLine(`$ ${command}`, 120);
  const pattern = str("pattern") ?? str("query");
  if (pattern !== undefined) {
    const scope = str("path") ?? str("file_path");
    return clipOneLine(`"${pattern}"${scope !== undefined ? ` · ${scope}` : ""}`, 120);
  }
  const path = str("file_path") ?? str("path");
  if (path !== undefined) return clipOneLine(path, 120);
  const url = str("url");
  if (url !== undefined) return clipOneLine(url, 120);
  const profile = str("profile");
  if (profile !== undefined) {
    const task = str("task");
    return clipOneLine(task !== undefined ? `${profile} · ${task}` : profile, 120);
  }
  const skill = str("name");
  if (skill !== undefined) return clipOneLine(`/${skill}`, 120);
  try {
    const text = JSON.stringify(input);
    return text === undefined ? undefined : clipOneLine(text, 120);
  } catch {
    return clipOneLine(String(input), 120);
  }
}

/**
 * 冷重建（resume history → 流视图，06 §3.4；state.ts restoreSession 消费）：消息 / 思考块 /
 * 工具卡三投影。reasoning 自协议 v1.13 随 assistant 行落盘（思考块跨重启恢复）；工具卡参数
 * 摘要与活路径同用 summarizeInput v2（此前冷重建裸 JSON.stringify 退化 JSON 墙，已修）。
 * 纯函数便于单测覆盖（与桌面端同语义镜像）。
 */
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
