# RainCode 数据库设计（05-database）

| 项目 | 内容 |
| --- | --- |
| 文档版本 | v0.1（设计稿） |
| 发布日期 | 2026-09-28 |
| 文档状态 | 设计稿，随 02-module-design / 04-architecture 评审同步更新；**校准注记 2026-10-03**：已随 M1~M3 实现校准（迁移集演进为 001~003，JSONL/表形态以 `packages/storage` 实现为准，见 legacy-items L-13） |
| 关联文档 | 01-PRD（AC-5、NFR-5/7）· 02-module-design（实体与字段语义的权威来源）· 04-architecture（§2 storage 包边界、§5 配置体系、§7 ADR） |
| 读者 | `packages/storage` 实现者、各领域包消费方 |

> 本文是 02/04 中引用的「03-data-model（存储设计）」的正式落位文档（目录编号顺延为 05）。定义范围：SQLite 表结构（better-sqlite3 / WAL）、JSONL 会话事件流、记忆索引、迁移策略与数据保留。
> **边界**：存储实现唯一归属 `packages/storage`（04 §2.4 铁律 2：storage 之外禁止直接触碰 fs/sqlite）。本文只定义数据形态，不含实现代码（SQL DDL / JSON 示例除外）。
> 术语沿用 02 §0.3（Turn、单写者、三态、Compact、epoch）；新增术语 **workspaceHash**：工作区绝对路径规范化后的稳定哈希，即 02 各接口中的 `workspaceId`（生成规则见 §2.3）。

---

## 1. 存储总览

### 1.1 四类存储载体

| 载体 | 物理位置 | 承载内容 | 角色 | 选型理由 |
| --- | --- | --- | --- | --- |
| SQLite（better-sqlite3，WAL） | `~/.raincode/raincode.db`（单库） | 会话元数据与索引、工具调用索引、子代理运行记录、权限规则、审批单、审计、记忆条目、MCP 运行态、运行期 KV、迁移版本 | 结构化可查询数据的唯一真源；其中会话侧统计/索引列为 JSONL 投影（可重算） | 同步 API 免连接池、单文件嵌入即用、毫秒级打开（NFR-1）；WAL 支撑多进程读 + 单写者；ADR-01 |
| JSONL 追加流 | `workspaces/<hash>/sessions/<id>/events.jsonl` | 会话全部事实：消息、工具调用与结果、审批与控制事件、checkpoint | **会话历史唯一真源**（ADR-09）；SQLite 中会话侧数据皆为其索引/投影 | 追加写天然抗强杀（NFR-7）；逐行即分帧；增量重放满足恢复 ≤1s（NFR-5） |
| Markdown | `<workspace>/.raincode/MEMORY.md`、`agents/*.md` | 项目记忆第一层（人机共维护）、子代理 profile | 文件即真源（02 §7.4「以文件为准」） | 人工可读可编辑、可入版本管理；Agent 只做读-改-写 |
| 文件（配置） | `config.json`、`mcp.json`、`secrets.json`（降级） | 配置层级（04 §5.1/5.2）、MCP 服务器清单、凭据降级存储 | 配置真源；SQLite 不复制配置（防双写） | zod strict 校验 + 三级就近覆盖；API Key 默认走系统凭据库，文件只存 `apiKeyRef`（04 §5.3） |

### 1.2 真源与投影原则

- **真源最小集**：JSONL 事件流（会话历史）、`config.json` / `mcp.json`（配置）、`MEMORY.md`（项目记忆 L1）、以及 SQLite 中的独立真源表（`permission_rules`、`permission_decisions`、`approvals`、`memory_entries`、`schema_migrations`、`workspaces`）。
- **投影集**：`sessions` 统计列（message_count / token 累计 / preview / checkpoint_offset / epoch）、`tool_calls`、`subagent_runs`、`mcp_servers` 均为索引或运行态投影，可从 JSONL / 运行期事件全量重建；checkpoint 行是可重建的派生快照（ADR-09「状态无双写」）。
- 投影允许短暂滞后（turn settle 时对账回写），一致性优先级永远让位于真源完整性；崩溃后恢复流程（§4.4）负责重新对账。

### 1.3 明确不做

- 不引入 ORM / 迁移框架之外的持久化抽象；不建宽表（列只服务 02 已定义的实体语义）。
- 不在 SQLite 存消息正文副本（防状态双写，见 §3.4「为什么没有 messages 表」）。
- 不做 embeddings / 向量索引库（02 §7.1 明确划出记忆边界，P2 起经 `search()` 接口再议）。
- 不做跨设备同步与遥测（01-PRD 本地优先约束）。

---

## 2. 目录布局

### 2.1 全局数据根 `~/.raincode/`

```text
~/.raincode/
├── raincode.db                    # 全局 SQLite 单库（WAL，§3）
├── raincode.db-wal / -shm         # WAL 伴生文件
├── MEMORY.md                      # 全局记忆（T5.3：跨项目层，双层注入 global 先 workspace 后，02 §7.4）
├── config.json                    # 全局配置（04 §5.2，含 providers / activeProviderId / compaction）
├── mcp.json                       # 全局 MCP 服务器清单（04 §5.1，结构=02 §3.3 McpServerConfig）
├── secrets.json                   # 可选：凭据降级存储（0600，用户显式选择，04 §5.3）
├── agents/                        # 全局子代理 profile（02 §4.3）
│   └── <name>.md                  # markdown + YAML frontmatter
├── workspaces/                    # 项目级数据，按 workspaceHash 目录隔离
│   └── <workspaceHash>/
│       ├── sessions/
│       │   ├── <sessionId>/       # 会话目录（02 §1.2.2 C1「初始化会话目录与 JSONL 事件文件」）
│       │   │   ├── events.jsonl   # 会话事件流：唯一事实源（§4）
│       │   │   ├── attachments/   # TurnCommand.attachments 落盘（JSONL 内只存相对引用）
│       │   │   └── background/    # 后台任务产出 <taskId>.out（02 §5.3 readOutput）
│       │   ├── archive/           # 归档会话包 <sessionId>.tgz（§4.5）
│       │   └── orphan/            # 损坏会话隔离区（03-ui-design「会话恢复失败」）
├── backups/                       # 破坏性迁移前自动备份（§6）
│   └── pre-migration-v<NN>-<ts>.db
└── logs/                          # 运行日志（脱敏后滚动，保留 7 天；凭据类信息永不落盘，04 §5.3）
```

