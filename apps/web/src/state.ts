/**
 * zustand 全局 store（T3.8 Web 工作台）：ReconnectingRpcClient 装配 + 快照补偿接线。
 *
 * 断线恢复路径（06 §6.3 第 4 条，验收项）：
 * - onRestored → 恢复活跃会话（session.resume 全量重建 + pendingApprovals 补推）；
 * - onSeqGap → 恢复该会话（resume）后 setSeqBaseline 回填 snapshot.lastSeq（resync 期间
 *   该会话事件由客户端丢弃，防与补推重复应用）。
 */
import { create } from "zustand";
import { createReconnectingRpcClient, RpcCallError } from "@raincode/rpc/web";
import type { ReconnectingRpcClient } from "@raincode/rpc/web";
import { applySessionEvent, initialWebState, rebuildItemsFromHistory } from "./session-view.js";
import { applySubagentEvent } from "./subagent-view.js";
import type { SessionListEntry, SessionView, WebState } from "./session-view.js";
import { applyTheme, loadThemePref, saveThemePref } from "./theme.js";
import type { ThemePref } from "./theme.js";

interface SnapshotPayload {
  lastSeq: number;
  phase: string;
  messages?: unknown[];
  /** v1.3 冷重建字段：全量消息（resume 冷恢复/幂等路径双填充，06 §3.2）。 */
  history?: unknown[];
  pendingApprovals?: Array<Record<string, unknown>>;
  /** 右栏/用量条 context 用量（服务端 session-support 已算好，直接消费）。 */
  contextUsage?: { tokens: number; maxTokens: number };
}

/** 会话列表行类型（session.list 投影；contextUsage 透传右栏/用量条）。 */
type SessionListRow = SessionListEntry;

interface WebStore extends WebState {
  bootstrap(): Promise<void>;
  /** 就绪/重连后的列表刷新与会话对齐（connection 状态机驱动）。 */
  refreshLists(): Promise<void>;
  setView(view: "chat" | "settings" | "memory" | "extensions"): void;
  setWorkspace(root: string): void;
  createSession(title?: string): Promise<void>;
  selectSession(sessionId: string): Promise<void>;
  send(text: string): Promise<void>;
  cancel(): Promise<void>;
  respondApproval(grantId: string, decision: "allow" | "deny", always: boolean, scope?: "session" | "project" | "global"): Promise<void>;
  addProvider(input: { name: string; baseURL: string; model: string; apiKey?: string; maxContextTokens: number }): Promise<void>;
  switchProvider(providerId: string): Promise<void>;
  /** 活跃会话用量刷新（session.usage；done 后与切会话时调用，UI-4 用量统计 T4.5 对齐）。 */
  refreshUsage(): Promise<void>;
  /** 斜杠命令调用（skills.invoke，展开在 server 侧；与 CLI/桌面端同语义）。 */
  invokeSkill(name: string, args?: string): Promise<void>;
  /** 主题偏好切换（03 §3.2）：持久化 + 立即落 <html data-theme>。 */
  setTheme(pref: ThemePref): void;
  /** 右侧上下文面板折叠切换（03 §6.1：折叠后右缘竖条唤起）。 */
  toggleContextPanel(): void;
  dismissError(): void;
}

let client: ReconnectingRpcClient | null = null;

/** 面板组件直连 RPC（低频管理面拉取：memory/mcp/plugins/skills 清单；主会话流仍走 store 动作）。 */
export function rpcCall<T>(method: string, params?: unknown): Promise<T> {
  return rpc().call<T>(method, params ?? {});
}

function endpoint(): { url: string; token: string } {
  const params = new URLSearchParams(window.location.search);
  const url = params.get("ws") ?? `ws://${window.location.hostname}:8787/ws`;
  const fromQuery = params.get("token");
  const token = fromQuery ?? window.prompt("输入 web auth token（raincode web 启动时输出到 stderr）") ?? "";
  return { url, token };
}

function rpc(): ReconnectingRpcClient {
  if (client === null) {
    const { url, token } = endpoint();
    client = createReconnectingRpcClient({
      url,
      token,
      connectSocket: (socketUrl) => new WebSocket(socketUrl),
    });
  }
  return client;
}

