/**
 * zustand 全局 store（03-architecture 技术栈：React 18 + Zustand）：
 * RPC 装配（system/session/config/permission 域 Alpha 子集）+ 事件消费 + UI 动作。
 */
import { create } from "zustand";
import { createRpcClient, RpcCallError } from "@raincode/rpc/client";
import type { RpcClient } from "@raincode/rpc/client";
import { getBridge } from "./bridge.js";
import { applySessionEvent, initialDesktopState } from "./session-view.js";
import type { DesktopState, SessionView } from "./session-view.js";

interface SessionListRow {
  id: string;
  title: string;
  lastActiveAt: number;
}

interface SnapshotPayload {
  lastSeq: number;
  phase: string;
  messages?: unknown[];
  /** v1.3 冷重建字段：全量消息（桌面端首次打开 / renderer 刷新时端层无本地历史可拼）。 */
  history?: unknown[];
  pendingApprovals?: Array<Record<string, unknown>>;
}

interface DesktopStore extends DesktopState {
  bootstrap(): Promise<void>;
  setView(view: "chat" | "settings"): void;
  setWorkspace(root: string): void;
  pickWorkspace(): Promise<void>;
  createSession(title?: string): Promise<void>;
  selectSession(sessionId: string): Promise<void>;
  send(text: string): Promise<void>;
  cancel(): Promise<void>;
  respondApproval(grantId: string, decision: "allow" | "deny", always: boolean, scope?: "session" | "project" | "global"): Promise<void>;
  addProvider(input: { name: string; baseURL: string; model: string; apiKey?: string; maxContextTokens: number }): Promise<void>;
  switchProvider(providerId: string): Promise<void>;
  dismissError(): void;
}

let client: RpcClient | null = null;

function rpc(): RpcClient {
  if (client === null) {
    client = createRpcClient({ transport: getBridge(), defaultTimeoutMs: 30_000 });
  }
  return client;
}