CLI 与桌面端共享同一份 `~/.raincode/`（03-ui-design：本地单源，双端切换无同步成本）。

### 2.2 项目级目录 `<workspace>/.raincode/`

```text
<workspace>/
└── .raincode/
    ├── config.json                # 项目级配置（覆盖全局，04 §5.1 层级②）
    ├── mcp.json                   # 项目级 MCP 清单（就近覆盖全局同名 serverKey）
    ├── MEMORY.md                  # 项目记忆 L1，唯一真源（02 §7.1/7.3 章节模板）
    └── agents/                    # 项目级子代理 profile
        └── <name>.md
```

项目级目录只放**人可读/人可编辑**的文件；会话事实与结构化数据全部在 `~/.raincode/workspaces/<hash>/`，保证「仓库内点目录干净、数据可整体清理」。

### 2.3 workspaceHash 生成规则

1. 取 `workspaceRoot` 绝对路径，`realpath` 解析符号链接（失败回退原值）；
2. 规范化：路径分隔符统一为 `/`；Windows 下整体转小写（NTFS 大小写不敏感）并展开 8.3 短路径名；
3. 去除尾部分隔符；
4. `sha256(规范化路径)` 取前 16 个十六进制字符，即 workspaceHash，亦即 02 接口中的 `workspaceId`。

```typescript
// 规则示意（非实现代码）
workspaceHash = sha256(normalize(realpath(root))).slice(0, 16);
```

- 同一项目以不同盘符大小写 / 斜杠风格打开 → 同一 hash；目录改名 → 新 hash（旧数据保留，经清理入口处理，§7）。
- 64-bit 哈希在个人规模下冲突可忽略；`workspaces.root_path` UNIQUE 约束兜底，插入冲突即报错。
- 所有跨项目查询强制携带 workspaceId（02 §7.4 防串味），storage 端口对域表 prepared statement 统一注入该条件（§3.0）。

---

## 3. SQLite 表结构

### 3.0 通用约定与连接初始化

- 主键：TEXT（ULID，时间有序）；审计表例外用 rowid 自增。
- 时间：INTEGER，unix 毫秒；布尔：INTEGER 0/1。
- workspace 域表：除 `workspaces`、`schema_migrations`、`settings`、`mcp_servers` 外均带 `workspace_id`；storage 端口对所有域表查询强制注入 `workspace_id = ?`。
- 会话侧连接初始化（打开数据库时执行一次）：

```sql
PRAGMA journal_mode = WAL;      -- 多进程读 + 单写者；崩溃后 WAL 自动回放
PRAGMA synchronous  = NORMAL;   -- WAL 下的安全/性能平衡点
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 3000;     -- CLI 与桌面 agent 双进程并存时兜底
```

以下 DDL 归属首个迁移脚本 `001_init.sql`（脚本组织见 §6），可直接执行。

### 3.1 workspaces —— 工作区登记

```sql
CREATE TABLE workspaces (
  hash            TEXT PRIMARY KEY,              -- workspaceHash（§2.3）= 02 所称 workspaceId
  root_path       TEXT NOT NULL UNIQUE,          -- 规范化绝对路径
  name            TEXT NOT NULL DEFAULT '',      -- 展示名，默认取目录名
  created_at      INTEGER NOT NULL,
  last_opened_at  INTEGER NOT NULL
);
```

| 字段 | 用途 |
| --- | --- |
| hash / root_path | workspaceId ↔ 路径双向解析；orphan 展示、清理入口、memory_entries 归属均依赖本表 |
| last_opened_at | 会话选择器按「最近使用项目」排序 |

设计理由：workspaceHash 隔离是项目级数据的编址基础，必须有全局登记点。

### 3.2 schema_migrations —— 迁移版本

```sql
CREATE TABLE schema_migrations (
  version     INTEGER PRIMARY KEY,               -- 顺序版本号，单调递增
  name        TEXT NOT NULL,                     -- 脚本名，如 '001_init'
  applied_at  INTEGER NOT NULL
);
```

设计理由：版本真源入库而非 `PRAGMA user_version`，便于携带脚本名审计（策略见 §6）。

### 3.3 sessions —— 会话元数据

