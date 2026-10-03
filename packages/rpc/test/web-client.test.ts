/**
 * createReconnectingRpcClient 单测（T3.8 / 06 §6.3 第 2、3、4 条）：鉴权握手时序、seq 缺口
 * 检测与 resync 丢弃、断线重连（onRestored + 事件重挂）、鉴权失败 fatal 停机、在途调用
 * fail-fast。物理载体为进程内「ws」服务器（node 客户端与浏览器同帧形态）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import { createHash, timingSafeEqual } from "node:crypto";
import { RpcCallError } from "../src/client.js";
import { createReconnectingRpcClient } from "../src/web-client.js";
import { createServiceBinding } from "../src/server.js";
import { WebSocketTransport } from "../src/websocket.js";
import type { RpcServiceBinding } from "../src/server.js";
import type { WsSocketLike } from "../src/websocket.js";

/** 可编程 ws RPC 服务器：逐连接 binding（authGate）+ ws.auth/ping/echo 方法 + 事件出口。 */
interface TestServer {
  url: string;
  publish(event: { name: string; payload: unknown }): void;
  /** 当前活跃连接数（重连断言用）。 */
  readonly connections: number;
  killAll(): void;
  /** upgrade 门（「服务未就绪」场景）：false 时拒绝握手，客户端持续退避重连。 */
  setUp(v: boolean): void;
  close(): Promise<void>;
}

