-- 003_memory —— 项目记忆系统（T2.4）。
-- DDL 逐字段对齐 05-database 设计真源：
--   §3.9 memory_entries（含 CHECK 约束与两个索引）；
--   §5.3 memory_fts trigram external-content 虚表 + insert/delete/update 三触发器（§5.2 分词决策）；
--   §3.11 settings 运行期 KV（含记忆抽取幂等键 memory.extracted.<sessionId>，§5.4 末行）。
-- 跨项目串味防线（02 §7.4）：所有业务查询强制带 workspace_id 过滤，由 repo 层落实。

CREATE TABLE memory_entries (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(hash),
  kind          TEXT NOT NULL CHECK (kind IN ('decision','convention','pitfall','preference','todo')),
  content       TEXT NOT NULL CHECK (length(content) <= 200),  -- 单句要点 ≤200 字（02 §7.3）
  refs_json     TEXT NOT NULL DEFAULT '[]',    -- 关联文件路径 / 会话 id 数组（02 §7.3 refs）
  confidence    REAL NOT NULL DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
  source        TEXT NOT NULL CHECK (source IN ('session-end','compact','manual','memory-agent')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded')),
  superseded_by TEXT REFERENCES memory_entries(id),  -- 矛盾条目旧者标记（02 §7.4）
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL               -- 重复确认时间，淘汰依据
);
CREATE INDEX ix_memory_ws_kind ON memory_entries(workspace_id, status, kind);
CREATE INDEX ix_memory_ws_conf ON memory_entries(workspace_id, status, confidence DESC);

-- trigram 分词：3 字符滑窗倒排，天然支持中文子串匹配（§5.2）；
-- external-content 只存倒排不存正文，条目变更经触发器同步，无内容双写。
CREATE VIRTUAL TABLE memory_fts USING fts5(
  content,
  content = 'memory_entries',
  content_rowid = 'rowid',
  tokenize = 'trigram'
);

CREATE TRIGGER memory_fts_insert AFTER INSERT ON memory_entries BEGIN
  INSERT INTO memory_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER memory_fts_delete AFTER DELETE ON memory_entries BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER memory_fts_update AFTER UPDATE OF content ON memory_entries BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO memory_fts(rowid, content) VALUES (new.rowid, new.content);
END;

-- 迁移完成即重建倒排，保证与主表一致（05 §6 启动迁移流程第 4 步）
INSERT INTO memory_fts(memory_fts) VALUES ('rebuild');

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,                 -- 点分命名，如 'memory.extracted.<sessionId>'
  value      TEXT NOT NULL,                    -- JSON 值
  updated_at INTEGER NOT NULL
);
