/**
 * WebHost 单测（T3.8 / 06 §6.3）：ws upgrade 鉴权门逐连接生效（token 常数时间比较）、
 * 事件多连接扇出、连接断开解绑、静态资源服务（/ 与路径穿越防护）、纯 WS 端点提示。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { createAgentServiceNode } from "../src/node.js";
import { WebHost } from "../src/web-host.js";
import { createRpcClient } from "../../rpc/src/client.js";
import { WebSocketTransport } from "../../rpc/src/websocket.js";
import type { WsSocketLike } from "../../rpc/src/websocket.js";
import type { RpcClient } from "../../rpc/src/client.js";

interface ClientConn {
  client: RpcClient;
  close: () => Promise<void>;
}

/** 连接 WebHost：完整客户端时序（ws.auth → system.ping）。 */
async function connectClient(url: string, token: string): Promise<ClientConn> {
  const ws = new WebSocket(`${url}/ws`);
  await new Promise<void>((resolvePromise, reject) => {
    ws.once("open", resolvePromise);
    ws.once("error", reject);
  });
  const transport = new WebSocketTransport({ socket: ws as unknown as WsSocketLike, role: "client" });
  const client = createRpcClient({ transport, defaultTimeoutMs: 5000 });
  await client.call("ws.auth", { token });
  await client.call("system.ping", {});
  return {
    client,
    close: async () => {
      client.close();
      await transport.close();
    },
  };
}

interface HostFixture {
  host: WebHost;
  url: string;
  httpUrl: string;
  close: () => Promise<void>;
}

async function startHost(options: { token?: string; staticDir?: string } = {}): Promise<HostFixture> {
  const node = await createAgentServiceNode(undefined, {
    env: { RAINCODE_HOME: await mkdtemp(join(tmpdir(), "raincode-webhost-")) },
    permission: { policy: "default-allow" },
    tools: { approval: "always-allow" },
  });
  const host = new WebHost({
    node,
    port: 0,
    token: options.token ?? "test-token",
    ...(options.staticDir !== undefined && { staticDir: options.staticDir }),
    heartbeatIntervalMs: 0, // 单测关闭心跳定时器（不留 open handle）
    onDiagnostic: () => undefined,
  });
  await host.start();
  const url = host.url;
  return {
    host,
    url,
    httpUrl: `http://127.0.0.1:${host.port}`,
    close: async () => {
      await host.stop();
      await node.close();
    },
  };
}

test("web-host: 无 token / 错 token → ws.auth 拒绝且门不开（ping 亦拒）", async () => {
  const fixture = await startHost({ token: "right-token" });
  try {
    const ws = new WebSocket(`${fixture.url}/ws`);
    await new Promise<void>((resolvePromise) => ws.once("open", resolvePromise));
    const transport = new WebSocketTransport({ socket: ws as unknown as WsSocketLike, role: "client" });
    const client = createRpcClient({ transport, defaultTimeoutMs: 5000 });
    await assert.rejects(client.call("system.ping", {}), (err: unknown) => {
      assert.equal((err as { code: string }).code, "UNAUTHORIZED");
      return true;
    });
    await assert.rejects(client.call("ws.auth", { token: "wrong" }), (err: unknown) => {
      assert.equal((err as { code: string }).code, "UNAUTHORIZED");
      return true;
    });
    await assert.rejects(client.call("system.ping", {}), (err: unknown) => {
      assert.equal((err as { code: string }).code, "UNAUTHORIZED");
      return true;
    });
    client.close();
    await transport.close();
  } finally {
    await fixture.close();
  }
});

test("web-host: 正确 token → 全链可用；连接断开解绑（connectionCount 归零）", async () => {
  const fixture = await startHost();
  try {
    const conn = await connectClient(fixture.url, "test-token");
    assert.equal(fixture.host.connectionCount, 1);
    await conn.close();
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 60));
    assert.equal(fixture.host.connectionCount, 0);
  } finally {
    await fixture.close();
  }
});

test("web-host: 事件多连接扇出（两个客户端均收到 session.created）", async () => {
  const fixture = await startHost();
  try {
    const c1 = await connectClient(fixture.url, "test-token");
    const c2 = await connectClient(fixture.url, "test-token");
    assert.equal(fixture.host.connectionCount, 2);
    const got1: unknown[] = [];
    const got2: unknown[] = [];
    c1.client.onEvent("session.created", (payload) => got1.push(payload));
    c2.client.onEvent("session.created", (payload) => got2.push(payload));
    // default-allow 装配下 session.create 可直呼（无 provider 也可建会话）
    await c1.client.call("session.create", { workspaceRoot: process.cwd() });
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 120));
    assert.equal(got1.length, 1, `c1 实得 ${got1.length}`);
    assert.equal(got2.length, 1, `c2 实得 ${got2.length}`);
    await c1.close();
    await c2.close();
  } finally {
    await fixture.close();
  }
});

test("web-host: 静态资源——/ 返回 index.html；未知路径 404；穿越 403", async () => {
  const dir = await mkdtemp(join(tmpdir(), "raincode-web-static-"));
  await mkdir(join(dir, "assets"), { recursive: true });
  await writeFile(join(dir, "index.html"), "<html><body>workbench</body></html>");
  await writeFile(join(dir, "assets", "app.js"), "console.log(1)");
  const fixture = await startHost({ staticDir: dir });
  try {
    assert.equal((await fetch(`${fixture.httpUrl}/index.html`)).status, 200);
    const index = await (await fetch(`${fixture.httpUrl}/index.html`)).text();
    assert.equal(index, "<html><body>workbench</body></html>");
    const root = await (await fetch(`${fixture.httpUrl}/`)).text();
    assert.equal(root, "<html><body>workbench</body></html>");
    const script = await (await fetch(`${fixture.httpUrl}/assets/app.js`)).text();
    assert.equal(script, "console.log(1)");
    const missing = await fetch(`${fixture.httpUrl}/nope.js`);
    assert.equal(missing.status, 404);
    const escaped = await fetch(`${fixture.httpUrl}/..%2f..%2fpackage.json`);
    assert.ok(escaped.status === 403 || escaped.status === 404, `穿越应被拒，实得 ${escaped.status}`);
  } finally {
    await fixture.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("web-host: 未启用 staticDir → HTTP 421 纯 WS 端点提示", async () => {
  const fixture = await startHost();
  try {
    const res = await fetch(`${fixture.httpUrl}/`);
    assert.equal(res.status, 421);
    assert.ok((await res.text()).includes("websocket"));
  } finally {
    await fixture.close();
  }
});
