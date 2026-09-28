-- 001_init —— walking skeleton 初始 schema。
-- DDL 逐字段对齐 05-database §3.1/§3.2/§3.3；本波只建三表（task 裁剪），
-- tool_calls / permission_rules 等随后续波次以新编号脚本追加（05 §6：编号只增不复用）。

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,               -- 顺序版本号，单调递增
  name        TEXT NOT NULL,                     -- 脚本名，如 '001_init'
  applied_at  INTEGER NOT NULL
);

CREATE TABLE workspaces (
  hash            TEXT PRIMARY KEY,              -- workspaceHash（05 §2.3）= 02 所称 workspaceId
  root_path       TEXT NOT NULL UNIQUE,          -- 规范化绝对路径
  name            TEXT NOT NULL DEFAULT '',      -- 展示名，默认取目录名
  created_at      INTEGER NOT NULL,
  last_opened_at  INTEGER NOT NULL
);

CREATE TABLE sessions (
  id                 TEXT PRIMARY KEY,           -- 会话 id（ULID），主/子会话同一命名空间
  workspace_id       TEXT NOT NULL REFERENCES workspaces(hash),
  kind               TEXT NOT NULL DEFAULT 'main' CHECK (kind IN ('main','subagent')),
  parent_session_id  TEXT REFERENCES sessions(id),  -- 子会话回链主会话（02 §4.1 隔离派生）
  title              TEXT NOT NULL DEFAULT '',   -- 用户可改（真源）；缺省由首条输入派生
  preview            TEXT NOT NULL DEFAULT '',   -- 最后一条消息摘要（投影列，列表 UI）
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  mode               TEXT NOT NULL DEFAULT 'normal' CHECK (mode IN ('normal','plan','auto-accept')),
  message_count      INTEGER NOT NULL DEFAULT 0, -- 投影列：settle 对账，NFR-7 校验口径
  checkpoint_offset  INTEGER NOT NULL DEFAULT 0, -- 最近 checkpoint 行起始字节偏移（05 §4.4）
  epoch              INTEGER NOT NULL DEFAULT 0, -- 压缩代次（02 §1.2.5 单调合并）
  turns_count        INTEGER NOT NULL DEFAULT 0,
  input_tokens       INTEGER NOT NULL DEFAULT 0, -- TokenUsage 累计（投影列）
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  last_active_at     INTEGER NOT NULL,
  archived_at        INTEGER
);

CREATE INDEX IF NOT EXISTS ix_sessions_ws_active ON sessions(workspace_id, status, last_active_at DESC);
CREATE INDEX IF NOT EXISTS ix_sessions_parent    ON sessions(parent_session_id)
                                                  WHERE parent_session_id IS NOT NULL;