```sql
CREATE TABLE sessions (
  id                 TEXT PRIMARY KEY,            -- 会话 id（ULID），主/子会话同一命名空间
  workspace_id       TEXT NOT NULL REFERENCES workspaces(hash),
  kind               TEXT NOT NULL DEFAULT 'main' CHECK (kind IN ('main','subagent')),
  parent_session_id  TEXT REFERENCES sessions(id),-- 子会话回链主会话（02 §4.1 隔离派生）
  title              TEXT NOT NULL DEFAULT '',    -- 用户可改（真源）；缺省由首条输入派生
  preview            TEXT NOT NULL DEFAULT '',    -- 最后一条消息摘要（投影列，列表 UI）
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  mode               TEXT NOT NULL DEFAULT 'normal' CHECK (mode IN ('normal','plan','auto-accept')),
  message_count      INTEGER NOT NULL DEFAULT 0,  -- 投影列：settle 对账，NFR-7 校验口径
  checkpoint_offset  INTEGER NOT NULL DEFAULT 0,  -- 最近 checkpoint 行起始字节偏移（§4.4）
  epoch              INTEGER NOT NULL DEFAULT 0,  -- 压缩代次（02 §1.2.5 单调合并）
  turns_count        INTEGER NOT NULL DEFAULT 0,
  input_tokens       INTEGER NOT NULL DEFAULT 0,  -- TokenUsage 累计（投影列）
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  last_active_at     INTEGER NOT NULL,
  archived_at        INTEGER
);
CREATE INDEX ix_sessions_ws_active ON sessions(workspace_id, status, last_active_at DESC);
CREATE INDEX ix_sessions_parent    ON sessions(parent_session_id)
                                    WHERE parent_session_id IS NOT NULL;
```

| 字段 | 用途 |
| --- | --- |
| status | 对应 02 §1.2.2 生命周期：`Created` 仅存在于创建事务内，落盘即 `active`；`archived` 只读 |
| mode | 协作模式快照，恢复会话时还原（02 §6.2 判定链第 2 级） |
| checkpoint_offset / epoch | 恢复 O(1) 定位 + 压缩代次守卫（§4.4），是 sessions 被写入最频繁的两个投影列 |
| message_count / tokens / preview | 会话列表与恢复对账（NFR-7 的「消息计数一致」校验直接比对 message_count） |

设计理由：会话列表、`--resume` 选择、恢复定位都是高频索引型访问，必须落 SQLite；其余事实留在 JSONL。

**为什么没有 messages 表**：JSONL 是会话历史唯一真源（ADR-09），SQLite 再存正文即状态双写。消息级访问一律走 JSONL 重放；跨会话检索类需求由投影表（sessions / tool_calls）与 P2 派生索引承担，不在 P0 引入。

### 3.4 tool_calls —— 工具调用索引

```sql
CREATE TABLE tool_calls (
  id            TEXT PRIMARY KEY,                -- toolCallId（02 §2.3 ToolResult）
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(hash),
  tool_name     TEXT NOT NULL,
  source        TEXT NOT NULL DEFAULT 'builtin' CHECK (source IN ('builtin','mcp','plugin')),
  outcome       TEXT NOT NULL CHECK (outcome IN ('ok','error','denied','timeout','cancelled')),
  is_error      INTEGER NOT NULL DEFAULT 0,      -- 模型可见错误
  truncated     INTEGER NOT NULL DEFAULT 0,      -- 输出超 maxOutputBytes 被裁剪
  duration_ms   INTEGER NOT NULL DEFAULT 0,
  jsonl_offset  INTEGER NOT NULL,                -- 结果行字节偏移，回溯 JSONL 原文
  created_at    INTEGER NOT NULL
);
CREATE INDEX ix_tool_calls_session ON tool_calls(session_id, created_at);
CREATE INDEX ix_tool_calls_ws_tool ON tool_calls(workspace_id, tool_name, created_at);
```

| 字段 | 用途 |
| --- | --- |
| outcome | `denied`=权限拒绝（T10）、`cancelled`=中断聚合（T12）、`timeout`=沙箱超时，覆盖 02 §1.2.1 全部收敛路径 |
| jsonl_offset | 索引表不存入参与正文；需要原文时按偏移回读 JSONL 单行 |

设计理由：跨会话的工具用量统计与「该会话用过哪些工具」是典型索引型查询，逐次解析 JSONL 不可接受；正文不落库避免双写。

### 3.5 subagent_runs —— 子代理运行记录

```sql
CREATE TABLE subagent_runs (
  id              TEXT PRIMARY KEY,              -- SubagentId（02 §4.3）
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,   -- 主会话
  sub_session_id  TEXT UNIQUE REFERENCES sessions(id),                       -- 子会话（kind='subagent'）
  workspace_id    TEXT NOT NULL REFERENCES workspaces(hash),
  profile_name    TEXT NOT NULL,
  task_excerpt    TEXT NOT NULL DEFAULT '',      -- 任务前 200 字；全文在子会话 events.jsonl 首条 user 消息
  status          TEXT NOT NULL DEFAULT 'Pending'
                  CHECK (status IN ('Pending','Running','Completed','Failed','Stopped')),
  summary         TEXT NOT NULL DEFAULT '',      -- SubagentResult.summary，完成通知正文
  turns_used      INTEGER NOT NULL DEFAULT 0,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  finished_at     INTEGER
);
CREATE INDEX ix_subagent_runs_session ON subagent_runs(session_id, created_at);
```

| 字段 | 用途 |
| --- | --- |
| status | 枚举与 02 §4.3 `SubagentHandle.status` 逐字一致（S1~S6 迁移表的状态集合） |
| sub_session_id | 子代理复用同一内核工厂派生独立会话，因此拥有真实 sessions 行；本表只是运行维度的索引 |

设计理由：主会话需要展示「派发了哪些子代理、结果如何、花了多少 token」，这些是跨子会话的聚合计问。

### 3.6 permission_rules —— 权限规则（真源）

```sql
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
```

| 字段 | 用途 |
| --- | --- |
| scope / workspace_id | project 规则跟随 workspace（判定链第 4 级）；global 为用户全局偏好（第 5 级） |
| pattern | 仅对 bash 求值器有意义（02 §6.4：非 bash 工具误配即校验拒绝）；高危根命令不允许被通配 allow，属求值器逻辑，不靠存储约束 |
| source | `allow-always` 审批闭环的规则落点，`removeRule` 即时撤销（02 §6.4） |

