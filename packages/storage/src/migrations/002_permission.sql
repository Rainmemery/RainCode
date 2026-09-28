-- 002_permission —— 命令权限控制三表（05-database §3.6/§3.7/§3.8 DDL 逐字段对齐，含索引）。
-- scope='session' 的规则驻内存不入库（02 §6.2 判定链第 3 级载体=内存，05 §9 差异 4）。

CREATE TABLE permission_rules (
  id            TEXT PRIMARY KEY,
  scope         TEXT NOT NULL CHECK (scope IN ('project','global')),
                -- scope='session' 的规则驻内存（02 §6.2 判定链第 3 级载体=内存），不入库
  workspace_id  TEXT REFERENCES workspaces(hash),  -- project 必填；global 为 NULL
  tool          TEXT NOT NULL,                   -- 工具名；bash 规则为 'bash'
  pattern       TEXT,                            -- 通配模式如 'git *'；NULL=匹配该工具全部调用
  behavior      TEXT NOT NULL CHECK (behavior IN ('allow','ask','deny')),
  source        TEXT NOT NULL CHECK (source IN ('user','allow-always','import')),
  created_at    INTEGER NOT NULL,
  CHECK ((scope = 'project') = (workspace_id IS NOT NULL))
);
CREATE UNIQUE INDEX ux_rules_scope ON permission_rules(
  scope, COALESCE(workspace_id, ''), tool, COALESCE(pattern, ''));
CREATE INDEX ix_rules_tool ON permission_rules(tool, scope);

CREATE TABLE approvals (
  grant_id        TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(hash),
  tool_name       TEXT NOT NULL,
  input_snapshot  TEXT NOT NULL,               -- 审批时归一化输入快照（approve-what-runs，02 §5.4；已脱敏）
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','denied','expired','cancelled')),
  response        TEXT,                        -- 'allow' | 'deny' | 'always'（02 §6.2 respond）
  timeout_at      INTEGER NOT NULL,            -- 默认 created_at + 120s（02 §6.4 审批单超时）
  created_at      INTEGER NOT NULL,
  responded_at    INTEGER
);
CREATE INDEX ix_approvals_session ON approvals(session_id, status);
CREATE INDEX ix_approvals_pending ON approvals(status, timeout_at) WHERE status = 'pending';

CREATE TABLE permission_decisions (
  id                 INTEGER PRIMARY KEY,      -- 追加型审计，rowid 自增即可
  ts                 INTEGER NOT NULL,
  session_id         TEXT NOT NULL,            -- 无外键：审计生命周期独立于会话删除
  workspace_id       TEXT NOT NULL,            -- 无外键：同理独立于 workspace 清理
  tool_name          TEXT NOT NULL,
  mode               TEXT NOT NULL CHECK (mode IN ('normal','plan','auto-accept')),
  decision           TEXT NOT NULL CHECK (decision IN ('allow','ask','deny')),
  matched_by         TEXT NOT NULL CHECK (matched_by IN
                       ('metadata','mode','session-rule','project-rule','global-rule','default')),
  rule_id            TEXT,                     -- 命中规则；matched_by='default' 时为 NULL
  grant_id           TEXT,                     -- decision='ask' 时对应 approvals.grant_id
  reason             TEXT NOT NULL DEFAULT '', -- 人类可读理由（02 §6.3 PermissionVerdict.reason）
  input_digest       TEXT NOT NULL DEFAULT '', -- 归一化输入摘要（脱敏，02 §6.3 decisions 记录清单）
  respond_latency_ms INTEGER,                  -- ask 应答时延；非 ask 为 NULL
  detail_json        TEXT,                     -- 结构化补充：越界路径（02 §5.3 outOfScopePaths）、env 覆盖等
  created_at         INTEGER NOT NULL
);
CREATE INDEX ix_decisions_ws_ts     ON permission_decisions(workspace_id, ts);
CREATE INDEX ix_decisions_session   ON permission_decisions(session_id, ts);
CREATE INDEX ix_decisions_tool      ON permission_decisions(tool_name, ts);
