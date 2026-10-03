/**
 * WebSocketTransport 单测（T3.8）：每条 WS 文本消息一帧 / 畸形帧按角色处置（server 回
 * PARSE_ERROR / client 丢弃）/ delta 批量窗口（与 stdio 共用 delta-window）/ close 语义 /
 * 对端断开回调 / node「ws」与浏览器 addEventListener 双事件面（06 §6.1、§6.3）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import { WebSocketTransport } from "../src/websocket.js";
import type { WsSocketLike } from "../src/websocket.js";
import type { RpcFrame } from "../src/transport.js";

/** 可编程结构面替身：inbound 队列手动派发（双事件面），outbound 记录出站帧。 */
interface FakeSocket extends WsSocketLike {
  inbound(message: string): void;
  outbound: string[];
  fireClose(): void;
}

function createFakeSocket(): FakeSocket {
  const outbound: string[] = [];
  let messageListener: ((ev: { data?: unknown }) => void) | null = null;
  let closeListener: (() => void) | null = null;
  const socket: FakeSocket = {
    send: (data: string) => outbound.push(data),
    close: () => closeListener?.(),
    addEventListener: (type, listener) => {
      if (type === "message") messageListener = listener as (ev: { data?: unknown }) => void;
      if (type === "close") closeListener = listener as () => void;
      return undefined;
    },
    inbound: (message: string) => messageListener?.({ data: message }),
    outbound,
    fireClose: () => closeListener?.(),
  };
  return socket;
}

function deltaFrame(seq: number, text: string): RpcFrame {
  return {
    kind: "event",
    name: "message.delta",
    payload: { seq, ts: 1_700_000_000_000 + seq, sessionId: "s1", turnId: "t1", round: 0, delta: { type: "text", text } },
  } as RpcFrame;
}

