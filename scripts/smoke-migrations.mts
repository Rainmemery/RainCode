/**
 * storage 迁移回放 smoke（M2 T2.5 验收：002 迁移回放测试，05-database §6）。
 * 运行：tsx scripts/smoke-migrations.mts（或 pnpm run smoke:migrations）
 *
 * 链路：临时 RAINCODE_HOME → Storage.open（空库全量迁移 001→002→003）→ 功能探针断言
 * （settings 键值 / memory_entries / permission_rules 均可用且可写）→ 关闭重开幂等
 * （数据保留、版本不重复执行）→ 模拟 001+002 时代存量库（better-sqlite3 直开 raincode.db：
 * DROP 003 三表 + DELETE schema_migrations version=3）→ 重开重放 003 → 断言 003 表恢复、
 * 002 permission_rules 数据行原样保留（旧库升级路径不丢数据）。
 *
 * 全程仅临时目录：无外呼、无真实数据。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage, openDatabase, resolveDataRoot } from "../packages/storage/src/index.ts";

async function main(): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "raincode-smoke-migrations-"));
  const env = { RAINCODE_HOME: home };
  try {
    // ---- t1 空库全量迁移：001→002→003 依次应用，各域表功能可用 ----
    const s1 = await Storage.open({ env });
    const ws = await s1.ensureWorkspace(join(home, "ws"));
    await s1.settings.set("probe.key", "probe-value-1");
    const rule = await s1.permissionRules.add({
      scope: "global",
      workspaceId: null,
      tool: "write",
      pattern: null,
      behavior: "allow",
      source: "user",
    });
    const entry = await s1.memory.insert({
      workspaceId: ws.hash,
      kind: "decision",
      content: "迁移回放探针条目",
      refs: [],
      confidence: 0.9,
      source: "manual",
    });
    await s1.close();
    console.log("t1: 空库全量迁移 OK（settings/permission_rules/memory_entries 可写）");

    // ---- t2 幂等重开：已应用脚本不重复执行，数据保留 ----
    const s2 = await Storage.open({ env });
    assert.equal(await s2.settings.get("probe.key"), "probe-value-1", "t2：settings 数据应跨开合保留");
    assert.ok((await s2.memory.list(ws.hash, {})).items.some((item) => item.id === entry.id), "t2：memory 条目应保留");
    const rulesAfterReopen = await s2.permissionRules.list({});
    assert.ok(rulesAfterReopen.some((row) => row.id === rule.id), "t2：permission 规则应保留");
    await s2.close();
    console.log("t2: 重开幂等 OK（版本不重复执行，数据保留）");

    // ---- t3 存量库升级路径：模拟 001+002 时代库（003 起的表全部缺失 + 版本行缺失）→ 重放 003→004 ----
    const raw = openDatabase(resolveDataRoot(env));
    const before = (
      raw.prepare("SELECT COUNT(*) AS n FROM permission_rules").get() as { n: number }
    ).n;
    assert.equal(before, 1, "t3 前置：002 规则行应存在");
    // T5.3 起迁移版本 ≥4：模拟旧时代库必须降版本行到 2 并连带落 004 表（否则 MAX(version) 仍为 4，003 不回放）
    raw.exec("DROP TABLE IF EXISTS history_fts");
    raw.exec("DROP TABLE IF EXISTS history_parts");
    raw.exec("DROP TABLE IF EXISTS memory_fts");
    raw.exec("DROP TABLE IF EXISTS memory_entries");
    raw.exec("DROP TABLE IF EXISTS settings");
    raw.prepare("DELETE FROM schema_migrations WHERE version >= 3").run();
    raw.close();

    const s3 = await Storage.open({ env }); // 重放 003→004（001/002 已应用不回改）
    assert.equal(await s3.settings.get("probe.key"), null, "t3：settings 表重建后为空（003 回放语义）");
    const ruleAfterReplay = (await s3.permissionRules.list({})).find((row) => row.id === rule.id);
    assert.ok(ruleAfterReplay !== undefined, "t3：002 数据行应在 003 重放后原样保留（不丢数据）");
    const entryAfterReplay = (await s3.memory.list(ws.hash, {})).items.some((item) => item.id === entry.id);
    assert.equal(entryAfterReplay, false, "t3：003 表重建后旧条目不复活（重建而非恢复）");
    await s3.memory.insert({
      workspaceId: ws.hash,
      kind: "convention",
      content: "重放后新写入",
      refs: [],
      confidence: 1.0,
      source: "manual",
    }); // 重建表可正常写入
    await s3.close();
    console.log("t3: 存量库（001+002）升级重放 003→004 OK（表恢复、002 数据保留、可正常写入）");

    console.log("");
    console.log("SMOKE OK");
  } finally {
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((reason: unknown) => {
  console.error("");
  console.error("SMOKE FAILED:", reason);
  process.exitCode = 1;
});
