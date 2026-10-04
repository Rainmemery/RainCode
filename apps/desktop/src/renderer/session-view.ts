/**
 * 会话视图模型与事件 reducer（T2.9 Alpha）：服务端事件 → 会话流 UI 状态；状态机与 CLI
 * stream.ts 同源（06 §3.2 事件语义），双端共享同一份事实（03 §7）；纯函数便于单测驱动。
 */
import type { McpServerStatusEntry, McpServerStatus, PluginStatus, PluginSummary } from "@raincode/shared";

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

/** hook 执行行（T5.1：hook.started/hook.completed 投影；invocationId 配对）。 */
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
  /** extensions = MCP / 插件面板（UI-4，T3.9）。 */
  view: "chat" | "settings" | "memory" | "extensions";
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
  /** MCP 服务器状态投影（mcp.servers.list 拉取 + mcp.server_status_changed 事件活更，UI-4）。 */
  mcpServers: McpServerStatusEntry[];
  /** 插件状态投影（plugins.list 拉取 + plugin.status_changed 事件活更，UI-4）。 */
  plugins: PluginSummary[];
  /** 全局状态事件计数（面板据此重拉列表：拉取早于域就绪时事件对未知行不可增量补，UI-4）。 */
  extensionsTick: number;
  /** 活跃会话用量（session.usage；done 事件后与切会话时刷新，UI-4 用量统计）。 */
  usage: { inputTokens: number; outputTokens: number; turnsCount: number; costEstimateUsd?: number } | null;
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
    mcpServers: [],
    plugins: [],
    extensionsTick: 0,
    usage: null,
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
 * 全局事件（mcp.server_status_changed / plugin.status_changed，sessionId 缺省）先行处理——
 * 不参与会话流投影，只更新扩展面板状态（UI-4）。
 */
export function applySessionEvent(state: DesktopState, name: string, payload: Record<string, unknown>): DesktopState {
  if (name === "mcp.server_status_changed") return applyMcpStatusChanged(state, payload);
  if (name === "plugin.status_changed") return applyPluginStatusChanged(state, payload);
  const sessionId = typeof payload["sessionId"] === "string" ? payload["sessionId"] : state.activeId;
  if (sessionId === null) return state;
  const view: SessionView =
    state.views[sessionId] ?? { sessionId, title: sessionId, items: [] };

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

/** mcp.server_status_changed（全局）：upsert 状态行；enabled 以 list 拉取为准（事件不改写）。 */
function applyMcpStatusChanged(state: DesktopState, payload: Record<string, unknown>): DesktopState {
  const serverKey = payload["serverKey"];
  const status = payload["status"];
  if (typeof serverKey !== "string" || typeof status !== "string") return state;
  const servers = [...state.mcpServers];
  const idx = servers.findIndex((server) => server.serverKey === serverKey);
  if (idx >= 0) {
    const row = servers[idx]!;
    servers[idx] = {
      ...row,
      status: status as McpServerStatus,
      ...(typeof payload["toolCount"] === "number" && { toolCount: payload["toolCount"] as number }),
      ...(typeof payload["error"] === "string" ? { lastError: payload["error"] as string } : {}),
    };
  }
  // 无条件 tick：拉取早于域就绪时事件对未知行不可增量补，面板据此重拉全量
  return { ...state, mcpServers: servers, extensionsTick: state.extensionsTick + 1 };
}

/** plugin.status_changed（全局）：patch 状态行；enabled/工具清单以 list 拉取为准。 */
function applyPluginStatusChanged(state: DesktopState, payload: Record<string, unknown>): DesktopState {
  const name = payload["name"];
  const status = payload["status"];
  if (typeof name !== "string" || typeof status !== "string") return state;
  const plugins = [...state.plugins];
  const idx = plugins.findIndex((plugin) => plugin.name === name);
  if (idx >= 0) {
    const row = plugins[idx]!;
    plugins[idx] = {
      ...row,
      status: status as PluginStatus,
      ...(typeof payload["error"] === "string" ? { lastError: payload["error"] as string } : {}),
    };
  }
  return { ...state, plugins, extensionsTick: state.extensionsTick + 1 };
}

/** 单行截断（多行命令折叠为单行；超长省略号收尾）。 */
function clipOneLine(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/**
 * 工具入参摘要 v2（折叠头参数摘要，03 §6.4 v1.2）：按工具域提炼主参数——bash 命令行 /
 * grep·glob 模式+范围 / read·write·edit 路径 / web_fetch URL / agent profile·task /
 * skill /name；未知形状回退紧凑 JSON。纯展示，权限判定在服务端。
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
 * 斜杠命令解析（T3.9 斜杠命令面板）："/name" 或 "/name args" → 调用形状；
 * 非斜杠 / 裸 "/" / 名字含非法字符（技能名域 [a-z0-9-]+）→ null（按普通文本发送）。
 * 展开在 server 侧（skills.invoke，06 §2.9），端层只解析转发，与 CLI 同语义。
 */
export function parseSlashInvocation(text: string): { name: string; args?: string } | null {
  const match = /^\/([a-z0-9-]+)(?:\s+([\s\S]+))?$/.exec(text.trim());
  if (match === null) return null;
  const args = match[2];
  return { name: match[1]!, ...(args !== undefined && { args }) };
}
