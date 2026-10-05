/**
 * SQLite 打开与迁移（05-database §3.0 / §6）。
 * better-sqlite3 同步内核；repo 层薄封装后对外一律 async（04 §2.1）。
 * 迁移：顺序编号脚本真源随代码入库（src/migrations/NNN_描述.sql），已应用禁止修改；
 * 每脚本整体一个事务，失败回滚并中止——宁可不可用，不带病运行。
 */
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import BetterSqlite3 from "better-sqlite3";

/** better-sqlite3 实例类型（@types/better-sqlite3 命名空间成员）。 */
export type SqliteDatabase = BetterSqlite3.Database;

export interface MigrationScript {
  version: number;
  name: string;
  sql: string;
}

/**
 * 迁移脚本目录：缺省随源码位置解析（dev/CLI）；打包形态（T2.9 esbuild bundle 内
 * import.meta.url shim 不可用）经 RAINCODE_MIGRATIONS_DIR 显式指向随包分发的 migrations 目录。
 */
function migrationsDir(): string {
  const override = process.env["RAINCODE_MIGRATIONS_DIR"];
  if (override !== undefined && override.length > 0) {
    return override;
  }
  return fileURLToPath(new URL("./migrations/", import.meta.url));
}

/** 迁移脚本清单（升序应用；新增脚本在此登记）。 */
export function loadMigrationScripts(): MigrationScript[] {
  const dir = migrationsDir();
  return [
    { version: 1, name: "001_init", sql: readFileSync(join(dir, "001_init.sql"), "utf8") },
    { version: 2, name: "002_permission", sql: readFileSync(join(dir, "002_permission.sql"), "utf8") },
    { version: 3, name: "003_memory", sql: readFileSync(join(dir, "003_memory.sql"), "utf8") },
    { version: 4, name: "004_history_fts", sql: readFileSync(join(dir, "004_history_fts.sql"), "utf8") },
  ];
}

/**
 * 版本表引导 DDL：与 001_init.sql 中定义逐字一致。
 * 迁移执行器先于脚本运行，需要表已存在才能读取版本——引导后 001 内 IF NOT EXISTS 幂等。
 */
const SCHEMA_MIGRATIONS_BOOTSTRAP_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  applied_at  INTEGER NOT NULL
);`;

/** 升序应用待执行脚本；任一脚本失败即抛错中止启动（05 §6）。 */
export function runMigrations(db: SqliteDatabase, scripts: MigrationScript[]): void {
  db.exec(SCHEMA_MIGRATIONS_BOOTSTRAP_DDL);
  const row = db
    .prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations")
    .get() as { v: number };
  const applied = row.v;

  for (const script of [...scripts].sort((a, b) => a.version - b.version)) {
    if (script.version <= applied) {
      continue;
    }
    db.exec("BEGIN");
    try {
      db.exec(script.sql);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        script.version,
        script.name,
        Date.now(),
      );
      db.exec("COMMIT");
    } catch (reason: unknown) {
      db.exec("ROLLBACK");
      throw new Error(`[MIGRATION_FAILED] migration ${script.name} failed: ${String(reason)}`, {
        cause: reason,
      });
    }
  }
}

/**
 * 打开全局单库（~/.raincode/raincode.db）并执行 §3.0 连接初始化 PRAGMA + 迁移。
 * 同步、毫秒级（NFR-1）；WAL 支撑多进程读 + 单写者。
 */
export function openDatabase(dataRoot: string): SqliteDatabase {
  mkdirSync(dataRoot, { recursive: true });
  const db = new BetterSqlite3(join(dataRoot, "raincode.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 3000");
  runMigrations(db, loadMigrationScripts());
  return db;
}