设计理由：allow-always 是运行期高频写入且需优先级合并（04 §5.1），必须入库而非 config.json；唯一索引防同键规则重复。

### 3.7 approvals —— 审批单（未决态真源）

```sql
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
```

设计理由：02 §6.4 要求「审批单持久化；恢复会话时未决审批重新弹出」，pending 态必须有自己的真源；`input_snapshot` 是执行竞态防护（审批通过后命令已变即拒绝）的数据基础。

### 3.8 permission_decisions —— 三态判定审计（真源）

```sql
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
```

设计理由：审计是合规回溯的唯一凭据，逐条 append-only、永不随业务数据级联删除（因此刻意不设外键）；字段与 02 §6.3 注释的 decisions 记录清单逐项对应。

### 3.9 memory_entries —— 会话记忆条目（真源）

```sql
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
  last_seen_at  INTEGER NOT NULL,              -- 重复确认时间，淘汰依据
  scope         TEXT NOT NULL DEFAULT 'workspace' CHECK (scope IN ('workspace','global'))
                                               -- T5.3 预留：跨项目全局条目扩展位（004 迁移增列）
);
CREATE INDEX ix_memory_ws_kind ON memory_entries(workspace_id, status, kind);
CREATE INDEX ix_memory_ws_conf ON memory_entries(workspace_id, status, confidence DESC);
```

| 字段 | 用途 |
| --- | --- |
| status / superseded_by | 02 §7.4「矛盾条目以 lastSeenAt 新者保留并标记 superseded」的落地；superseded 不入召回 |
| confidence | `< 0.6` 不入召回默认集（02 §7.4 幻觉防线） |
| refs_json | JSON 数组而非子表：条目 ≤ 200 字、refs 个数小，拆表收益不抵复杂度 |
| scope | T5.3 存储位预留（004 迁移 `ALTER TABLE` 增列）：v1 业务只写缺省 `'workspace'`，跨项目全局条目（scope='global'）入召回留后续接线，02 §7.4 注记 |

设计理由：memory_entries 是 SQLite 内少数独立真源表之一（JSONL 只提供抽取素材），字段与 02 §7.3 `MemoryEntry` 一一对应；FTS 索引见 §5。

### 3.10 mcp_servers —— MCP 运行态注册表（投影）

```sql
CREATE TABLE mcp_servers (
  server_key        TEXT PRIMARY KEY,          -- [a-z0-9_-]（02 §3.3），即命名空间键
  transport         TEXT NOT NULL CHECK (transport IN ('stdio','http','sse')),
  enabled           INTEGER NOT NULL DEFAULT 1,
  status            TEXT NOT NULL DEFAULT 'disconnected'
                    CHECK (status IN ('disconnected','connecting','connected','reconnecting','failed')),
  tool_count        INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  last_connected_at INTEGER,
  updated_at        INTEGER NOT NULL
);
```

设计理由：**配置真源是 `mcp.json` 文件（04 §5.1），本表不做配置双写**——只承载合并加载后的运行期注册与连接状态（02 §3.2 状态机投影），启动时按配置重建，供 UI 面板与故障隔离展示。工具清单不入库：ToolRegistry 是运行期对象，调用事实已在 JSONL / tool_calls。

### 3.11 settings —— 运行期 KV

```sql
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,                 -- 点分命名，如 'ui.lastWorkspaceHash'
  value      TEXT NOT NULL,                    -- JSON 值
  updated_at INTEGER NOT NULL
);
```

设计理由：只存**非配置类**运行期状态（最近打开的 workspace、崩溃标记等）；配置真源永远是 config.json / mcp.json，凡 zod config schema 定义的键一律不得写入本表（防双写）。

### 3.12 history_parts —— 会话历史 part 索引（派生，T5.3）

```sql
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

CREATE VIRTUAL TABLE history_fts USING fts5(
  content,
  content = 'history_parts',
  content_rowid = 'id',
  tokenize = 'trigram'
);
-- AFTER INSERT / AFTER DELETE 触发器同步倒排（同 §5.3 memory_fts 形态，004 迁移）
```

设计理由：会话历史唯一真源仍是各会话 events.jsonl（§1.2），本表为**可重建派生索引**——索引对象是 message 行的 part 级内容（文本块 + tool_call 工具名；tool_result 正文与 reasoning 不入，02 §7 口径）。增量迁移（versioned）：检索前按 workspace 全会话自 settings 键 `history.idx.<sessionId>`（JSON `{v, offset}`）记录的字节偏移续扫新行，`HISTORY_INDEX_VERSION` 变更 → 整会话删除重扫；`UNIQUE + INSERT OR IGNORE` 使重扫与并发回填幂等；半行尾不推进偏移（Buffer 层 0x0A 分界，多字节安全）。写入方唯一 = HistorySearchRepo（不经触发器以外的旁路）。

---

## 4. JSONL 会话流格式

### 4.1 文件与命名

- 路径：`~/.raincode/workspaces/<workspaceHash>/sessions/<sessionId>/events.jsonl`。
- 单会话单文件，UTF-8，每行一条记录、行内不含裸换行（JSON 字符串转义保证）。
- 写者唯一：持有该会话写权的 runtime（02 单写者语义）；多端订阅不产生第二个写者（04 §3.2）。

### 4.2 行格式（三类）

每行一个 JSON 对象，信封统一为 `{v, type, seq, ts, ...}`；`v` 为格式版本，`seq` 为会话内单调递增行号，`ts` 为 unix 毫秒。