export const useDesktop = create<DesktopStore>((set, get) => {
  function setState(patch: Partial<DesktopState>): void {
    set(patch);
  }

  function onEvent(name: string): void {
    rpc().onEvent(name, (payload) => {
      const record = (payload ?? {}) as Record<string, unknown>;
      set(applySessionEvent(get(), name, record));
    });
  }

  async function call<T>(method: string, params?: unknown): Promise<T> {
    // params 缺省补 {}：无参方法的 strict schema（如 system.ping）拒绝 undefined，
    // 帧序列化会丢掉 params 键（场景 5 走查发现的 INVALID_PARAMS 根因）
    return rpc().call<T>(method, params ?? {});
  }

  /** resume → snapshot 重建视图（端层状态全量重建，06 §3.4；seq 缺口补偿同一入口）。
   * 冷重建取 history（全量，v1.3）；messages 是 checkpoint 后尾部增量口径（NFR-5），
   * 仅作旧服务端兼容回退——对已收束会话它为空，直接用会导致恢复后视图空白（场景 5 走查发现）。 */
  async function restoreSession(sessionId: string): Promise<SessionView> {
    const result = await call<{ snapshot: SnapshotPayload }>("session.resume", { sessionId });
    const snapshot = result.snapshot;
    const rebuild = snapshot.history !== undefined && snapshot.history.length > 0 ? snapshot.history : snapshot.messages ?? [];
    const items: SessionView["items"] = [];
    // 历史重建：文本消息直映；工具调用重建为工具卡（结果归并进对应卡，03 §6.4 五状态口径）
    const toolCards = new Map<string, Extract<SessionView["items"][number], { kind: "tool" }>>();
    for (const raw of rebuild) {
      const record = raw as {
        role?: string;
        content?: unknown;
        toolCallId?: string;
        isError?: boolean;
      };
      if (record.role === "user" && typeof record.content === "string") {
        items.push({ kind: "message", id: `m-${items.length}`, role: "user", text: record.content, streaming: false });
      } else if (record.role === "assistant" && typeof record.content === "string" && record.content.length > 0) {
        items.push({ kind: "message", id: `m-${items.length}`, role: "assistant", text: record.content, streaming: false });
      } else if (record.role === "assistant" && Array.isArray(record.content)) {
        for (const block of record.content as Array<Record<string, unknown>>) {
          if (block.type === "tool_call" && typeof block.toolCallId === "string") {
            const card: Extract<SessionView["items"][number], { kind: "tool" }> = {
              kind: "tool",
              toolCallId: block.toolCallId,
              toolName: typeof block.name === "string" ? block.name : "unknown",
              state: "ok",
              ...(block.arguments !== undefined && { argsPreview: JSON.stringify(block.arguments) }),
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
    const approvals = (snapshot.pendingApprovals ?? []).map((raw) => {
      const record = raw as Record<string, unknown>;
      return {
        grantId: String(record["grantId"] ?? ""),
        toolName: String(record["toolName"] ?? ""),
        reason: String(record["reason"] ?? ""),
        normalizedInput: record["normalizedInput"],
        metadata: (record["metadata"] ?? {}) as DesktopState["approvals"][number]["metadata"],
        expiresAt: typeof record["expiresAt"] === "number" ? record["expiresAt"] : 0,
      };
    });
    set({ approvals, streaming: false });
    return { sessionId, title: sessionId, items };
  }

  return {
    ...initialDesktopState(),

    async bootstrap(): Promise<void> {
      try {
        for (const name of [
          "message.delta",
          "message.completed",
          "tool_call.started",
          "tool_call.progress",
          "tool_call.completed",
          "permission.requested",
          "permission.resolved",
          "turn.phase_changed",
          "done",
          "error",
          "session.snapshot",
        ]) {
          onEvent(name);
        }
        window.raincode.onAgentExit(() => {
          setState({ connection: "agent-down", streaming: false, approvals: [] });
        });
        const meta = await window.raincode.meta();
        await call("system.ping", {});
        setState({ connection: "ready", runMode: meta.mode });
        const list = await call<{ items: SessionListRow[] }>("session.list", {});
        setState({
          sessions: list.items.map((row) => ({ id: row.id, title: row.title, lastActiveAt: row.lastActiveAt })),
        });
        const providers = await call<{ providers: Array<{ id: string; name: string; baseURL: string; model: string; maxContextTokens: number; apiKeyConfigured: boolean }>; activeProviderId?: string }>(
          "config.providers.list",
          {},
        );
        setState({ providers: providers.providers, activeProviderId: providers.activeProviderId ?? null });
        if (list.items.length > 0) {
          await get().selectSession(list.items[0]!.id);
        }
      } catch (err) {
        const code = err instanceof RpcCallError ? err.code : "BOOTSTRAP_FAILED";
        setState({ error: `${code}: ${err instanceof Error ? err.message : String(err)}` });
      }
    },

    setView(view): void {
      setState({ view });
    },

    setWorkspace(root): void {
      setState({ workspace: root });
    },

    async pickWorkspace(): Promise<void> {
      const dir = await window.raincode.pickWorkspace();
      if (dir !== null) setState({ workspace: dir });
    },

    async createSession(title): Promise<void> {
      let workspace = get().workspace;
      if (workspace === null) {
        const dir = await window.raincode.pickWorkspace();
        if (dir === null) throw new Error("尚未选择工作区目录");
        workspace = dir;
        setState({ workspace: dir });
      }
      const result = await call<{ sessionId: string }>("session.create", {
        workspaceRoot: workspace,
        ...(title !== undefined && { title }),
      });
      const view: SessionView = { sessionId: result.sessionId, title: title ?? "新会话", items: [] };
      set((state) => ({
        views: { ...state.views, [result.sessionId]: view },
        sessions: [{ id: result.sessionId, title: view.title, lastActiveAt: Date.now() }, ...state.sessions],
        activeId: result.sessionId,
        approvals: [],
        error: null,
      }));
    },

    async selectSession(sessionId): Promise<void> {
      const view = await restoreSession(sessionId);
      set((state) => ({
        views: { ...state.views, [sessionId]: view },
        activeId: sessionId,
        turnPhase: null,
      }));
    },

    async send(text): Promise<void> {
      const sessionId = get().activeId;
      if (sessionId === null) throw new Error("no active session");
      const view = get().views[sessionId];
      const userItem = { kind: "message" as const, id: `u-${Date.now()}`, role: "user" as const, text, streaming: false };
      set((state) => ({
        views: {
          ...state.views,
          [sessionId]: {
            ...(view ?? { sessionId, title: sessionId, items: [] }),
            items: [...(view?.items ?? []), userItem],
          },
        },
        streaming: true,
        error: null,
      }));
      try {
        await call("session.send", { sessionId, input: { text } });
      } catch (err) {
        const message = err instanceof RpcCallError ? `${err.code}: ${err.message}` : String(err);
        setState({ error: message, streaming: false });
      }
    },

    async cancel(): Promise<void> {
      const sessionId = get().activeId;
      if (sessionId === null) return;
      try {
        await call("session.cancel", { sessionId });
      } catch (err) {
        setState({ error: err instanceof RpcCallError ? err.code : String(err) });
      }
    },

    async respondApproval(grantId, decision, always, scope): Promise<void> {
      try {
        await call("permission.respond", { grantId, decision, ...(always && { always: true }), ...(scope !== undefined && { scope }) });
      } catch (err) {
        setState({ error: err instanceof RpcCallError ? `${err.code}: ${err.message}` : String(err) });
      }
    },

    async addProvider(input): Promise<void> {
      await call("config.providers.add", { provider: input });
      const list = await call<{ providers: DesktopState["providers"]; activeProviderId?: string }>("config.providers.list", {});
      setState({ providers: list.providers, activeProviderId: list.activeProviderId ?? null });
    },

    async switchProvider(providerId): Promise<void> {
      const result = await call<{ activeProviderId: string }>("config.providers.switch", { providerId });
      setState({ activeProviderId: result.activeProviderId });
    },

    dismissError(): void {
      setState({ error: null });
    },
  };
});