export const useWeb = create<WebStore>((set, get) => {
  function setState(patch: Partial<WebState>): void {
    set(patch);
  }

  function setTheme(pref: ThemePref): void {
    saveThemePref(localStorage, pref);
    applyTheme(pref);
    setState({ theme: pref });
  }

  async function call<T>(method: string, params?: unknown): Promise<T> {
    return rpc().call<T>(method, params ?? {});
  }

  /** resume → snapshot 重建视图（端层状态全量重建，06 §3.4；seq 缺口补偿与重连恢复同一入口）。
   * 冷重建取 history（全量）；messages 是 checkpoint 后尾部增量口径（NFR-5），仅作兼容回退。 */
  async function restoreSession(sessionId: string): Promise<SessionView> {
    const result = await call<{ snapshot: SnapshotPayload }>("session.resume", { sessionId });
    const snapshot = result.snapshot;
    const rebuild = snapshot.history !== undefined && snapshot.history.length > 0 ? snapshot.history : snapshot.messages ?? [];
    const items = rebuildItemsFromHistory(rebuild);
    const approvals = (snapshot.pendingApprovals ?? []).map((raw) => {
      const record = raw as Record<string, unknown>;
      return {
        grantId: String(record["grantId"] ?? ""),
        toolName: String(record["toolName"] ?? ""),
        reason: String(record["reason"] ?? ""),
        normalizedInput: record["normalizedInput"],
        metadata: (record["metadata"] ?? {}) as WebState["approvals"][number]["metadata"],
        expiresAt: typeof record["expiresAt"] === "number" ? record["expiresAt"] : 0,
      };
    });
    set({ approvals, streaming: false });
    // 快照携带 context 用量（服务端 session-support 已算好）：回填 sessions 对应行（找不到行忽略）
    if (snapshot.contextUsage !== undefined) {
      set((state) => ({
        sessions: state.sessions.map((row) =>
          row.id === sessionId ? { ...row, contextUsage: snapshot.contextUsage } : row,
        ),
      }));
    }
    // 补偿完成回填：seq 缺口检测基线对齐服务端（06 §6.3 第 4 条）
    rpc().setSeqBaseline(sessionId, snapshot.lastSeq);
    return { sessionId, title: sessionId, items };
  }

  async function resumeActive(): Promise<void> {
    const activeId = get().activeId;
    if (activeId === null) return;
    try {
      const view = await restoreSession(activeId);
      set((state) => ({ views: { ...state.views, [activeId]: view } }));
      await get().refreshUsage(); // 重连恢复后用量行对齐
    } catch (err) {
      setState({ error: err instanceof RpcCallError ? `${err.code}: ${err.message}` : String(err) });
    }
  }

  function onEvent(name: string): void {
    rpc().onEvent(name, (payload) => {
      // 扩展域全局事件（无 sessionId 归属）：仅 bump tick，面板自行重拉全量投影（桌面端同口径）
      if (name === "mcp.server_status_changed" || name === "plugin.status_changed") {
        set((state) => ({ extTick: state.extTick + 1 }));
        return;
      }
      const record = (payload ?? {}) as Record<string, unknown>;
      // 子代理域全局事件（无 sessionId，06 §3.2 C 组）：归属=事件到达时活跃会话（refine-ui-context-panel 轮）
      if (name === "subagent.spawned" || name === "subagent.progress" || name === "subagent.completed") {
        set(applySubagentEvent(get(), name, record));
        return;
      }
      set(applySessionEvent(get(), name, record));
      if (name === "done") void get().refreshUsage(); // 回合收束即刷新用量行
    });
  }

  return {
    ...initialWebState(loadThemePref(localStorage)),

    async bootstrap(): Promise<void> {
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
        "mcp.server_status_changed",
        "plugin.status_changed",
        "subagent.spawned",
        "subagent.progress",
        "subagent.completed",
      ]) {
        onEvent(name);
      }
      rpc().onStateChange((connection) => {
        setState({ connection });
        if (connection === "ready") {
          // B9 缺陷修复：重连成功即清除旧错误横幅（首载竞态 TRANSPORT_CLOSED 横幅此前会驻留）
          setState({ error: null });
          void get().refreshLists();
        }
      });
      rpc().onRestored(() => {
        void resumeActive(); // 重连恢复：活跃会话快照补偿（验收项）
      });
      rpc().onSeqGap((info) => {
        // seq 缺口 → resume 补偿（06 §6.3 第 4 条；setSeqBaseline 在 restoreSession 内回填）
        void restoreSession(info.sessionId).then((view) => {
          set((state) => ({ views: { ...state.views, [info.sessionId]: view } }));
        });
      });
      rpc().onFatal((err) => {
        setState({ fatal: `${err.code}: ${err.message}`, connection: "closed" });
      });
      await get().refreshLists();
    },

    async refreshLists(): Promise<void> {
      try {
        const list = await call<{ items: SessionListRow[] }>("session.list", {});
        setState({
          sessions: list.items.map((row) => ({
            id: row.id,
            title: row.title,
            lastActiveAt: row.lastActiveAt,
            // contextUsage 透传（服务端 session-support 已算好；row 缺省时不写字段）
            ...(row.contextUsage !== undefined && { contextUsage: row.contextUsage }),
          })),
          connection: "ready",
        });
        const providers = await call<{
          providers: WebState["providers"];
          activeProviderId?: string;
        }>("config.providers.list", {});
        setState({ providers: providers.providers, activeProviderId: providers.activeProviderId ?? null });
        const activeId = get().activeId;
        if (activeId === null && list.items.length > 0) {
          await get().selectSession(list.items[0]!.id);
        } else if (activeId !== null) {
          await resumeActive(); // 就绪/恢复即对齐活跃会话
        }
      } catch (err) {
        if (get().connection === "reconnecting") return; // 断线窗口内探测失败属预期，重连后再试
        // B9 缺陷修复：首载竞态（ws 握手未完成即调用）不再落横幅——ready 后 refreshLists 会自动重试
        if (err instanceof RpcCallError && err.code === "TRANSPORT_CLOSED") return;
        setState({ error: err instanceof RpcCallError ? `${err.code}: ${err.message}` : String(err) });
      }
    },

    setView(view): void {
      setState({ view });
    },

    setWorkspace(root): void {
      setState({ workspace: root });
    },

    async createSession(title): Promise<void> {
      const workspace = get().workspace;
      if (workspace === null || workspace.length === 0) {
        setState({ error: "请先在侧栏填写工作区目录绝对路径" });
        return;
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
        // 并行拉取用量与会话列表：list 重建顺带刷新各行 contextUsage（回合结束 ctx 条同步）
        const [usage, list] = await Promise.all([
          call<NonNullable<WebState["usage"]>>("session.usage", { sessionId }),
          call<{ items: SessionListRow[] }>("session.list", {}),
        ]);
        // 会话可能已切换：只写回仍是活跃会话的用量
        if (get().activeId === sessionId) set({ usage });
        setState({
          sessions: list.items.map((row) => ({
            id: row.id,
            title: row.title,
            lastActiveAt: row.lastActiveAt,
            ...(row.contextUsage !== undefined && { contextUsage: row.contextUsage }),
          })),
        });
      } catch {
        // 用量展示为附加信息：失败静默（条目缺失/旧服务端不影响主流程）
      }
    },

    async invokeSkill(name, args): Promise<void> {
      const sessionId = get().activeId;
      if (sessionId === null) {
        setState({ error: "no active session" });
        return;
      }
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

    async send(text): Promise<void> {
      const sessionId = get().activeId;
      if (sessionId === null) {
        setState({ error: "no active session" });
        return;
      }
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
      const list = await call<{ providers: WebState["providers"]; activeProviderId?: string }>("config.providers.list", {});
      setState({ providers: list.providers, activeProviderId: list.activeProviderId ?? null });
    },

    async switchProvider(providerId): Promise<void> {
      const result = await call<{ activeProviderId: string }>("config.providers.switch", { providerId });
      setState({ activeProviderId: result.activeProviderId });
    },

    setTheme,

    toggleContextPanel(): void {
      set((state) => ({ contextPanelCollapsed: !state.contextPanelCollapsed }));
    },

    dismissError(): void {
      setState({ error: null });
    },
  };
});