| type | 写入时机 | 内容 |
| --- | --- | --- |
| `message` | 消息定稿时（用户输入、助手完整响应、工具结果、系统通知） | 会话历史事实 |
| `event` | 非消息类持久事件（审批、模式切换、压缩报告、子代理生命周期、后台任务、错误） | 会话流内事实记录 |
| `checkpoint` | 每 turn settle 追加一条 | 派生快照（可重建） |

流式 delta（`text_delta` 等）**不落盘**：它们是 UI 瞬态事件，落盘粒度是单条消息（01-PRD §6.3 / 04 NFR-7），delta 重放既无必要也会撑爆文件。

```jsonl
{"v":1,"type":"event","seq":1,"ts":1769587200000,"name":"session.created","payload":{"workspaceHash":"9f1c3a2b7d4e5f60","root":"d:/work/api","raincodeVersion":"0.1.0"}}
{"v":1,"type":"message","seq":2,"ts":1769587203500,"message":{"id":"msg_01J9","role":"user","content":[{"type":"text","text":"修复 login 401"}],"attachments":[]}}
{"v":1,"type":"message","seq":3,"ts":1769587205200,"message":{"id":"msg_01JA","role":"assistant","content":[{"type":"text","text":"先看仓库状态。"},{"type":"tool_call","toolCallId":"tc_01","name":"bash","arguments":{"command":"git status"}}]}}
{"v":1,"type":"message","seq":4,"ts":1769587208100,"message":{"id":"msg_01JB","role":"tool","toolCallId":"tc_01","content":"On branch main","isError":false}}
{"v":1,"type":"event","seq":5,"ts":1769587260000,"name":"approval.requested","payload":{"grantId":"g_01","toolName":"bash","inputSnapshot":{"command":"npm publish"}}}
{"v":1,"type":"checkpoint","seq":6,"ts":1769587261000,"epoch":0,"pos":1841,"state":{"mode":"normal","todo":[],"messageCount":4,"usage":{"inputTokens":3120,"outputTokens":87}}}
```

约定：
- 工具调用以 `tool_call` 块内嵌于 assistant 消息，结果为独立 `role:"tool"` 消息（`toolCallId` 关联），与 02 §2.3 的 ToolResult 语义一致。
- checkpoint 的 `pos` = 该行写入后的文件字节数（= 下一条待写行偏移）；`epoch` 为压缩代次；`state` 内是 todo、协作模式等派生快照。
- `compaction.pruned`（T5.4 microcompact 预剪枝）：storage 级事件（不经 RPC 发布、协议零变更、不携带 epoch 不推进压缩代次）；payload `{prunerId, epoch, replacements[{sourceMessageId, toolCallId, toolName, charsBefore, charsAfter, prunedContent}], charsRemoved, tokensSaved, tokensBefore}`；`sourceMessageId` 回指原文 message 行，`prunedContent` 内联剪后内容（head+marker+tail，02 §1.2.5），原文保留于 JSONL（`session_search` 可召回）。

### 4.3 追加写协议

1. 打开会话即以追加模式持有文件句柄，句柄随单写者生命周期关闭；关闭前经流内单写者链**排空在途写**（T4.2：close 感知 pending 写，防 write 与 handle.close 并发 EBADF），close 后到达的写入以 `STORAGE_CLOSED` 类型化拒绝、不重开句柄。
2. 每条记录：序列化 → `write(行 + '\n')` → flush，写入返回即记 `seq`。**不逐条 fsync**：进程强杀（NFR-7 测试口径）下内核缓冲依旧持久，已 write 数据零丢失。
3. checkpoint 行在 write 后追加 `fsync`，作为**断电级**持久点——这是唯一逐条同步的行。
4. 大附件不进 JSONL：落 `attachments/`，行内只存相对路径与元信息；工具结果按 02 §2.3 预算裁剪后的 `content` 全文落盘（进程 stdout 的溢出部分磁盘不落地，02 §5.4）。
5. compact 提交：新 checkpoint 携带 `epoch+1`；追加接口拒绝 `epoch` 小于会话当前值的写入（旧快照不得覆盖新状态，02 §1.4 单调合并），被拒写入直接丢弃并计数。

### 4.4 恢复流程（NFR-5 ≤ 1s）

1. `resume(sessionId)`：读 sessions 行，取 `checkpoint_offset` / `epoch` / `status`；archived 会话仅允许只读浏览。
2. `seek(checkpoint_offset)`，校验该偏移可解析出完整 checkpoint 行且 `epoch` 与库内一致。
3. 自 checkpoint 后逐行重放 `message` / `event` 行至 EOF，重建内存历史、todo、未决审批（配对 `approvals` 表补推），完成 `Created→Active`；压缩标记 `compaction.applied` 按摘要替换语义应用，`compaction.pruned` 预剪枝事件按 `sourceMessageId` 回指定位原文并以 `prunedContent` 替换（T5.4，重放/内存一致，宽松校验原文不可定位逐项忽略）。
4. checkpoint 不可用（偏移越界 / 解析失败 / 文件短于 `pos`）：从文件尾反向扫描（末尾 ≤ 256KB）找最近完整 checkpoint；仍无则**全量重放**。
5. 悬挂 tool_call：assistant 消息含 `toolCallId` 而流内无对应 tool 结果 → 以 `isError=true`、content=「进程中断，结果丢失」补齐（02 §1.4）。
6. 对账：重放计数与 `sessions.message_count` 比对，回写 `checkpoint_offset` / `epoch` / 统计列。

