-- 004_history_fts —— 会话历史检索索引（T5.3 记忆与历史检索增强）。
-- 索引对象：各会话 events.jsonl 的 message 行内容「part 级」（文本块 + 工具调用名，02 §7；
-- tool_result 正文与 reasoning 不入索引）。正文真源仍是 JSONL 事件流（05 §1.2 真源与投影原则
-- 不变），本表是可重建的派生索引：按会话自「上次扫描字节偏移」增量回填（versioned 增量迁移，
-- 进度存 settings 键 history.idx.<sessionId>，INDEX_VERSION 变更即整会话重扫）。
--
-- 附：memory_entries 增 scope 列（T5.3 预留，02 §7.4 全局记忆 L2 条目扩展位）——
-- 只留存储位不接线业务：召回默认集与 FTS 触发器均不感知该列（跨项目全局条目入召回留后续）。

-- ---------------------------------------------------------------------------
-- 会话历史 part 索引（05-database §3.12）
-- ---------------------------------------------------------------------------

CREATE TABLE history_parts (
  id           INTEGER PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(hash),
  seq          INTEGER NOT NULL,             -- 源 JSONL message 行 seq（行内定位）
  part_index   INTEGER NOT NULL,             -- 行内块序（0 起；UNIQUE 支撑重扫幂等）
  kind         TEXT NOT NULL CHECK (kind IN ('text','tool')),
  role         TEXT NOT NULL CHECK (role IN ('user','assistant','tool')),
  content      TEXT NOT NULL,                -- text：块正文；tool：工具名
  ts           INTEGER NOT NULL,             -- 源行 ts
  UNIQUE (session_id, seq, part_index)
);
CREATE INDEX ix_history_parts_ws ON history_parts(workspace_id, id);

-- trigram 分词：与 memory_fts 同选型（3 字符滑窗倒排，中文子串匹配，05 §5.2）；
-- external-content 只存倒排不存正文，part 变更经触发器同步（写入方唯一 = HistorySearchRepo）。
CREATE VIRTUAL TABLE history_fts USING fts5(
  content,
  content = 'history_parts',
  content_rowid = 'id',
  tokenize = 'trigram'
);

CREATE TRIGGER history_fts_insert AFTER INSERT ON history_parts BEGIN
  INSERT INTO history_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER history_fts_delete AFTER DELETE ON history_parts BEGIN
  INSERT INTO history_fts(history_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;

-- ---------------------------------------------------------------------------
-- memory_entries.scope 列预留（T5.3）
-- ---------------------------------------------------------------------------

ALTER TABLE memory_entries ADD COLUMN scope TEXT NOT NULL DEFAULT 'workspace'
  CHECK (scope IN ('workspace','global'));
