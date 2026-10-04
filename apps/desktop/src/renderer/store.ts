/**
 * zustand 全局 store（03-architecture 技术栈：React 18 + Zustand）：
 * RPC 装配（system/session/config/permission 域 Alpha 子集）+ 事件消费 + UI 动作。
 */
import { create } from "zustand";
import { createRpcClient, RpcCallError } from "@raincode/rpc/client";
import type { RpcClient } from "@raincode/rpc/client";
import { getBridge } from "./bridge.js";
import { applySessionEvent, initialDesktopState } from "./session-view.js";
import { applySubagentEvent } from "./subagent-view.js";
import { rebuildItemsFromHistory } from "./history-rebuild.js";
import type { DesktopState, SessionView } from "./session-view.js";
import { applyTheme, loadThemePref, saveThemePref } from "./theme.js";
import type { ThemePref } from "./theme.js";

interface SessionListRow {
  id: string;
  title: string;
  lastActiveAt: number;
  /** 上下文用量（服务端已算好：session.list 随行，ctx 用量条直接消费）。 */
  contextUsage?: { tokens: number; maxTokens: number };
}

interface SnapshotPayload {
  lastSeq: number;
  phase: string;
  messages?: unknown[];
  /** v1.3 冷重建字段：全量消息（桌面端首次打开 / renderer 刷新时端层无本地历史可拼）。 */
  history?: unknown[];
  pendingApprovals?: Array<Record<string, unknown>>;
  /** 上下文用量（服务端已算好；resume 快照随行，回填 sessions 对应行）。 */
  contextUsage?: { tokens: number; maxTokens: number };
}

interface DesktopStore extends DesktopState {
  bootstrap(): Promise<void>;
  setView(view: "chat" | "settings" | "memory" | "extensions"): void;
  setWorkspace(root: string): void;
  pickWorkspace(): Promise<void>;
  createSession(title?: string): Promise<void>;
  selectSession(sessionId: string): Promise<void>;
  send(text: string): Promise<void>;
  cancel(): Promise<void>;
  respondApproval(grantId: string, decision: "allow" | "deny", always: boolean, scope?: "session" | "project" | "global"): Promise<void>;
  addProvider(input: { name: string; baseURL: string; model: string; apiKey?: string; maxContextTokens: number }): Promise<void>;
  switchProvider(providerId: string): Promise<void>;
  /** 斜杠技能调用（T3.9 / UI-4）：skills.invoke，turn 事件流与 session.send 完全一致。 */
  invokeSkill(name: string, args?: string): Promise<void>;
  /** 活跃会话用量刷新（session.usage；切会话与 done 后调用，UI-4 用量统计）。 */
  refreshUsage(): Promise<void>;
  /** 右侧上下文面板折叠切换（refine-ui-context-panel 轮 §6.0）。 */
  toggleContextPanel(): void;
  /** 主题偏好切换（03 §3.2）：持久化 + 立即落 <html data-theme>。 */
  setTheme(pref: ThemePref): void;
  dismissError(): void;
}

let client: RpcClient | null = null;

function rpc(): RpcClient {
  if (client === null) {
    client = createRpcClient({ transport: getBridge(), defaultTimeoutMs: 30_000 });
  }
  return client;
}

/**
 * 低频控制面调用的共享出口（memory 域等本地状态自管的视图使用，不进全局 store）；
 * 与 store 内 call 同口径：params 缺省补 {}（strict schema 拒绝 undefined）。
 */
export function rpcCall<T>(method: string, params?: unknown): Promise<T> {
  return rpc().call<T>(method, params ?? {});
}