性能论证：有 checkpoint 时 I/O 量仅为最后一 turn 的增量（典型 < 100 行），毫秒级；最坏情况（首个 turn 内崩溃、无 checkpoint）全量重放 1 万行 JSON.parse 约 0.3~0.6s，仍满足 ≤ 1s 基线。

### 4.5 截断与归档

- **半行截断**：恢复时发现 EOF 处半行（崩溃恰好打断写入）→ 残尾另存 `events.jsonl.tail-<ts>` 后截去。这是追加写模型下唯一允许的「改写」，保证后续追加行完整，残尾保留供诊断。
- **大小软上限**：`events.jsonl` ≥ 50MB 或 ≥ 10 万行时，settle 发「建议新起会话」事件；不做自动 rollover——单文件顺序追加是恢复流程的不变量，分段文件会让 §4.4 复杂化，收益不抵。
- **归档**：`session.archive` → flush → status='archived' → 打包 `archive/<sessionId>.tgz`（events.jsonl gzip，文本压缩比约 5~10×，含 attachments / background），原会话目录删除；解包即可回读，JSONL 历史行永不改写。
- **orphan 隔离**：恢复失败且无法修复的会话目录移入 `sessions/orphan/`，sessions 行置 archived 并在 title 注记「[损坏]」（对齐 03-ui-design 恢复失败文案：隔离展示、不阻塞新建会话）。

---

## 5. 记忆索引方案

### 5.1 三层关系

| 层 | 载体 | 关系 |
| --- | --- | --- |
| L1 项目记忆 | `<workspace>/.raincode/MEMORY.md` | 文件唯一真源，启动全文注入（读单文件，保冷启动 ≤ 2s） |
| L2 会话记忆 | SQLite `memory_entries` | 会话结束 / compact 时抽取落盘；只经 `search()` 按需进入上下文 |
| L3 自动抽取（P2） | memory_entries + MEMORY.md 草案 | 单向晋升：entries →（用户确认）→ MEMORY.md，无自动反向覆盖（02 §7.2） |

晋升（`promoteToProjectFile`）只改 MEMORY.md 文件，不改 memory_entries 行——02 未定义晋升后的条目态，不为存储层发明字段。

### 5.2 FTS5 决策：启用，trigram 分词

- **启用**：better-sqlite3 内嵌 SQLite ≥ 3.40，FTS5 与 trigram tokenizer 开箱可用。
- **为何 trigram**：默认 unicode61 分词器不切分 CJK（连续中文成单一 token，检索失效）；trigram 以 3 字符滑窗建倒排，天然支持中文子串匹配，且可加速 `LIKE` 查询。无需引入分词依赖。
- **已知限制与兜底**：trigram 命不中 < 3 字符查询 → 短查询回退 `LIKE` 全表扫。memory_entries 单 workspace 数百条量级，兜底路径性能无虞。
- **external-content 模式**：FTS 表只存倒排不存正文（`content=` 指向主表），无内容双写；条目变更经触发器同步。
- P2 向量检索升级时只替换 `search()` 后端，表结构与接口不变（02 §7.3）。

### 5.3 索引 DDL（随 001_init 或后续脚本）

```sql
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
```

### 5.4 召回查询示例

```sql
-- 常规召回（≥3 字符查询，走 trigram 倒排 + bm25 排序）
SELECT e.id, e.kind, e.content, e.confidence, e.last_seen_at
FROM memory_fts f
JOIN memory_entries e ON e.rowid = f.rowid
WHERE memory_fts MATCH :query
  AND e.workspace_id = :wsHash          -- 跨项目串味防线（02 §7.4）
  AND e.status = 'active'
  AND e.confidence >= 0.6               -- 默认召回集阈值
ORDER BY bm25(memory_fts)
LIMIT :limit;

-- 短查询兜底（1~2 字符，trigram 无法命中）
SELECT id, kind, content, confidence, last_seen_at
FROM memory_entries
WHERE workspace_id = :wsHash AND status = 'active' AND confidence >= 0.6
  AND content LIKE '%' || :query || '%'
ORDER BY last_seen_at DESC
LIMIT :limit;
```

幂等去重：抽取以 sessionId + checkpoint 为幂等键（02 §7.4「同会话只抽取一次」），幂等记录存 `settings`（`memory.extracted.<sessionId>`）。

**会话历史检索查询（T5.3，§3.12 history_fts）**：

```sql
-- FTS 路径（≥3 code point 查询）：查询按空白切词、逐词 phrase 转义、词间 OR（部分匹配可召回，
-- bm25 排序；多词同时命中的文档排前）。3x 过取样取候选后按相对分数地板裁剪。
SELECT p.session_id, p.seq, p.role, p.kind, p.content, p.ts, bm25(history_fts) AS score
FROM history_fts f
JOIN history_parts p ON p.id = f.rowid
WHERE history_fts MATCH :orPhrases        -- 如 "renderer" OR "冷启动"（词间 OR，引号双写转义）
  AND p.workspace_id = :wsHash            -- 跨项目串味防线
  AND p.session_id != :currentSessionId   -- 排除当前会话（自指噪声，02 §7.4 注记）
ORDER BY score
LIMIT :limit * 3;                         -- 3x 过取样
-- 裁剪：保留 |score| ≥ |score(top)| × 0.15 的命中后截断 :limit（BM25 绝对阈值随语料尺寸
-- 漂移不可用，相对地板取自 MiMo-Code 调研经验，docs/research §2.1）。

-- LIKE 兜底（<3 code point 或 FTS 空结果）
SELECT session_id, seq, role, kind, content, ts
FROM history_parts
WHERE workspace_id = :wsHash AND session_id != :currentSessionId
  AND content LIKE '%' || :query || '%' ESCAPE '\'
ORDER BY ts DESC, id DESC
LIMIT :limit;
```

