/**
 * mcp 域装配降级单测（T3.9 桌面走查发现项回归锁定）：
 * mcp.json 损坏（MCP_CONFIG_INVALID）时 agent 节点必须照常装配——init 失败降级为
 * stderr 诊断 + mcp 域空转，不得以未处理拒绝崩掉 agent（此前为崩溃循环放弃）。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createInMemoryTransportPair, createRpcClient } from "@raincode/rpc";
import { createAgentServiceNode } from "../src/index.js";

const homes: string[] = [];
after(async () => {
  for (const home of homes.splice(0)) {
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("mcp.json 损坏 → 域降级不崩装配（T3.9 回归）", () => {
  it("损坏配置装配节点后 ping/list 可用，mcp.servers.list 为空投影", async () => {
    const home = await mkdtemp(join(tmpdir(), "raincode-mcp-degrade-"));
    homes.push(home);
    await writeFile(join(home, "mcp.json"), "{ broken", "utf8");
    const transports = createInMemoryTransportPair();
    const node = await createAgentServiceNode(transports[1], {
      env: { RAINCODE_HOME: home },
      provider: null,
      mcp: {},
    });
    try {
      const client = createRpcClient({ transport: transports[0] });
      const ping = await client.call<{ capabilities: string[] }>("system.ping", {});
      assert.ok(Array.isArray(ping.capabilities));
      const list = await client.call<{ servers: unknown[] }>("mcp.servers.list", {});
      assert.equal(list.servers.length, 0); // 域降级空投影，方法表仍在
      client.close();
    } finally {
      await node.close();
      await transports[0].close();
      await transports[1].close();
    }
  });

  it("生态兼容形态 mcp.json 正常装配（对照：不再误拒文档形态）", async () => {
    const home = await mkdtemp(join(tmpdir(), "raincode-mcp-eco-"));
    homes.push(home);
    // node 缺席 → 连接失败但注册成功；断言点在「不因 schema 缺 serverKey 字段拒载」
    await writeFile(
      join(home, "mcp.json"),
      JSON.stringify({ mcpServers: { eco: { transport: "stdio", command: "node", args: ["-e", ""] } } }),
      "utf8",
    );
    const transports = createInMemoryTransportPair();
    const node = await createAgentServiceNode(transports[1], {
      env: { RAINCODE_HOME: home },
      provider: null,
      mcp: {},
    });
    try {
      const client = createRpcClient({ transport: transports[0] });
      await client.call("system.ping", {}); // rpc 握手（首请求必须 system.ping）
      // init 为异步受理（受理即返语义）：轮询等待 eco 注册完成
      let eco: { serverKey: string; enabled: boolean } | undefined;
      for (let i = 0; i < 30 && eco === undefined; i += 1) {
        const list = await client.call<{ servers: Array<{ serverKey: string; enabled: boolean }> }>("mcp.servers.list", {});
        eco = list.servers.find((server) => server.serverKey === "eco");
        if (eco === undefined) await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(eco !== undefined, "生态形态 serverKey 由 map 键注入并注册");
      client.close();
    } finally {
      await node.close();
      await transports[0].close();
      await transports[1].close();
    }
  });
});