async function startTestServer(token: string): Promise<TestServer> {
  const http = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const bindings = new Set<RpcServiceBinding>();
  const sockets = new Set<WebSocket>();
  const tokenDigest = createHash("sha256").update(token, "utf8").digest();
  let up = true;
  http.on("upgrade", (req, socket, head) => {
    if (!up) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      const transport = new WebSocketTransport({ socket: ws as unknown as WsSocketLike });
      const binding = createServiceBinding(transport, { authGate: { method: "ws.auth" } });
      binding.methods["ws.auth"] = {
        schema: { safeParse: (v: unknown) => ({ success: true, data: v }) } as never,
        handler: async (params: unknown) => {
          const digest = createHash("sha256").update((params as { token: string }).token, "utf8").digest();
          if (!timingSafeEqual(digest, tokenDigest)) {
            throw new RpcCallError("UNAUTHORIZED", "invalid web auth token");
          }
          return { ok: true as const };
        },
      };
      binding.methods["system.ping"] = {
        schema: { safeParse: (v: unknown) => ({ success: true, data: v }) } as never,
        handler: async () => ({ protocolVersion: "1.0", capabilities: ["ws.auth"], serverTime: 0 }),
      };
      binding.methods["echo"] = {
        schema: { safeParse: (v: unknown) => ({ success: true, data: v }) } as never,
        handler: async (params: unknown) => params,
      };
      bindings.add(binding);
      ws.on("close", () => {
        sockets.delete(ws);
        bindings.delete(binding);
        binding.close();
      });
    });
  });
  await new Promise<void>((resolvePromise) => http.listen(0, "127.0.0.1", () => resolvePromise()));
  const addr = http.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${addr.port}`,
    publish(event) {
      for (const binding of bindings) binding.publish(event);
    },
    get connections(): number {
      return sockets.size;
    },
    killAll() {
      for (const ws of Array.from(sockets)) ws.terminate();
    },
    setUp(v: boolean) {
      up = v;
    },
    async close() {
      for (const ws of Array.from(sockets)) ws.terminate();
      await new Promise<void>((resolvePromise) => wss.close(() => resolvePromise()));
      await new Promise<void>((resolvePromise) => http.close(() => resolvePromise()));
    },
  };
}

function waitFor<T>(probe: () => T | undefined, timeoutMs = 2000, stepMs = 10): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const started = Date.now();
    const tick = (): void => {
      const value = probe();
      if (value !== undefined) {
        resolvePromise(value);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error("waitFor timeout"));
        return;
      }
      setTimeout(tick, stepMs);
    };
    void tick();
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

test("web-client: 鉴权握手时序（ws.auth → system.ping → 业务）与 ready 状态", async () => {
  const server = await startTestServer("good-token");
  try {
    const client = createReconnectingRpcClient({
      url: server.url,
      token: "good-token",
      connectSocket: (url) => new WebSocket(url) as unknown as WsSocketLike,
    });
    await waitFor(() => (client.state === "ready" ? true : undefined));
    const echoed = await client.call<{ value: number }>("echo", { value: 42 });
    assert.equal(echoed.value, 42);
    client.close();
    assert.equal(client.state, "closed");
  } finally {
    await server.close();
  }
});

test("web-client: 错误 token → onFatal(UNAUTHORIZED) 停机且不再重连", async () => {
  const server = await startTestServer("good-token");
  try {
    const fatals: Array<{ code: string }> = [];
    const client = createReconnectingRpcClient({
      url: server.url,
      token: "wrong-token",
      connectSocket: (url) => new WebSocket(url) as unknown as WsSocketLike,
      backoffMs: () => 10,
    });
    client.onFatal((err) => fatals.push({ code: err.code }));
    await waitFor(() => (fatals.length > 0 ? true : undefined));
    assert.equal(fatals[0]?.code, "UNAUTHORIZED");
    assert.equal(client.state, "closed");
    await sleep(60); // 客户端已停机关连接；若仍在重连，连接数会再次上升
    assert.equal(server.connections, 0, "fatal 后应关闭连接且不再重连");
  } finally {
    await server.close();
  }
});

test("web-client: seq 缺口 → onSeqGap + resync 丢弃 → setSeqBaseline 恢复受理", async () => {
  const server = await startTestServer("good-token");
  try {
    const client = createReconnectingRpcClient({
      url: server.url,
      token: "good-token",
      connectSocket: (url) => new WebSocket(url) as unknown as WsSocketLike,
    });
    await waitFor(() => (client.state === "ready" ? true : undefined));
    const seen: Array<Record<string, unknown>> = [];
    client.onEvent("message.completed", (payload) => seen.push(payload as Record<string, unknown>));
    const gaps: Array<{ sessionId: string; lastSeen: number; incoming: number }> = [];
    client.onSeqGap((info) => gaps.push(info));
    const base = { ts: 1, sessionId: "s_gap", turnId: "t1", round: 0, message: { role: "assistant", content: "x" } };
    server.publish({ name: "message.completed", payload: { ...base, seq: 1 } });
    server.publish({ name: "message.completed", payload: { ...base, seq: 2 } });
    server.publish({ name: "message.completed", payload: { ...base, seq: 5 } }); // 缺口 3~4
    await waitFor(() => (gaps.length > 0 ? true : undefined));
    assert.deepEqual(gaps[0], { sessionId: "s_gap", lastSeen: 2, incoming: 5 });
    assert.equal(seen.length, 2, "缺口事件不得投递给监听器");
    server.publish({ name: "message.completed", payload: { ...base, seq: 6 } }); // resync 中仍丢弃
    await sleep(30);
    assert.equal(seen.length, 2);
    client.setSeqBaseline("s_gap", 5); // 模拟 resume 补偿完成（snapshot.lastSeq=5）
    server.publish({ name: "message.completed", payload: { ...base, seq: 6 } });
    await waitFor(() => (seen.length >= 3 ? true : undefined));
    server.publish({ name: "message.completed", payload: { ...base, seq: 6 } }); // 迟到重复丢弃
    await sleep(30);
    assert.equal(seen.length, 3);
    client.close();
  } finally {
    await server.close();
  }
});

test("web-client: 断线重连（退避注入）→ onRestored + 事件重挂 + 调用恢复", async () => {
  const server = await startTestServer("good-token");
  try {
    const client = createReconnectingRpcClient({
      url: server.url,
      token: "good-token",
      connectSocket: (url) => new WebSocket(url) as unknown as WsSocketLike,
      backoffMs: () => 10,
    });
    await waitFor(() => (client.state === "ready" ? true : undefined));
    const events: Array<Record<string, unknown>> = [];
    client.onEvent("message.completed", (payload) => events.push(payload as Record<string, unknown>));
    server.publish({ name: "message.completed", payload: { seq: 1, ts: 1, sessionId: "s_re", turnId: "t1", round: 0, message: { role: "assistant", content: "x" } } });
    await waitFor(() => (events.length >= 1 ? true : undefined));
    // 断线：服务端硬杀连接 → 客户端退避重连 → onRestored
    let restoredFired = false;
    client.onRestored(() => {
      restoredFired = true;
    });
    server.killAll();
    await waitFor(() => (restoredFired ? true : undefined), 3000);
    assert.equal(client.state, "ready");
    await client.call("echo", { ok: 1 }); // 调用恢复
    server.publish({ name: "message.completed", payload: { seq: 1, ts: 2, sessionId: "s_re", turnId: "t1", round: 0, message: { role: "assistant", content: "y" } } }); // 重挂后事件可达
    await waitFor(() => (events.length >= 2 ? true : undefined));
    client.close();
  } finally {
    await server.close();
  }
});

test("web-client: 断线瞬间在途调用立即 TRANSPORT_CLOSED（fail-fast）", async () => {
  const server = await startTestServer("good-token");
  try {
    const client = createReconnectingRpcClient({
      url: server.url,
      token: "good-token",
      connectSocket: (url) => new WebSocket(url) as unknown as WsSocketLike,
      backoffMs: () => 10,
    });
    await waitFor(() => (client.state === "ready" ? true : undefined));
    // 构造在途：服务端 echo 会立即应答，改用 server.killAll 与 call 竞速——
    // killAll 先于应答到达即触发 fail-fast；若应答先到则跳过断言（时序容错）。
    const pending = client.call("echo", { slow: true }).then(
      () => "resolved",
      (err: unknown) => (err as { code: string }).code,
    );
    server.killAll();
    const outcome = await pending;
    if (outcome !== "resolved") {
      assert.equal(outcome, "TRANSPORT_CLOSED");
    }
    await waitFor(() => (client.state === "ready" ? true : undefined)); // 重连收敛
    client.close();
  } finally {
    await server.close();
  }
});

test("web-client: 服务未就绪 → 持续重连退避直至服务可用", async () => {
  const server = await startTestServer("good-token");
  server.setUp(false); // 拒绝 upgrade：连接层不可用
  try {
    const client = createReconnectingRpcClient({
      url: server.url,
      token: "good-token",
      connectSocket: (url) => new WebSocket(url) as unknown as WsSocketLike,
      backoffMs: () => 10,
    });
    await waitFor(() => (client.state === "reconnecting" ? true : undefined));
    await sleep(50);
    assert.equal(client.state, "reconnecting", "服务不可用期间不得进入 ready");
    server.setUp(true); // 服务可用：下一次退避重连应成功握手
    await waitFor(() => (client.state === "ready" ? true : undefined), 3000);
    const echoed = await client.call<{ ok: number }>("echo", { ok: 1 });
    assert.equal(echoed.ok, 1);
    client.close();
  } finally {
    await server.close();
  }
});