---

## 6. Migration 策略

- **脚本组织**：`packages/storage/src/migrations/` 下顺序编号脚本 `NNN_描述.sql`（`001_init.sql` 建全部 P0 表），编号只增不复用；脚本真源随代码入库。
- **版本表**：§3.2 `schema_migrations`，版本号即脚本编号；已应用脚本**禁止修改**（修 bug 只能加新脚本），保证任意存量库可确定性重放。
- **执行规则**：按版本升序逐个执行；每个脚本整体包裹在**一个事务**中（SQLite DDL 可事务化，失败整体回滚）；成功后写入 schema_migrations；任一脚本失败即中止启动——宁可不可用，不带病运行。
- **破坏性变更规则**：
  - 加列：`ALTER TABLE ... ADD COLUMN`（必须带 DEFAULT 或允许 NULL）。
  - 改列 / 删约束 / 改语义：统一走**重建表**（CREATE 新表 → INSERT…SELECT 搬数 → DROP 旧表 → RENAME），放同一事务；不依赖 SQLite ≥ 3.35 的 DROP COLUMN，统一模式降低分叉。
  - 破坏性脚本头部以 `-- destructive` 标记声明；执行前自动复制 `raincode.db` → `backups/pre-migration-v<NN>-<ts>.db`（保留最近 3 份），备份失败则不执行迁移。
  - 代码期望版本高于库版本且待执行迁移含破坏性脚本时，提示用户确认后再继续（个人工具，交互确认成本可接受）。
- **启动时迁移流程**：
  1. 打开数据库，执行 §3.0 PRAGMA；
  2. 读 `max(version)`，与代码内置期望版本比对；
  3. 无待执行迁移 → 直接就绪（毫秒级，NFR-1 不受影响）；
  4. 有 → 逐个应用并记录；含 FTS 虚表结构的脚本末尾执行 `INSERT INTO memory_fts(memory_fts) VALUES('rebuild');` 保证倒排与主表一致；
  5. 迁移在 TUI ready **之前**完成（同步、有界）；MCP 连接等异步任务不受影响（04 §3.1 启动顺序）。

---

## 7. 数据保留与清理

| 对象 | 默认策略 | 说明 |
| --- | --- | --- |
| 活跃会话 JSONL | 不清理，仅软上限提示（§4.5） | 唯一事实源，永不自动删 |
| 归档会话 | 永久保留 `archive/<id>.tgz`，用户手动删 | `--resume` 默认只列 active；archived 经过滤器查看 |
| permission_decisions | 保留 90 天（`config.json` permissions 段可调），启动时后台异步删除过期行 | 删除后执行每周一次 `PRAGMA wal_checkpoint(TRUNCATE)` 回收空间 |
| approvals | 终态行保留 30 天；pending 行由审批超时器置 `expired`（120s，02 §6.4） | 未决审批恢复时重弹，过期不弹 |
| backups | 保留最近 3 份 | 破坏性迁移前生成（§6） |
| logs | 滚动保留 7 天 | 脱敏写入（04 §5.3） |
| orphan 隔离区 | 永久保留，用户手动处理 | 不阻塞任何功能 |

**用户手动清理入口**（执行均收敛到 storage 端口，方法注册进 04 §1.2 既有方法族）：
- CLI：`raincode cleanup audit`（清过期审计）、`cleanup archived-sessions`（清归档包）、`cleanup memory --hash <hash>`（清某项目 memory_entries）、`cleanup workspace --hash <hash>`（删 `workspaces/<hash>/` 目录 + 登记行 + 其下各域表行，审计行保留）。
- 桌面端：设置页「存储管理」提供同四项操作与占用统计（数据量来自各表 COUNT 与目录扫描）。
- workspace 清理用显式逐表删除而非 FK 级联：审计表无外键（§3.8），语义上「业务数据可清、审计留痕」。

---

## 8. 一致性对照表（模块文档实体 → 存储映射）

逐条核对 02-module-design 七大模块 + 04-architecture §5 的全部数据实体：

