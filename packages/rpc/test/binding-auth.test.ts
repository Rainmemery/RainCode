/**
 * createServiceBinding authGate 单测（T3.8 / 06 §6.3 第 3 条 + §4.2 UNAUTHORIZED）：
 * 连接级鉴权门时序（ws.auth → system.ping → 业务）、失败不开门、无门绑定零回归。
 * 以 in-memory 对驱动（门语义与传输载体无关）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createInMemoryTransportPair, createRpcClient, createServiceBinding, RpcCallError } from "../src/index.js";
import type { RpcMethodHandler } from "../src/index.js";

const fakeSchema = {
  safeParse: (v: unknown) => ({ success: true, data: v }),
} as unknown as RpcMethodHandler["schema"];

function handlerFor(result: unknown, throwOn?: () => never): RpcMethodHandler {
  return {
    schema: fakeSchema,
    handler: async () => {
      if (throwOn) throwOn();
      return result;
    },
  };
}

function wire(options: Parameters<typeof createServiceBinding>[1]): ReturnType<typeof createRpcClient> {
  const pair = createInMemoryTransportPair();
  createServiceBinding(pair[1], options);
  return createRpcClient({ transport: pair[0] });
}

test("authGate: 鉴权前一切请求 UNAUTHORIZED（含 system.ping，不泄露版本）", async () => {
  const client = wire({
    authGate: { method: "ws.auth" },
    methods: {
      "ws.auth": handlerFor({ ok: true }),
      "system.ping": handlerFor({ protocolVersion: "1.0", capabilities: [], serverTime: 0 }),
    },
  });
  await assert.rejects(
    client.call("system.ping", {}),
    (err: unknown) => err instanceof RpcCallError && err.code === "UNAUTHORIZED",
  );
  await assert.rejects(
    client.call("session.list", {}),
    (err: unknown) => err instanceof RpcCallError && err.code === "UNAUTHORIZED",
  );
  client.close();
});

test("authGate: 时序 ws.auth → system.ping → 业务方法全部受理", async () => {
  const client = wire({
    authGate: { method: "ws.auth" },
    methods: {
      "ws.auth": handlerFor({ ok: true }),
      "system.ping": handlerFor({ protocolVersion: "1.0", capabilities: [], serverTime: 0 }),
      "session.list": handlerFor({ items: ["a"] }),
    },
  });
  const auth = await client.call<{ ok: boolean }>("ws.auth", { token: "t" });
  assert.equal(auth.ok, true);
  await client.call("system.ping", {});
  const list = await client.call<{ items: string[] }>("session.list", {});
  assert.deepEqual(list.items, ["a"]);
  client.close();
});

test("authGate: 鉴权失败（handler 抛 UNAUTHORIZED）不开门，成功后立即受理", async () => {
  let shouldFail = true;
  const client = wire({
    authGate: { method: "ws.auth" },
    methods: {
      "ws.auth": {
        schema: fakeSchema,
        handler: async () => {
          if (shouldFail) throw new RpcCallError("UNAUTHORIZED", "invalid web auth token");
          return { ok: true };
        },
      },
      "system.ping": handlerFor({ protocolVersion: "1.0", capabilities: [], serverTime: 0 }),
    },
  });
  await assert.rejects(
    client.call("ws.auth", { token: "bad" }),
    (err: unknown) => err instanceof RpcCallError && err.code === "UNAUTHORIZED",
  );
  await assert.rejects(
    client.call("system.ping", {}),
    (err: unknown) => err instanceof RpcCallError && err.code === "UNAUTHORIZED",
  );
  shouldFail = false;
  await client.call("ws.auth", { token: "good" });
  await client.call("system.ping", {});
  client.close();
});

test("authGate: 缺省（无门）绑定零回归——ping 握手后业务直受理", async () => {
  const client = wire({
    methods: {
      "system.ping": handlerFor({ protocolVersion: "1.0", capabilities: [], serverTime: 0 }),
      "session.list": handlerFor({ items: [] }),
    },
  });
  await client.call("system.ping", {});
  await client.call("session.list", {});
  // 握手门仍生效：未 ping 前业务方法 VERSION_MISMATCH
  const client2 = wire({
    methods: { "session.list": handlerFor({ items: [] }) },
  });
  await assert.rejects(
    client2.call("session.list", {}),
    (err: unknown) => err instanceof RpcCallError && err.code === "VERSION_MISMATCH",
  );
  client.close();
  client2.close();
});
