/**
 * SettingsRepo：settings 表薄 repo 层（05-database §3.11 DDL 逐字段对齐）。
 * 运行期 KV：只存非配置类状态（记忆抽取幂等键、最近打开 workspace 等）；
 * 配置真源永远是 config.json / mcp.json，凡 zod config schema 定义的键不得写入本表（防双写）。
 */
import type { SqliteDatabase } from "./db.js";

export class SettingsRepo {
  constructor(private readonly db: SqliteDatabase) {}

  /** 读取键值；不存在返回 null。 */
  async get(key: string): Promise<string | null> {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  /** 写入键值（upsert：ON CONFLICT 覆盖并刷新 updated_at，05 §3.11）。 */
  async set(key: string, value: string): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, Date.now());
  }
}