| 来源 | 实体 / 语义 | 存储落点 | 核对 |
| --- | --- | --- | --- |
| 02 §1.1/§1.2.2 | 会话生命周期（Created/Active/Archived）、会话目录与事件文件 | `sessions` + `sessions/<id>/events.jsonl` | ✓ |
| 02 §1.2.2/§1.4 | 崩溃恢复：checkpoint + 增量重放、悬挂 tool_call 补齐 | checkpoint 行 + `sessions.checkpoint_offset`（§4.4） | ✓ |
| 02 §1.2.4 | 流式 delta 事件 | 不落盘（UI 瞬态，落盘粒度=单条消息） | ✓ |
| 02 §1.2.5 | Compact epoch 单调合并 | checkpoint.epoch + `sessions.epoch` + 追加接口 epoch 守卫 | ✓ |
| 02 §1.2.3 | todo 状态随事件落盘 | JSONL checkpoint.state（无独立表，防双写） | ✓ |
| 02 §1.3 | TokenUsage / TurnOutcome | `sessions` 累计列 + JSONL event 行 | ✓ |
| 02 §1.3 attachments | 附件 | `sessions/<id>/attachments/` 文件 + JSONL 相对引用 | ✓ |
| 02 §2.3 | ToolResult（toolCallId/isError/truncated/duration） | JSONL 正文 + `tool_calls` 索引 | ✓ |
| 02 §2.3 | todo / read-file 快照（会话级状态） | JSONL checkpoint.state，无表 | ✓ |
| 02 §3.3 | McpServerConfig | `mcp.json`（真源，04 §5.1） | ✓ |
| 02 §3.2 | MCP 连接状态机 | `mcp_servers`（运行态投影） | ✓ |
| 02 §4.3 | SubagentProfile | `agents/*.md` 文件（全局/项目两级） | ✓ |
| 02 §4.2/4.3 | SubagentHandle/Result 状态与结果 | `subagent_runs` + 子会话 `sessions` 行 | ✓ |
| 02 §5.3 | 后台任务产出落盘 | `sessions/<id>/background/<taskId>.out` | ✓ |
| 02 §5.4 | 越界路径审计（outOfScopePaths）、env 覆盖审计 | `permission_decisions.detail_json` | ✓ |
| 02 §6.2/6.3 | PermissionRule（scope/tool/pattern/behavior/source） | `permission_rules`（session scope 驻内存，02 §6.2 原文） | ✓ |
| 02 §6.1/6.4 | 审批单闭环、持久化未决审批 | `approvals` + JSONL approval 事件 | ✓ |
| 02 §6.3 | decisions 审计记录清单（时间/会话/工具/脱敏输入/decision/matchedBy/grantId/respondLatencyMs） | `permission_decisions`，逐字段对应 | ✓ |
| 02 §7.3 | MemoryEntry（kind/content/refs/confidence/source/createdAt/lastSeenAt） | `memory_entries`，逐字段对应 | ✓ |
| 02 §7.4 | 矛盾条目标记 superseded、confidence 召回阈值 | `memory_entries.status/superseded_by` + 查询条件 | ✓ |
| 02 §7.1/7.3 | MEMORY.md 章节模板与唯一真源 | `<workspace>/.raincode/MEMORY.md` 文件 | ✓ |
| 02 §7.4（T5.3） | 全局记忆双层注入（global 先 workspace 后） | `<RAINCODE_HOME>/MEMORY.md` 文件（§2.1） | ✓ |
| 02 §7.4（T5.3） | 会话历史检索（part 级：文本+工具名）+ 检索一致性不变量 | `history_parts`/`history_fts`（§3.12，派生索引；真源 events.jsonl） | ✓ |
| 04 §5.1/5.2 | 三级配置、Provider 四要素、apiKeyRef | `config.json` / `secrets.json` 文件 + 系统凭据库 | ✓ |
| 04 §5.1 | MCP 清单独立文件 | `mcp.json`（全局 + 项目） | ✓ |
| 01-PRD AC-5 / NFR-7 | 崩溃 100% 可恢复、消息计数一致 | JSONL 追加写 + `sessions.message_count` 对账 | ✓ |

覆盖结论：任务要求的 10 张表全部落位（messages 按许可项以「JSONL 为主 + 无表说明」处理）；模块文档未额外遗漏实体；补充表 3 张（`workspaces`、`approvals`、`memory_fts`）。

## 9. 待确认差异

| # | 差异 | 本文处理 | 处理状态 |
| --- | --- | --- | --- |
| 1 | 02 §4.3/§7.1 写 `~/.nova/agents`、`<workspace>/.nova/MEMORY.md`；04 §5.1 全局与项目目录均为 `.raincode` | 统一采用 `.raincode`（04 为目录布局权威，任务基线同），02 中实体语义（文件载体、frontmatter、章节模板）全部保留 | ✅ 已修订：02 相关路径统一为 `.raincode` |
| 2 | 02/04 引用「03-data-model（存储设计）」，实际文档编号已顺延为 05-database | 本文即该引用的落位文档 | ✅ 已修订：02 头部关联与表名引用改为 05-database；04 说明改为指向落位文档 |
| 3 | 任务要求 `mcp_servers` 表，而 04 §5.1 规定 MCP 清单真源为 `mcp.json` 文件 | 拆分职责：mcp.json=配置真源；`mcp_servers`=运行期注册/状态投影，启动重建，不构成配置双写 | ✅ 已确认：04 §5.1 已写明 mcp.json 独立清单文件与权限规则入库的职责分离 |
| 4 | 02 §6.3 `PermissionRule.scope` 类型含 `'session'`，但 02 §6.2 判定链明确会话规则载体为内存 | 表 CHECK 约束只允许 `project`/`global`；session 规则生命周期=会话期，落库反造成悬挂行 | ✅ 已确认：无需改 02；storage 实现注释对齐即可 |

## 10. 自检清单

- [x] DDL 全部为 SQLite 方言、语法可执行（CHECK/表达式唯一索引/部分索引/external-content FTS5 + 触发器均为 SQLite 支持特性，better-sqlite3 内嵌 SQLite ≥ 3.40）。
- [x] 02-module-design 涉及实体全部覆盖（§8 逐条核对），字段语义与 02 一致（枚举逐字对齐，如 subagent 状态 `Pending/Running/Completed/Failed/Stopped`）。
- [x] NFR-5 ≤ 1s：恢复 = O(1) 定位 checkpoint + 尾部增量重放；最坏全量重放 1 万行约 0.3~0.6s，仍达标。
- [x] NFR-7：JSONL 追加写唯一真源、每 turn checkpoint fsync、半行截断可诊断、悬挂 tool_call 补齐、message_count 对账。
- [x] 与 04 目录布局一致：`~/.raincode/` 数据根、项目 `.raincode/config.json` 与 `mcp.json`、权限规则入库不进 config、apiKey 只存引用。
- [x] epoch 单调合并在存储层落地（追加接口拒绝旧 epoch 写入）；不做宽表、不做消息正文双写、不做向量库。
- [x] 与 02/04 的三处编号/路径差异及一处职责拆分已在 §9 登记，未单方面改写上游文档。
