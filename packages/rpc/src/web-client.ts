import { EVENT_SCHEMAS, SYSTEM_ERROR_CODES } from "@raincode/shared";
import { createRpcClient, RpcCallError } from "./client.js";
import type { RpcClient, RpcClientCallOptions } from "./client.js";
import { WebSocketTransport } from "./websocket.js";
import type { WsSocketLike } from "./websocket.js";
import type { Unsubscribe } from "./transport.js";

/**
 * 浏览器安全的 websocket 客户端装配（T3.8 / 06-api-spec §6.3 第 2、4 条）：
 * 重连退避 + 连接级鉴权握手 + per-session seq 缺口检测，供 Web 会话工作台消费。
 *
 * 与进程内/stdio 客户端的本质差异（06 §6.3 第 4 条）：客户端与 server 不再同生共死，
 * 端层必须完整实现 seq 缺口检测 → resume 补偿路径，不能假设进程内回调的可靠性——
 * 本类承担「传输生命周年轮」，端层订阅 onRestored / onSeqGap 两个出口完成补偿：
 * - onRestored：重连握手（ws.auth → system.ping）成功后触发，端层 resume 活跃会话重建视图；
 * - onSeqGap：会话事件 seq 出现跳变（EventBase.seq 会话内单调，06 §3.1）时触发，
 *   端层 resume 该会话后经 setSeqBaseline 回填 snapshot.lastSeq；resync 期间该会话事件
 *   丢弃（快照重建后由新事件接续，防止与补推重复应用）。
 *
 * 首连不触发 onRestored（端层以 onStateChange 变为 ready 启动引导）；断线瞬间在途调用
 * 全部以 TRANSPORT_CLOSED 立即拒绝（fail-fast，一致性由 resume 补偿兜底）；鉴权失败
 * （token 无效/过期）经 onFatal 上报并停止重连（重试无意义）。
 */

export type WebConnectionState = "connecting" | "ready" | "reconnecting" | "closed";

export interface ReconnectingRpcClientOptions {
  url: string;
  /** ws.auth 令牌（06 §6.3 第 3 条：跨网络必须增加 token 校验）。 */
  token: string;
  /** 平台 socket 工厂（浏览器 `() => new WebSocket(url)`；node 测试注入「ws」客户端）。 */
  connectSocket: (url: string) => WsSocketLike;
  /** 第 attempt 次重试前的退避毫秒；缺省 1s × 2^k 封顶 10s（06 §6.3 第 2 条），可注入测试。 */
  backoffMs?: (attempt: number) => number;
  /** 默认调用超时（毫秒），缺省 10s（透传 RpcClient）。 */
  defaultTimeoutMs?: number;
}

export interface ReconnectingRpcClient {
  call<T>(method: string, params?: unknown, opts?: RpcClientCallOptions): Promise<T>;
  onEvent(name: string, listener: (payload: unknown) => void): Unsubscribe;
  readonly state: WebConnectionState;
  onStateChange(listener: (state: WebConnectionState) => void): Unsubscribe;
  /** 重连握手完成后触发（首连不触发）；端层在此 resume 活跃会话完成快照补偿。 */
  onRestored(listener: () => void): Unsubscribe;
  /** seq 缺口出口：端层 resume 该会话后经 setSeqBaseline 回填基线。 */
  onSeqGap(listener: (info: { sessionId: string; lastSeen: number; incoming: number }) => void): Unsubscribe;
  /** 鉴权失败（UNAUTHORIZED 等 ws.auth 错误）：停止重连，端层提示重新提供 token。 */
  onFatal(listener: (err: RpcCallError) => void): Unsubscribe;
  /** resume 补偿完成回填基线（snapshot.lastSeq）；该会话 resync 状态解除。 */
  setSeqBaseline(sessionId: string, seq: number): void;
  close(): void;
}

const DEFAULT_BACKOFF_MS = (attempt: number): number =>
  Math.min(1000 * 2 ** Math.max(0, attempt - 1), 10_000);