export const useDesktop = create<DesktopStore>((set, get) => {
  function setState(patch: Partial<DesktopState>): void {
    set(patch);
  }

  function setTheme(pref: ThemePref): void {
    saveThemePref(localStorage, pref);
    applyTheme(pref);
    setState({ theme: pref });
  }

  function onEvent(name: string): void {
    rpc().onEvent(name, (payload) => {
      const record = (payload ?? {}) as Record<string, unknown>;
      // 子代理全局事件（不带 sessionId，归属=事件到达时活跃会话）：独立归并，不进会话流投影
      if (
        name === "subagent.spawned" ||
        name === "subagent.progress" ||
        name === "subagent.completed"
      ) {
        set(applySubagentEvent(get(), name, record));
        return;
      }
      set(applySessionEvent(get(), name, record));
      // 回合收束后刷新用量（UI-4）：done 每回合一次，拉取成本可忽略
      if (name === "done") void get().refreshUsage();
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
    // 历史重建（session-view 纯函数）：文本消息 + 思考块（v1.13 随行落盘）+ 工具卡（结果归并，摘要 v2）
    const items = rebuildItemsFromHistory(rebuild);
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
    // 上下文用量回填（服务端已算好）：sessions 对应行按 sessionId 更新，无则忽略
    if (snapshot.contextUsage !== undefined) {
      const contextUsage = snapshot.contextUsage;
      set((state) => ({
        sessions: state.sessions.map((row) => (row.id === sessionId ? { ...row, contextUsage } : row)),
      }));
    }
    return {
      sessionId,
      title: sessionId,
      items,
      ...(snapshot.contextUsage !== undefined && { contextUsage: snapshot.contextUsage }),
    };
  }

  return {
    ...initialDesktopState(loadThemePref(localStorage)),

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
          "mcp.server_status_changed", // 全局事件（扩展面板活更，UI-4）
          "plugin.status_changed", // 全局事件（扩展面板活更，UI-4）
          "subagent.spawned", // 全局事件（右栏子代理 Tab + 会话流进度卡，refine-ui-context-panel 轮）
          "subagent.progress",
          "subagent.completed",
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
          sessions: list.items.map((row) => ({
            id: row.id,
            title: row.title,
            lastActiveAt: row.lastActiveAt,
            ...(row.contextUsage !== undefined && { contextUsage: row.contextUsage }),
          })),
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
      await get().refreshUsage();
    },

    async refreshUsage(): Promise<void> {
      const sessionId = get().activeId;
      if (sessionId === null) return;
      try {
        // 并行拉取用量与会话列表：list 重建 sessions 行（透传 contextUsage），done 后 ctx 条同步
        const [usage, list] = await Promise.all([
          call<NonNullable<DesktopState["usage"]>>("session.usage", { sessionId }),
          call<{ items: SessionListRow[] }>("session.list", {}),
        ]);
        setState({
          sessions: list.items.map((row) => ({
            id: row.id,
            title: row.title,
            lastActiveAt: row.lastActiveAt,
            ...(row.contextUsage !== undefined && { contextUsage: row.contextUsage }),
          })),
        });
        // 会话可能已切换：只写回仍是活跃会话的用量
        if (get().activeId === sessionId) set({ usage });
      } catch {
        // 用量展示为附加信息：失败静默（条目缺失/旧服务端不影响主流程）
      }
    },

    toggleContextPanel(): void {
      setState({ contextPanelCollapsed: !get().contextPanelCollapsed });
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

    async invokeSkill(name, args): Promise<void> {
      const sessionId = get().activeId;
      if (sessionId === null) throw new Error("no active session");
      const view = get().views[sessionId];
      const commandText = `/${name}${args !== undefined && args.length > 0 ? ` ${args}` : ""}`;
      const userItem = { kind: "message" as const, id: `u-${Date.now()}`, role: "user" as const, text: commandText, streaming: false };
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
        await call("skills.invoke", { sessionId, name, ...(args !== undefined && { arguments: args }) });
      } catch (err) {
        const message = err instanceof RpcCallError ? `${err.code}: ${err.message}` : String(err);
        setState({ error: message, streaming: false });
      }
    },

    dismissError(): void {
      setState({ error: null });
    },

    setTheme,
  };
});
