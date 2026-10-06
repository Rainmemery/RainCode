/**
 * T6.1 marketplace 分发基座单测（07-dev-plan §12.2；06-api-spec §2.10 v1.14）：
 *   a) marketplace-fs：内容哈希确定性（种子文件排除）+ symlink/junction 逃逸防护（越界拒绝/根内放行）；
 *   b) RPC 全链（临时 RAINCODE_HOME + in-memory 节点）：add/list → install（缓存布局 + 种子 +
 *      plugins.list + 技能第三源）→ 重装幂等 → 种子篡改拒绝 → 逃逸拒绝 → 名称冲突拒绝 →
 *      uninstall 复原 → 重启台账重装配 → NOT_FOUND 族。
 * 不跑 LLM（技能可见性走 skills.list；invoke 链路由 smoke:marketplace 覆盖）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemoryTransportPair, createRpcClient, RpcCallError } from "@raincode/rpc";
import type { RpcClient } from "@raincode/rpc";
import { createAgentServiceNode } from "../src/index.js";
import type { AgentServiceNode } from "../src/index.js";
import { assertPluginTreeContainment, hashPluginTree, MarketplaceEscapeError } from "../src/marketplace-fs.js";

// ---------------------------------------------------------------------------
// 夹具：临时市场源目录（清单 + 插件）
// ---------------------------------------------------------------------------

const PLUGIN_ENTRY = "export function activate(){ return [{ name: 'ping', description: '市场插件工具', execute: async () => 'pong' }]; }";

interface MarketFixture {
  root: string;
  helloDir: string;
}

async function writeMarket(baseline: string, options?: { pluginVersion?: string }): Promise<MarketFixture> {
  const root = join(baseline, "market-src");
  const helloDir = join(root, "hello");
  await mkdir(helloDir, { recursive: true });
  await writeFile(
    join(root, "marketplace.json"),
    JSON.stringify({
      name: "test-market",
      version: "1.0.0",
      plugins: [
        {
          name: "hello",
          version: options?.pluginVersion ?? "0.1.0",
          source: "hello",
          description: "测试市场示例插件",
          displayName: "Hello 测试插件",
          category: "examples",
        },
      ],
    }),
    "utf8",
  );
  await writeFile(join(helloDir, "plugin.json"), JSON.stringify({ name: "hello", description: "市场示例插件", version: options?.pluginVersion ?? "0.1.0" }), "utf8");
  await writeFile(join(helloDir, "index.mjs"), PLUGIN_ENTRY, "utf8");
  await mkdir(join(helloDir, "skills"), { recursive: true });
  await writeFile(join(helloDir, "skills", "plugin-demo.md"), "---\nname: plugin-demo\ndescription: 市场随附技能演示\n---\n模板正文 $ARGUMENTS", "utf8");
  return { root, helloDir };
}

interface NodeScenario {
  home: string;
  client: RpcClient;
  node: AgentServiceNode;
  close: () => Promise<void>;
}

/** 装配 plugins + marketplace + skills 三域节点（无 LLM——本测不跑 turn）。 */
async function startNode(home: string): Promise<NodeScenario> {
  const transports = createInMemoryTransportPair();
  const node = await createAgentServiceNode(transports[1], {
    env: { RAINCODE_HOME: home },
    tools: { approval: "always-allow" },
    permission: { policy: "default-allow" },
    plugins: {},
    marketplace: {},
    skills: {},
  });
  const client = createRpcClient({ transport: transports[0] });
  await client.call("system.ping", {});
  return {
    home,
    client,
    node,
    close: async () => {
      client.close();
      await node.close();
      await transports[0].close();
      await transports[1].close();
    },
  };
}

// ---------------------------------------------------------------------------
// a) marketplace-fs 原语
// ---------------------------------------------------------------------------

