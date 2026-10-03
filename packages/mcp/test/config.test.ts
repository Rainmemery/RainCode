/**
 * mcp config 加载单测（T3.9 桌面走查发现项回归锁定）：
 * 生态兼容文件形态（serverKey 由 map 键承载）/ 写回形态（条目内显式 serverKey）双形态解析，
 * 键不一致 / 非法条目 / 非法 JSON / 缺文件 / 跨层冲突的错误族。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { loadMcpConfig } from "../src/config.js";

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) {
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "raincode-mcp-config-"));
  homes.push(home);
  return home;
}

const stdioEntry = { transport: "stdio", command: "node", args: ["x.js"], enabled: true };

describe("loadMcpConfig 文件形态（T3.9 回归）", () => {
  it("生态兼容形态：serverKey 由 map 键承载，条目可省 serverKey 字段", async () => {
    const home = await tempHome();
    const path = join(home, "mcp.json");
    await writeFile(path, JSON.stringify({ mcpServers: { fixture: stdioEntry } }), "utf8");
    const loaded = await loadMcpConfig([{ path, level: "global" }]);
    assert.equal(loaded.configs.size, 1);
    const config = loaded.configs.get("fixture");
    assert.ok(config !== undefined);
    assert.equal(config.serverKey, "fixture"); // map 键注入
    assert.equal(config.transport, "stdio");
    assert.equal(config.level, "global");
  });

  it("写回形态：条目内显式 serverKey 与 map 键一致时兼容解析", async () => {
    const home = await tempHome();
    const path = join(home, "mcp.json");
    await writeFile(
      path,
      JSON.stringify({ mcpServers: { alpha: { serverKey: "alpha", ...stdioEntry } } }),
      "utf8",
    );
    const loaded = await loadMcpConfig([{ path, level: "global" }]);
    assert.equal(loaded.configs.get("alpha")?.serverKey, "alpha");
  });

  it("条目内 serverKey 与 map 键不一致 → MCP_CONFIG_INVALID（报告双方）", async () => {
    const home = await tempHome();
    const path = join(home, "mcp.json");
    await writeFile(
      path,
      JSON.stringify({ mcpServers: { alpha: { serverKey: "beta", ...stdioEntry } } }),
      "utf8",
    );
    await assert.rejects(
      loadMcpConfig([{ path, level: "global" }]),
      (err: unknown) =>
        err instanceof Error && (err as Error).message.includes('"beta" does not match map key "alpha"'),
    );
  });

  it("非法条目（stdio 缺 command）→ MCP_CONFIG_INVALID 且定位 serverKey", async () => {
    const home = await tempHome();
    const path = join(home, "mcp.json");
    await writeFile(path, JSON.stringify({ mcpServers: { broken: { transport: "stdio" } } }), "utf8");
    await assert.rejects(
      loadMcpConfig([{ path, level: "global" }]),
      (err: unknown) =>
        err instanceof Error && (err as Error).message.includes("[broken]") && (err as Error).message.includes("command"),
    );
  });

  it("非 JSON / 缺文件 → 非法拒绝 / 空配置起底", async () => {
    const home = await tempHome();
    const bad = join(home, "bad.json");
    await writeFile(bad, "{ not json", "utf8");
    await assert.rejects(
      loadMcpConfig([{ path: bad, level: "global" }]),
      (err: unknown) => err instanceof Error && (err as Error).message.includes("not valid JSON"),
    );
    const loaded = await loadMcpConfig([{ path: join(home, "missing.json"), level: "global" }]);
    assert.equal(loaded.configs.size, 0);
  });

  it("同名 serverKey 跨层冲突 → MCP_SERVER_CONFLICT（既有口径回归）", async () => {
    const home = await tempHome();
    const entry = JSON.stringify({ mcpServers: { dup: stdioEntry } });
    const globalPath = join(home, "global.json");
    const projectPath = join(home, "project.json");
    await writeFile(globalPath, entry, "utf8");
    await writeFile(projectPath, entry, "utf8");
    await assert.rejects(
      loadMcpConfig([
        { path: globalPath, level: "global" },
        { path: projectPath, level: "project" },
      ]),
      (err: unknown) => err instanceof Error && (err as Error).message.includes("duplicate serverKey"),
    );
  });
});