export function createReconnectingRpcClient(
  options: ReconnectingRpcClientOptions,
): ReconnectingRpcClient {
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;

  let state: WebConnectionState = "connecting";
  let closed = false;
  let attempt = 0; // 已发生的断线次数（退避指数）
  let everReady = false; // 是否成功握手过（onRestored 仅在其后的重连触发）
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  let client: RpcClient | null = null;
  let currentTransport: WebSocketTransport | null = null;
  let pendingSocket: WsSocketLike | null = null; // waitOpen 窗口内的 socket（close 时收尾）

  const stateListeners = new Set<(state: WebConnectionState) => void>();
  const restoredListeners = new Set<() => void>();
  const seqGapListeners = new Set<(info: { sessionId: string; lastSeen: number; incoming: number }) => void>();
  const fatalListeners = new Set<(err: RpcCallError) => void>();
  /** 事件订阅表：name → 用户监听器（重连后按 name 重新挂到新 RpcClient）。 */
  const eventListeners = new Map<string, Set<(payload: unknown) => void>>();
  /** per-session 事件基线（06 §3.1 EventBase.seq 单调）；空 = 尚未观察到该会话事件。 */
  const lastSeqBySession = new Map<string, number>();
  /** seq 缺口后待 resume 的会话（补偿完成前丢弃其事件，防与补推重复应用）。 */
  const resyncing = new Set<string>();

  function setState(next: WebConnectionState): void {
    if (state === next || closed && next !== "closed") return;
    state = next;
    for (const listener of Array.from(stateListeners)) listener(state);
  }

  function disposeConnection(): void {
    client?.close(); // 在途调用立即 TRANSPORT_CLOSED（fail-fast）
    void currentTransport?.close(); // 同步关闭底层 socket（连接生命周期归本类所有）
    try {
      pendingSocket?.close();
    } catch {
      // close 前置失败（未开启等）：忽略，连接层自收敛
    }
    client = null;
    currentTransport = null;
    pendingSocket = null;
  }

  /**
   * 事件统一入口：seq 缺口检测（先于用户监听器）→ 分发。
   * delta 批量窗口与缺口检测的交互（06 §3.4 × §6.3）：message.delta 帧可能合并多条
   * （seq 取最新一条），跳变不丢信息——delta 帧只推进基线不判定缺口；其余会话事件
   * 逐帧投递（永不合并），跳变即真实丢帧 → onSeqGap。
   */
  function ingestEvent(name: string, payload: unknown): void {
    const record = (payload ?? {}) as Record<string, unknown>;
    const sessionId = typeof record["sessionId"] === "string" ? record["sessionId"] : null;
    const seq = typeof record["seq"] === "number" ? record["seq"] : null;
    if (sessionId !== null && seq !== null) {
      if (resyncing.has(sessionId)) return; // 补偿窗口内丢弃，防快照重建后重复应用
      const lastSeq = lastSeqBySession.get(sessionId);
      if (lastSeq !== undefined) {
        if (seq <= lastSeq) return; // 重复/迟到事件（快照补推后的余波）丢弃
        if (name !== "message.delta" && seq > lastSeq + 1) {
          resyncing.add(sessionId);
          for (const listener of Array.from(seqGapListeners)) {
            listener({ sessionId, lastSeen: lastSeq, incoming: seq });
          }
          return;
        }
      }
      lastSeqBySession.set(sessionId, seq);
    }
    const listeners = eventListeners.get(name);
    if (!listeners) return;
    for (const listener of Array.from(listeners)) {
      try {
        listener(payload);
      } catch (err) {
        console.error("[raincode/rpc web-client] event listener threw for", name, err);
      }
    }
  }

  async function handshake(rpc: RpcClient): Promise<void> {
    await rpc.call("ws.auth", { token: options.token }, { timeoutMs: 10_000 });
    await rpc.call("system.ping", {}, { timeoutMs: 10_000 }); // 版本协商 + 能力发现（06 §1.4）
  }

  /** 等待 socket 就绪（ws.auth 前置——CONNECTING 态发送即失败）；error/close 先到按失败收束。 */
  function waitOpen(socket: WsSocketLike): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      let settled = false;
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        fn();
      };
      if (typeof socket.on === "function") {
        socket.on("open", () => settle(resolvePromise));
        socket.on("close", () => settle(() => reject(new Error("closed before open"))));
        socket.on("error", (err) =>
          settle(() => reject(err instanceof Error ? err : new Error("socket error before open"))));
      } else if (typeof socket.addEventListener === "function") {
        socket.addEventListener("open", () => settle(resolvePromise));
        socket.addEventListener("close", () => settle(() => reject(new Error("closed before open"))));
        socket.addEventListener("error", () => settle(() => reject(new Error("socket error before open"))));
      } else {
        settle(() => reject(new Error("websocket socket exposes neither on() nor addEventListener()")));
      }
    });
  }

  async function connect(): Promise<void> {
    if (closed) return;
    if (state !== "connecting") setState("connecting");
    let nextSocket: WsSocketLike;
    try {
      nextSocket = options.connectSocket(options.url);
    } catch (err) {
      scheduleReconnect(err);
      return;
    }
    pendingSocket = nextSocket;
    try {
      await waitOpen(nextSocket);
    } catch (err) {
      pendingSocket = null;
      scheduleReconnect(err); // 连接拒绝/对端不可达：退避重连
      return;
    }
    pendingSocket = null;
    if (closed) return;
    const nextTransport = new WebSocketTransport({
      socket: nextSocket,
      role: "client",
      onSocketClose: () => {
        if (closed) return;
        disposeConnection();
        scheduleReconnect(null);
      },
    });
    currentTransport = nextTransport;
    const nextClient = createRpcClient({
      transport: nextTransport,
      defaultTimeoutMs: options.defaultTimeoutMs,
    });
    client = nextClient;
    // seq 基线全见：所有已登记事件（含 delta，其 seq 参与基线推进）统一经 ingestEvent；
    // 未订阅事件的 seq 不推进会导致缺口误判（06 §3.4 合并帧 seq 取最新，中间 seq 由 delta 帧桥接）
    for (const name of new Set([...Object.keys(EVENT_SCHEMAS), ...eventListeners.keys()])) {
      nextClient.onEvent(name, (payload) => ingestEvent(name, payload));
    }
    handshake(nextClient)
      .then(() => {
        if (closed || client !== nextClient) return; // 期间已断线/已关闭
        attempt = 0;
        lastSeqBySession.clear(); // 服务端可能重启，事件基线以 resume 补偿重建
        resyncing.clear();
        const wasReady = everReady;
        everReady = true;
        setState("ready");
        if (wasReady) {
          for (const listener of Array.from(restoredListeners)) listener();
        }
      })
      .catch((err: unknown) => {
        if (closed || client !== nextClient) return;
        if (err instanceof RpcCallError && err.code !== SYSTEM_ERROR_CODES.TIMEOUT
          && err.code !== SYSTEM_ERROR_CODES.TRANSPORT_CLOSED) {
          // 鉴权/协议级拒绝（如 UNAUTHORIZED）：重试无意义，上报端层并停机
          disposeConnection();
          setState("closed");
          closed = true;
          for (const listener of Array.from(fatalListeners)) listener(err);
          return;
        }
        scheduleReconnect(err);
      });
  }

  function scheduleReconnect(_cause: unknown): void {
    if (closed) return;
    attempt += 1;
    setState("reconnecting");
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect().catch(() => undefined);
    }, backoffMs(attempt));
  }

  void connect().catch(() => undefined); // 内部分支已自处理；兜底防未处理拒绝

  return {
    get state(): WebConnectionState {
      return state;
    },

    async call<T>(method: string, params?: unknown, opts?: RpcClientCallOptions): Promise<T> {
      if (closed || client === null) {
        throw new RpcCallError(
          SYSTEM_ERROR_CODES.TRANSPORT_CLOSED,
          `web client not connected (state=${state})`,
        );
      }
      return client.call<T>(method, params, opts);
    },

    onEvent(name: string, listener: (payload: unknown) => void): Unsubscribe {
      let listeners = eventListeners.get(name);
      if (!listeners) {
        listeners = new Set();
        eventListeners.set(name, listeners);
        // 已在连：立即挂到当前 RpcClient（重连时按 keys() 重挂）
        client?.onEvent(name, (payload) => ingestEvent(name, payload));
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) eventListeners.delete(name);
      };
    },

    onStateChange(listener: (state: WebConnectionState) => void): Unsubscribe {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },

    onRestored(listener: () => void): Unsubscribe {
      restoredListeners.add(listener);
      return () => {
        restoredListeners.delete(listener);
      };
    },

    onSeqGap(listener: (info: { sessionId: string; lastSeen: number; incoming: number }) => void): Unsubscribe {
      seqGapListeners.add(listener);
      return () => {
        seqGapListeners.delete(listener);
      };
    },

    onFatal(listener: (err: RpcCallError) => void): Unsubscribe {
      fatalListeners.add(listener);
      return () => {
        fatalListeners.delete(listener);
      };
    },

    setSeqBaseline(sessionId: string, seq: number): void {
      resyncing.delete(sessionId);
      lastSeqBySession.set(sessionId, seq);
    },

    close(): void {
      if (closed) return;
      closed = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      disposeConnection();
      stateListeners.clear();
      restoredListeners.clear();
      seqGapListeners.clear();
      fatalListeners.clear();
      eventListeners.clear();
      lastSeqBySession.clear();
      resyncing.clear();
      setState("closed");
    },
  };
}