test("hashPluginTree：同树同哈希 / 内容变更变哈希 / 种子文件不参与哈希", async () => {
  const base = await mkdtemp(join(tmpdir(), "raincode-mkt-hash-"));
  try {
    const { helloDir } = await writeMarket(base);
    const h1 = await hashPluginTree(helloDir);
    const h2 = await hashPluginTree(helloDir);
    assert.equal(h1, h2, "同树两次哈希一致（确定性）");
    await writeFile(join(helloDir, ".zcode-plugin-seed.json"), JSON.stringify({ bogus: true }), "utf8");
    assert.equal(await hashPluginTree(helloDir), h1, "种子文件不参与哈希");
    await rm(join(helloDir, ".zcode-plugin-seed.json"));
    await writeFile(join(helloDir, "index.mjs"), PLUGIN_ENTRY + "\n// changed", "utf8");
    assert.notEqual(await hashPluginTree(helloDir), h1, "内容变更 → 哈希变化");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("逃逸防护：junction 指向根外拒绝（含越界路径）/ 指向根内放行", async () => {
  const base = await mkdtemp(join(tmpdir(), "raincode-mkt-escape-"));
  try {
    const { helloDir } = await writeMarket(base);
    // 根外秘密目录 + 插件树内 junction 指向它 → 越界
    const outside = join(base, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "secret.txt"), "outside", "utf8");
    await symlink(outside, join(helloDir, "leak"), "junction");
    await assert.rejects(
      () => assertPluginTreeContainment(helloDir),
      (err: unknown) => err instanceof MarketplaceEscapeError && err.offendingPath.includes("leak"),
    );
    await rm(join(helloDir, "leak"));
    // 指向根内目录 → 放行（哈希照常产出）
    await symlink(join(helloDir, "skills"), join(helloDir, "skills-alias"), "junction");
    const hash = await hashPluginTree(helloDir);
    assert.match(hash, /^[0-9a-f]{64}$/, "根内 junction 放行且哈希产出");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// b) RPC 全链
// ---------------------------------------------------------------------------

test("marketplace RPC：add/list → install → 幂等/篡改/逃逸/冲突 → uninstall → 重启重装配", async () => {
  const home = await mkdtemp(join(tmpdir(), "raincode-mkt-rpc-"));
  const scenario = await startNode(home);
  try {
    const { root } = await writeMarket(home);
    const client = scenario.client;

    // add：注册 path 源市场（fail-fast 校验）
    const added = (await client.call("marketplace.add", { id: "test-mkt", source: { path: root } })) as {
      marketplace: { id: string; source: { path: string }; addedAt: number; name?: string };
    };
    assert.equal(added.marketplace.id, "test-mkt");
    assert.ok(added.marketplace.addedAt > 0);
    // 幂等：同 id 同源重复注册
    const again = (await client.call("marketplace.add", { id: "test-mkt", source: { path: root } })) as typeof added;
    assert.equal(again.marketplace.addedAt, added.marketplace.addedAt);
    // 相对路径 / 缺失目录 / 坏清单 → MARKETPLACE_INVALID
    await assert.rejects(client.call("marketplace.add", { id: "rel", source: { path: "rel/path" } }), isCode("MARKETPLACE_INVALID"));
    await assert.rejects(client.call("marketplace.add", { id: "missing", source: { path: join(home, "nope") } }), isCode("MARKETPLACE_INVALID"));

    // list：未安装投影
    const listed = (await client.call("marketplace.list", {})) as {
      marketplaces: Array<{ id: string; pluginCount: number; lastError: string | null; plugins: Array<{ name: string; installed: unknown }> }>;
    };
    assert.equal(listed.marketplaces.length, 1);
    assert.equal(listed.marketplaces[0]!.pluginCount, 1);
    assert.equal(listed.marketplaces[0]!.lastError, null);
    assert.equal(listed.marketplaces[0]!.plugins[0]!.installed, null, "未安装投影 null");

    // install：安装副本 + 种子 + plugins.list + 技能第三源
    const installed = (await client.call("marketplace.install", { marketplaceId: "test-mkt", plugin: "hello" })) as {
      name: string;
      version: string;
      dir: string;
      status: string;
    };
    assert.equal(installed.name, "hello");
    assert.equal(installed.status, "active");
    assert.ok(installed.dir.includes(join(home, "marketplaces", "cache", "test-mkt", "hello", "0.1.0")), "缓存布局 <marketplace>/<plugin>/<version>");
    const seedRaw = JSON.parse(await readFile(join(installed.dir, ".zcode-plugin-seed.json"), "utf8")) as { version: number; hash: string; plugin: string; pluginVersion: string };
    assert.equal(seedRaw.version, 1);
    assert.equal(seedRaw.plugin, "hello");
    assert.match(seedRaw.hash, /^[0-9a-f]{64}$/);
    const plugins = (await client.call("plugins.list", {})) as { plugins: Array<{ name: string; dir: string; status: string }> };
    const hello = plugins.plugins.find((p) => p.name === "hello");
    assert.ok(hello !== undefined && hello.status === "active", "安装副本经 PluginRuntime 激活");
    assert.equal(hello.dir, installed.dir);
    const skills = (await client.call("skills.list", {})) as { items: Array<{ name: string; source: string }> };
    assert.ok(skills.items.some((s) => s.name === "plugin-demo" && s.source === "plugin"), "技能第三源可见（source=plugin）");

    // 重装幂等：同版本同内容 → 同目录同状态
    const reinstall = (await client.call("marketplace.install", { marketplaceId: "test-mkt", plugin: "hello" })) as typeof installed;
    assert.equal(reinstall.dir, installed.dir);
    assert.equal(reinstall.status, "active");

    // 种子篡改 → MARKETPLACE_SEED_MISMATCH
    await writeFile(join(installed.dir, "index.mjs"), PLUGIN_ENTRY + "\n// tampered", "utf8");
    await assert.rejects(
      client.call("marketplace.install", { marketplaceId: "test-mkt", plugin: "hello" }),
      isCode("MARKETPLACE_SEED_MISMATCH"),
    );

    // 逃逸市场：junction 指向插件根外 → MARKETPLACE_ESCAPE_BLOCKED
    const escapeMarket = join(home, "escape-mkt");
    const escapePlugin = join(escapeMarket, "evil");
    await mkdir(escapePlugin, { recursive: true });
    await writeFile(join(escapeMarket, "marketplace.json"), JSON.stringify({ name: "escape", version: "1.0.0", plugins: [{ name: "evil", version: "1.0.0", source: "evil", description: "越界插件" }] }), "utf8");
    await writeFile(join(escapePlugin, "plugin.json"), JSON.stringify({ name: "evil", description: "越界插件", version: "1.0.0" }), "utf8");
    await symlink(join(home, "outside-secret-target"), join(escapePlugin, "leak"), "junction");
    await client.call("marketplace.add", { id: "escape-mkt", source: { path: escapeMarket } });
    await assert.rejects(
      client.call("marketplace.install", { marketplaceId: "escape-mkt", plugin: "evil" }),
      isCode("MARKETPLACE_ESCAPE_BLOCKED"),
    );

    // 清单一致性：plugin.json version 与市场登记版本不一致 → MARKETPLACE_INVALID
    const driftMarket = join(home, "drift-mkt");
    const driftPlugin = join(driftMarket, "drift");
    await mkdir(driftPlugin, { recursive: true });
    await writeFile(
      join(driftMarket, "marketplace.json"),
      JSON.stringify({ name: "drift", version: "1.0.0", plugins: [{ name: "drift", version: "2.0.0", source: "drift", description: "版本漂移插件" }] }),
      "utf8",
    );
    await writeFile(join(driftPlugin, "plugin.json"), JSON.stringify({ name: "drift", description: "版本漂移插件", version: "1.0.0" }), "utf8");
    await client.call("marketplace.add", { id: "drift-mkt", source: { path: driftMarket } });
    await assert.rejects(
      client.call("marketplace.install", { marketplaceId: "drift-mkt", plugin: "drift" }),
      (err: unknown) => err instanceof RpcCallError && err.code === "MARKETPLACE_INVALID" && err.message.includes("version"),
    );

    // NOT_FOUND 族：未知市场 / 未知插件
    await assert.rejects(client.call("marketplace.install", { marketplaceId: "nope", plugin: "hello" }), isCode("MARKETPLACE_NOT_FOUND"));
    await assert.rejects(client.call("marketplace.install", { marketplaceId: "test-mkt", plugin: "nope" }), isCode("MARKETPLACE_NOT_FOUND"));

    // uninstall：复原（plugins.list 不可见 / 技能第三源消失 / 缓存删除 / 台账清空 / 幂等拒绝）
    await client.call("plugins.setEnabled", { name: "hello", enabled: false }); // 先制造停用名单残留
    const removed = (await client.call("marketplace.uninstall", { marketplaceId: "test-mkt", plugin: "hello" })) as { removed: boolean };
    assert.equal(removed.removed, true);
    const afterPlugins = (await client.call("plugins.list", {})) as { plugins: Array<{ name: string }> };
    assert.ok(afterPlugins.plugins.every((p) => p.name !== "hello"), "卸载后插件记录移除");
    const afterSkills = (await client.call("skills.list", {})) as { items: Array<{ name: string }> };
    assert.ok(afterSkills.items.every((s) => s.name !== "plugin-demo"), "卸载后第三源技能消失");
    await assert.rejects(async () => readdir(join(home, "marketplaces", "cache", "test-mkt", "hello", "0.1.0")), "安装副本目录已删除");
    const ledgerRaw = JSON.parse(await readFile(join(home, "marketplaces", "installed.json"), "utf8")) as { installed: unknown[] };
    assert.equal(ledgerRaw.installed.length, 0, "台账清空");
    await assert.rejects(
      client.call("marketplace.uninstall", { marketplaceId: "test-mkt", plugin: "hello" }),
      isCode("MARKETPLACE_NOT_FOUND"),
    );

    // 卸载后重装恢复（停用名单残留已由 detachExternal 清除 → 直接 active）
    const reinstalled = (await client.call("marketplace.install", { marketplaceId: "test-mkt", plugin: "hello" })) as { status: string };
    assert.equal(reinstalled.status, "active", "卸载后重装恢复");

    await scenario.close();
    // 重启存活 + 名称冲突（第二节点同 home）：台账重装配 → 冲突拒绝 + 台账回滚
    const scenario2 = await startNode(home);
    try {
      const client2 = scenario2.client;
      const rebooted = (await client2.call("plugins.list", {})) as { plugins: Array<{ name: string; status: string; dir: string }> };
      const hello2 = rebooted.plugins.find((p) => p.name === "hello");
      assert.ok(hello2 !== undefined && hello2.status === "active", "重启后台账重装配激活");
      assert.ok(hello2.dir.includes(join(home, "marketplaces", "cache")), "重启后记录指向安装副本");

      // 名称冲突：plugins 目录发布同名 dir 插件 → 卸载市场记录后重扫描（dir 记录装载）→ 安装被拒
      const dirPlugin = join(home, "plugins", "hello");
      await mkdir(dirPlugin, { recursive: true });
      await writeFile(join(dirPlugin, "plugin.json"), JSON.stringify({ name: "hello", description: "目录发布插件" }), "utf8");
      const rescanList = (await client2.call("plugins.list", {})) as { plugins: Array<{ name: string }> };
      assert.ok(rescanList.plugins.some((p) => p.name === "hello"), "重启后台账重装配记录在位");
      await client2.call("marketplace.uninstall", { marketplaceId: "test-mkt", plugin: "hello" });
      await client2.call("plugins.rescan", {}); // 记录腾位后目录候选装载为 dir 来源记录
      await assert.rejects(
        client2.call("marketplace.install", { marketplaceId: "test-mkt", plugin: "hello" }),
        (err: unknown) => err instanceof RpcCallError && err.code === "MARKETPLACE_INVALID" && err.message.includes("conflict"),
        "dir 来源同名记录在位 → 安装拒绝",
      );
      const ledgerAfterConflict = JSON.parse(await readFile(join(home, "marketplaces", "installed.json"), "utf8")) as { installed: Array<{ plugin: string }> };
      assert.ok(ledgerAfterConflict.installed.every((r) => r.plugin !== "hello"), "冲突安装台账回滚");
    } finally {
      await scenario2.close();
    }
  } finally {
    await scenario.close().catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  }
});

/** RpcCallError 域码断言器。 */
function isCode(code: string): (err: unknown) => boolean {
  return (err: unknown) => err instanceof RpcCallError && err.code === code;
}