test("websocket: 帧编解码往返 + node ws 驱动（echo server）", async () => {
  const http = createServer();
  const wss = new WebSocketServer({ noServer: true });
  http.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => ws.on("message", (data) => ws.send(data.toString())));
  });
  await new Promise<void>((resolvePromise) => http.listen(0, "127.0.0.1", () => resolvePromise()));
  const addr = http.address() as AddressInfo;
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}`);
    await new Promise<void>((resolvePromise) => ws.once("open", resolvePromise));
    const transport = new WebSocketTransport({ socket: ws as unknown as WsSocketLike, role: "client" });
    const received: RpcFrame[] = [];
    transport.onFrame((frame) => received.push(frame));
    const request: RpcFrame = {
      kind: "request",
      id: "req-000001",
      method: "session.cancel",
      params: { sessionId: "s1", reason: "中文原因" },
    };
    transport.send(request);
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 50));
    assert.deepEqual(received[0], request); // JSON 序列化往返 + 中文安全
    await transport.close();
  } finally {
    await new Promise<void>((resolvePromise) => wss.close(() => resolvePromise()));
    await new Promise<void>((resolvePromise) => http.close(() => resolvePromise()));
  }
});

test("websocket: server 角色——畸形带 id 帧 → PARSE_ERROR response；无 id 丢弃不断开", async () => {
  const socket = createFakeSocket();
  const transport = new WebSocketTransport({ socket });
  socket.inbound("not-json-{");
  socket.inbound(JSON.stringify({ kind: "nope", id: "req-000009" }));
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
  assert.equal(socket.outbound.length, 1, `出站 ${JSON.stringify(socket.outbound)}`);
  const parsed = JSON.parse(socket.outbound[0] ?? "{}") as { kind: string; id: string; ok: boolean; error?: { code: string } };
  assert.equal(parsed.kind, "response");
  assert.equal(parsed.id, "req-000009");
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error?.code, "PARSE_ERROR");
  // 无 id 畸形帧：仅 stderr 告警，不断开（仍可继续收发）
  socket.inbound(JSON.stringify({ kind: "request", id: "req-000010", method: "system.ping", params: {} }));
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
  assert.equal(transport.isClosed, false);
  await transport.close();
});

test("websocket: client 角色——畸形入帧一律丢弃（不出站、不断开）", async () => {
  const socket = createFakeSocket();
  const transport = new WebSocketTransport({ socket, role: "client" });
  socket.inbound("not-json-{");
  socket.inbound(JSON.stringify({ kind: "nope", id: "req-000011" }));
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
  assert.deepEqual(socket.outbound, []);
  assert.equal(transport.isClosed, false);
  await transport.close();
});

test("websocket: delta 批量窗口合并（同键拼接）与非 delta 帧 flush 边界", async () => {
  const socket = createFakeSocket();
  const transport = new WebSocketTransport({ socket, role: "client", deltaWindowMs: 30 });
  const received: RpcFrame[] = [];
  transport.onFrame((frame) => received.push(frame));
  transport.send(deltaFrame(1, "你"));
  transport.send(deltaFrame(2, "好"));
  transport.send({ kind: "event", name: "done", payload: { seq: 3, ts: 1, sessionId: "s1" } });
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 80));
  // done（边界事件）先于窗口到期 flush：delta 合并为一帧后紧随，顺序 delta → done
  const deltaIdx = socket.outbound.findIndex((raw) => raw.includes("message.delta"));
  const doneIdx = socket.outbound.findIndex((raw) => raw.includes('"name":"done"'));
  assert.ok(deltaIdx !== -1 && doneIdx !== -1, `出站 ${JSON.stringify(socket.outbound)}`);
  assert.ok(deltaIdx < doneIdx, "delta 帧必须先于边界事件出站");
  const merged = JSON.parse(socket.outbound[deltaIdx] ?? "{}") as { payload: { delta: { text: string }; seq: number } };
  assert.equal(merged.payload.delta.text, "你好");
  assert.equal(merged.payload.seq, 2); // seq/ts 取最新
  assert.equal(received.length, 0); // 本端 send 不回环到本端监听器
  await transport.close();
});

test("websocket: close flush 未决 delta 并标记关闭；close 后 send 抛 TRANSPORT_CLOSED", async () => {
  const socket = createFakeSocket();
  const transport = new WebSocketTransport({ socket, role: "client", deltaWindowMs: 5_000 });
  transport.send(deltaFrame(1, "pending"));
  await transport.close("shutdown");
  const deltaRaw = socket.outbound.find((raw) => raw.includes("message.delta"));
  assert.ok(deltaRaw !== undefined, "close 必须 flush 窗口内未决 delta");
  assert.equal(transport.isClosed, true);
  assert.throws(() => transport.send({ kind: "event", name: "done", payload: { seq: 2, ts: 2, sessionId: "s1" } }), /TRANSPORT_CLOSED/);
});

test("websocket: 对端断开 → isClosed + onSocketClose 回调（node ws 真实 terminate）", async () => {
  const http = createServer();
  const wss = new WebSocketServer({ noServer: true });
  let serverSide: WebSocket | null = null;
  http.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      serverSide = ws;
    });
  });
  await new Promise<void>((resolvePromise) => http.listen(0, "127.0.0.1", () => resolvePromise()));
  const addr = http.address() as AddressInfo;
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}`);
    await new Promise<void>((resolvePromise) => ws.once("open", resolvePromise));
    let closedFired = false;
    const transport = new WebSocketTransport({
      socket: ws as unknown as WsSocketLike,
      role: "client",
      onSocketClose: () => {
        closedFired = true;
      },
    });
    serverSide?.terminate();
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 80));
    assert.equal(transport.isClosed, true);
    assert.equal(closedFired, true);
  } finally {
    await new Promise<void>((resolvePromise) => wss.close(() => resolvePromise()));
    await new Promise<void>((resolvePromise) => http.close(() => resolvePromise()));
  }
});
