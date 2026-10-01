# RainCode

> 个人本地 AI 编程工作台 —— 单机优先、数据全本地、自带 API Key 接入任意 OpenAI 兼容模型。

[![Status](https://img.shields.io/badge/status-M2%20%E9%AA%8C%E6%94%B6%E5%AE%8C%E6%88%90-brightgreen)](PROGRESS.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
![vibecoding](https://img.shields.io/badge/%E6%9C%AC%E9%A1%B9%E7%9B%AE%E4%B8%BA-vibecoding%20%E4%BA%A7%E7%89%A9-ff69b4)

> **🤖 本项目为 vibecoding 产物**：由 AI 编程助手（vibe coding 工作流）全程协作设计与开发，人类角色定位为需求提出、方案评审与验收。设计与实现过程见 [PROGRESS.md](PROGRESS.md) 与 [docs/](docs/README.md)。

RainCode 的功能定位与 Claude Code / Codex 对齐：整合**代码生成、工具调用、MCP 调用、子代理管理、沙箱执行环境、命令权限控制、项目记忆**七大核心模块，提供 **CLI 与 Windows 桌面应用**双端形态，两端共享同一套后端服务（`@raincode/server` 唯一组装点）与同一套 RPC 协议（传输无关：进程内 in-memory / 子进程 stdio）。

## 当前状态

**M2（能力补全 + 桌面端 Alpha）验收完成** ✅，NFR-1~7 基准全达标（见 [docs/benchmarks/m2-2026-09-29.md](docs/benchmarks/m2-2026-09-29.md)）。下一里程碑 M3：容器沙箱、技能、插件、远程执行、Web 界面。

| 能力 | 状态 |
| --- | --- |
| Agent 内核（turn 状态机 / 会话生命周期 / checkpoint 恢复 / epoch 守卫 / 受限重试） | ✅ M1 |
| 工具调用（9 个内置工具 / 声明式权限元数据 / 只读并行 / 输出预算裁剪） | ✅ M1 |
| 命令权限控制（五级判定链 / bash argv 求值 / grantId 审批闭环 / 三层规则 / 审计） | ✅ M1 |
| 控制面协议（45 方法 / 18 事件 / 密钥引用制 / capability 协商） | ✅ M2 |
| 上下文压缩 compact（80% 阈值自动触发 / 异步不阻塞 / 记忆抽取钩子） | ✅ M2 |
| MCP 接入（stdio / Streamable HTTP / SSE，`mcp__<server>__<tool>` 命名空间） | ✅ M2 |
| 子代理管理（profile 双源解析 / 并发槽排队 / 级联取消 / 事件镜像合并） | ✅ M2 |
| 项目记忆（MEMORY.md 注入 / FTS5 检索 / 会话记忆抽取 / promote 晋升） | ✅ M2 |
| P1 工具（`web_fetch` SSRF 防护 / `ask_user_question` 交互提问） | ✅ M2 |
| rpc stdio 绑定 + headless 宿主（`raincode serve`） | ✅ M2 |
| 桌面端 Alpha（Electron 三泳道 + React，会话流 / 工具卡 / 审批弹窗 / Provider 设置） | ✅ M2 |
| 会话管理（rename / fork / usage 费用估算 / archive / mode） | ✅ M2 |
| 容器沙箱（Docker / WSL 执行域 + 不可用回退，config.json `sandbox` 节） | ✅ M3 |
| 技能 / 插件 / 远程执行 / Web 界面 | ⬜ M3 |

## 环境要求

- Node.js ≥ 20
- pnpm 11（`packageManager` 已锁定，Corepack 可直接启用）
- Windows 优先（开发 / 测试均在 Windows 上进行），理论兼容 macOS/Linux
- 桌面端额外依赖 Electron 33（`pnpm install` 自动拉取；国内网络建议设置 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`）
- better-sqlite3 预编译二进制经 prebuild-install 下载，GitHub release 直连不可达时回退 node-gyp（需 VS C++ 工具链）；国内网络建议同时设置 `npm_config_better_sqlite3_binary_host_mirror=https://registry.npmmirror.com/-/binary/better-sqlite3`（prebuild-install 只认下划线形式的 `npm_config_*` 环境变量，`.npmrc` 的短横线键不会被转换）

## 快速开始

```bash
# 1. 安装依赖
pnpm install

# 2. 环境健康检查（可选）
pnpm typecheck && pnpm lint && pnpm architecture:check

# 3. 配置模型 Provider（OpenAI 兼容协议，详见下文「Provider 配置」）
#    最简方式：创建 config/providers.local.json（已被 .gitignore 隔离）
#    { "baseURL": "https://your-endpoint/v1", "apiKey": "sk-...", "model": "your-model" }

# 4. 运行 CLI
pnpm --filter @raincode/cli raincode ping      # 握手：打印协议版本与 capability 列表
pnpm --filter @raincode/cli raincode run "解释这个仓库的目录结构"     # 非交互单轮
pnpm --filter @raincode/cli raincode chat      # 交互 REPL（推荐日常使用）
```

> ⚠️ **密钥安全约束**：API Key 只存在于内存与本地配置文件，绝不写入任何被跟踪文件、日志、输出或审计（架构级约束，见 docs/04-architecture §5.3）。推荐 `apiKeyRef: "file:config/apikey.txt"` 引用制。

## CLI 命令

| 命令 | 说明 |
| --- | --- |
| `raincode ping` | 进程内启动 Agent Service 并握手，打印协议版本（也作为冷启动基准打点） |
| `raincode run "<prompt>"` | 非交互模式：创建会话 → 发送 → 流式打印 → 退出；`--yes` 自动允许工具审批（临时 session 规则，不落库） |
| `raincode chat` | 交互 REPL（见下表），流式渲染 + 工具卡片 + 交互审批 |
| `raincode serve` | headless stdio 宿主：stdin/stdout 承载 JSONL 协议帧（桌面端 agent 子进程同形态，可人工 cat 调试） |
| `raincode help` | 帮助 |

通用选项（`run` / `chat` / `serve` 共用）：`--base-url` `--model` `--api-key` `--name` `--provider-config <path>` `--workspace <dir>` `--title <title>` `--yes`。

### chat REPL 内置命令

| 命令 | 说明 |
| --- | --- |
| `/exit` | 退出（归档提示） |
| `/sessions` | 会话列表（Active / Archived） |
| `/resume <id>` | 恢复会话并切换为当前活动会话（checkpoint + 增量重放 ≤ 1s） |
| `/rename <title>` | 重命名当前会话 |
| `/fork [title]` | 复制全量历史分叉新会话并切换（源会话不动，`parent_session_id` 回链） |
| `/usage` | 当前会话累计 tokens / 轮次 / 费用估算（Provider 配置单价后显示） |
| `/mode <normal\|plan\|auto-accept>` | 协作模式切换（plan 写类 deny / auto-accept workspace 内自动放行 / normal 询问） |
| `/archive [--force]` | 归档会话（运行中后台任务未收束时需 `--force`） |
| `/compact` | 手动触发上下文压缩（低于阈值报 INVALID_PARAMS；压缩期间对话不阻塞） |
| `/providers` | 查看 config 域 Provider 列表与单价 |

写操作等敏感工具会触发**交互式审批**，四级数字决策：`1` 仅本次允许 / `2` 本会话始终（写 session 规则）/ `3` 项目始终（写 project 规则）/ `4` 拒绝。

## 桌面端（Windows Alpha）

Electron 三泳道架构：main（窗口 + agent 子进程守护 + 帧转发，不解析业务帧）/ renderer（React 18 + Zustand + Tailwind）/ agent 子进程（与 CLI 完全同一 `createAgentServiceNode` 组装）。

```bash
# 开发模式（vite dev server + electron，窗口真实弹出）
pnpm --filter @raincode/desktop dev

# 构建产物（main/preload CJS + agent esbuild bundle + renderer vite bundle）
pnpm --filter @raincode/desktop build

# Windows 安装包（electron-builder nsis；原生模块 rebuild 属打包机环节）
pnpm --filter @raincode/desktop dist
```

Alpha 功能范围：三栏主界面（会话列表 + 会话流 + 输入区）、工具调用卡片（五状态：排队 / 运行中 / 成功 / 失败 / 已作废）、权限审批弹窗（风险徽章 + 键盘 `1-4` 直选 + `Esc` 拒绝）、Provider 设置（添加 / 切换 / 活跃徽章）、工作区目录选择、流式输出与光标、子进程崩溃自动重启提示。与 CLI 共享同一 `RAINCODE_HOME` 数据目录——CLI 里开始的会话，桌面端打开即续接。

## Provider 配置

**优先级（低 → 高，字段级就近覆盖）**：① 配置文件 → ② 环境变量 → ③ CLI 参数。

### 方式 A：配置文件 `config/providers.local.json`（推荐，已 gitignore）

```jsonc
// 形态一：单 Provider 平铺
{
  "name": "my-provider",
  "baseURL": "https://your-endpoint/v1",
  "model": "your-model",
  "maxContextTokens": 32768,
  "apiKeyRef": "file:apikey.txt"        // 引用制：相对路径以配置文件目录为基准
  // "apiKey": "sk-..."                  // 也可明文（仅限本地开发）
}
```

```jsonc
// 形态二：多 Provider + 活跃项（运行时 /providers、config.providers.switch 切换）
{
  "providers": [
    { "id": "p1", "name": "main", "baseURL": "https://a/v1", "model": "m1",
      "apiKeyRef": "file:key1.txt",
      "inputPricePerMtok": 0.14, "outputPricePerMtok": 0.28 },
    { "id": "p2", "name": "backup", "baseURL": "https://b/v1", "model": "m2", "apiKey": "sk-..." }
  ],
  "activeProviderId": "p1"
}
```

`inputPricePerMtok` / `outputPricePerMtok`（USD / 百万 token）配置后 `/usage` 与 `session.usage` 给出费用估算。

### 方式 B：环境变量

```bash
export RAINCODE_PROVIDER_BASE_URL="https://your-endpoint/v1"
export RAINCODE_PROVIDER_MODEL="your-model"
export RAINCODE_PROVIDER_API_KEY="sk-..."
export RAINCODE_PROVIDER_NAME="my-provider"          # 可选
export RAINCODE_PROVIDER_MAX_CONTEXT_TOKENS=32768    # 可选，缺省 32768
```

### 方式 C：CLI 参数（临时覆盖）

```bash
raincode chat --base-url https://your-endpoint/v1 --model your-model --api-key sk-...
```

未配置 Provider 时 CLI 仍可启动（`ping` / `sessions` / `resume` 可用），`run` / `chat` 发送时报 `CONFIG_PROVIDER_NOT_FOUND` 引导配置。

## 数据目录

全部本地状态落在 `RAINCODE_HOME`（缺省 `~/.raincode`）：

```
~/.raincode/
├── raincode.db          # SQLite（WAL）：sessions / permission_rules / permission_decisions /
│                        #   approvals / memory_entries（FTS5 trigram）/ schema_migrations
├── sessions/            # JSONL 会话事件流（按 workspace 分目录；checkpoint 恢复点内联）
├── config.json          # 运行时配置（Provider 多项 / activeProviderId；apiKey 只存 file: 引用）
├── mcp.json             # MCP 全局服务器配置
└── agents/              # 全局子代理 profiles（<name>.md）

<workspace>/.raincode/   # 项目级（随仓库，可入库共享给团队）
├── MEMORY.md            # 项目记忆（模板初始化；Agent 章节自动维护 / 用户章节手动）
├── mcp.json             # 项目级 MCP 配置（与全局冲突键拒绝）
└── agents/<name>.md     # 项目级子代理 profiles
```

## MCP 配置

与 Claude / Cursor 生态 `mcpServers` 约定兼容。三种 transport：

```jsonc
// ~/.raincode/mcp.json（全局）或 <workspace>/.raincode/mcp.json（项目级）
{
  "mcpServers": {
    "filesystem": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:\\workspace"],
      "env": {},                // 可选；注入前经脱敏过滤
      "timeoutMs": 60000,
      "enabled": true
    },
    "remote-api": {
      "transport": "http",      // 或 "sse"
      "url": "https://mcp.example.com/stream",
      "headers": { "Authorization": "Bearer ..." }
    }
  }
}
```

- MCP 工具以 `mcp__<serverKey>__<toolName>` 命名空间注册进工具系统，权限元数据**从严**（needsApproval=true），与内置工具同走三态判定。
- 连接状态机：Disconnected → Connecting → Connected，失败指数退避重连（1/2/4/8/16s，5 次耗尽 → Failed）；单 server 故障仅影响自身命名空间（失败隔离）。
- 断连重连后工具清单自动刷新；`mcp.server_status_changed` 事件实时上报状态。
- 也可运行时经 RPC 管理：`mcp.servers.list/add/remove/retry`（桌面端 MCP 面板同源）。

## 子代理（Sub-agent）

在 `<workspace>/.raincode/agents/<name>.md` 或 `~/.raincode/agents/<name>.md` 放 markdown profile（frontmatter 手写解析，正文 = 子代理系统提示）：

```markdown
---
name: reviewer
description: 代码审查专家：只读分析，输出结构化审查意见
tools: read, glob, grep
maxTurns: 20
---
你是严格的代码审查员。逐文件检查传入范围，输出：问题清单（严重度/位置/建议）。
```

- 主代理经 `agent` 工具派发：`{ profile: "reviewer", task: "审查 src/rpc" }`，阻塞等待子会话终态、结论回传主循环（子代理中间过程不污染主上下文）。
- 并发槽缺省 4，超限 FIFO 排队（`queuePosition` 可见）；`subagent.stop` 级联取消。
- 子代理事件镜像（spawned / progress / completed）500ms 窗口合并，终态永不合并。
- profile 缺省 `tools` 只读白名单，层级固定 2（子代理不可再派孙子代理）。

## 内置工具

| 工具 | 说明 | 权限元数据 |
| --- | --- | --- |
| `read` | 读文件（行号窗口 / 图片） | 只读，自动放行 |
| `write` | 写文件（workspace 路径守卫） | 写操作，需审批 |
| `edit` | 精确文本替换（唯一性校验） | 写操作，需审批 |
| `bash` | 受控 shell 执行（超时 / 输出预算 / 后台任务 / argv 级规则求值） | 按命令求值 |
| `glob` / `grep` | 文件名模式 / 内容搜索（默认忽略 node_modules、.git） | 只读，自动放行 |
| `todo_write` | 任务清单维护（会话内计划跟踪） | 无副作用 |
| `web_fetch` | 抓取 URL 转文本（SSRF 强制黑名单：私网/环回/DNS 解析校验/重定向逐跳防护） | network，从严审批 |
| `ask_user_question` | 向用户提问并等待应答（复用审批闭环；CLI 提问卡 / 桌面弹窗） | 无副作用 |

MCP 工具（`mcp__<server>__<tool>`）与子代理派发（`agent`）在同一注册中心与权限体系内运行。所有工具执行统一受并发上限（只读可并行，写串行）、单调用超时与 256KB 输出预算裁剪约束。

## 沙箱执行域（Docker / WSL）

bash 与后台任务的执行环境经 `Executor` 抽象投递（02 §5.3 扩展点），在 `RAINCODE_HOME/config.json` 配置：

```jsonc
{
  "sandbox": {
    "executor": "docker",          // local（缺省）| docker | wsl
    "image": "node:20-bookworm-slim", // docker 专用，缺省如左
    "network": "none",             // docker 网络策略：none（缺省，断网隔离）| bridge
    "wslDistro": "Ubuntu-22.04"    // wsl 专用，缺省默认发行版
  }
}
```

- **docker（ES-3）**：容器内仅挂载 workspace（文件系统隔离，主机其余路径不可见）+ 缺省断网；命令经 `docker run --rm` 执行，workdir 自动映射（`D:\ws\docs` → `/workspace/docs`）；CLI 进程退出后 best-effort `docker rm -f` 清理容器。
- **wsl（ES-4）**：Linux 环境隔离（`wsl --cd` 自动翻译路径）；发行版文件系统完整可见——环境隔离而非安全边界。
- **回退与标记**：执行域不可用（CLI 探测失败，如本机未装 Docker/WSL 发行版）自动回退 local 并在 stderr 告警；bash 结果 `data.sandbox` 与非 local 时的内容头行标注真实执行环境。local 模式保持 P0「约束非隔离」语义（路径守卫 / 审批前置 / 超时终止不变）。

## 命令权限与审批

- **五级判定链**：显式 deny → 显式 allow（含通配）→ ask 规则 → 协作模式缺省（plan 写类 deny / auto-accept workspace 内 allow（机器级操作保守不放行）/ normal 询问）→ 默认 ask。
- **规则三层作用域**：`session`（内存，会话结束即弃）/ `project`（SQLite，按 workspace 隔离）/ `global`（SQLite 全局）；层级内 `deny > ask > allow` 收敛，同键后写覆盖。
- **bash 命令级求值**：argv 语义拆解（非字符串前缀），高危根命令（`rm` / `del` / `format` 等）通配 allow 强制降级 ask——宁可误问不可漏拦。
- **审批闭环**：ask → `grantId` 审批单（120s 超时按 deny 收敛）→ CLI 交互或桌面弹窗应答 → `permission.resolved` 事件 + 审计落库；单消费（重复应答报 `PC_GRANT_CONSUMED`）。
- **路径越界防护**：workspace 外写操作强制升级 ask，获批后精确放行该绝对路径。
- 规则管理：`permission.rules.list/add/remove`（scope + tool + pattern），决策审计 `permission.decisions.list` 可追溯。

## 项目记忆

- **L1 项目记忆** `<workspace>/.raincode/MEMORY.md`：每次会话全文注入 systemPrompt；结构化章节（项目概览 / 技术栈 / 约定等）由 Agent 自动维护，`<!-- user -->` 用户章节仅手动修改（越界写入被拒）。
- **L2 会话记忆**：会话归档 / compact 前由 LLM 抽取关键事实落 `memory_entries`（FTS5 trigram 检索），幂等去重、矛盾条目 supersede；`memory.search` 关键词检索、`memory.write` 手工写入、`memory.promote` 将会话记忆晋升进 MEMORY.md 指定章节（需用户确认）。

## 环境变量总览

| 变量 | 说明 |
| --- | --- |
| `RAINCODE_HOME` | 数据根目录（缺省 `~/.raincode`） |
| `RAINCODE_PROVIDER_BASE_URL` / `_MODEL` / `_API_KEY` / `_NAME` / `_MAX_CONTEXT_TOKENS` | Provider 环境变量层 |
| `RAINCODE_PROVIDER_CONFIG` | Provider 配置文件路径覆盖（缺省 `<cwd>/config/providers.local.json`） |
| `RAINCODE_MIGRATIONS_DIR` | 迁移脚本目录（仅打包形态内部使用） |
| `RAINCODE_APP_VERSION` | 应用版本注入（仅打包形态内部使用） |
| `RAINCODE_DESKTOP_VITE_URL` / `RAINCODE_DESKTOP_NODE` | 桌面端 dev 脚本内部使用 |

## 开发与测试

```bash
# 工程门禁（四命令，提交前必须全绿）
pnpm typecheck            # 全仓类型检查（strict）
pnpm lint                 # oxlint
pnpm architecture:check   # 架构门禁：依赖白名单 / 循环依赖 / 500 行上限 / 深导入 / managedOnly
pnpm test                 # 单元测试（node:test + tsx，零外呼）

# 冒烟测试（端到端链路，本机 mock，无外呼无真实密钥）
pnpm smoke:p0             # P0 全集（内部并复 compact/mcp/subagent/memory/migrations/kernel/p1tools 等全部 smoke）
pnpm smoke:stdio          # stdio 绑定 + headless 六场景
pnpm smoke:e2e            # 端到端主链路（单独运行）

# NFR 基准（口径见 docs/benchmarks/）
pnpm bench:all                        # NFR-1/2/3/5/7（冷启动 / 发送开销 / 渲染延迟 / 会话恢复 / 崩溃恢复）
pnpm bench:mem:desktop                # NFR-4 桌面端空载内存（先 pnpm --filter @raincode/desktop build；窗口会弹出）
```

测试体系与各脚本覆盖范围详见 [docs/testing.md](docs/testing.md)；基准留存见 [docs/benchmarks/](docs/benchmarks/)。

## 项目结构

```
RainCode/
├── apps/
│   ├── cli/          # CLI：ping / run / chat / serve（readline REPL + ANSI 富文本渲染）
│   └── desktop/      # 桌面端：Electron main + preload + React renderer + agent 子进程宿主
├── packages/
│   ├── shared/       # 协议 schema（zod 单一事实源）+ 共享类型
│   ├── rpc/          # 传输无关 RPC（in-memory / stdio 绑定；请求-响应 + 事件订阅）
│   ├── llm/          # OpenAI 兼容流式客户端（SSE 归一化 / Provider 差异 fixture 消化）
│   ├── storage/      # SQLite（WAL）+ JSONL 会话流 + checkpoint 恢复
│   ├── agent-core/   # turn 状态机 + 会话生命周期 + 子代理 + 压缩（内核）
│   ├── tools/        # 工具注册中心 + 9 内置工具 + 执行器（并发/超时/输出预算/SSRF/路径守卫）
│   ├── permission/   # 五级判定链 + bash argv 求值 + 审批闭环 + 规则持久化 + 审计
│   ├── server/       # Agent Service 唯一组装点（双端共享；45 方法/18 事件装配）
│   ├── mcp/          # MCP 三 transport 接入 + 连接状态机 + 命名空间工具适配
│   └── memory/       # MEMORY.md 管理 + FTS5 记忆检索 + 会话记忆抽取
├── architecture/     # policy.yaml（架构治理策略，门禁依据）
├── docs/             # 设计文档全集（见 docs/README.md 索引）+ 基准报告 + UI 原型
├── scripts/          # smoke 冒烟 / NFR 基准 / 架构检查 / 打包产物验证
└── PROGRESS.md       # 任务进度唯一事实来源
```

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/README.md](docs/README.md) | 文档索引（按阅读顺序） |
| [docs/01-PRD.md](docs/01-PRD.md) | 产品定位 / 功能清单 / NFR 指标 / 竞品对比矩阵 |
| [docs/02-module-design.md](docs/02-module-design.md) | 七大功能模块详细设计 |
| [docs/03-ui-design.md](docs/03-ui-design.md) | 设计 tokens / 桌面端逐界面规范 / 工具卡与审批交互 |
| [docs/04-architecture.md](docs/04-architecture.md) | 包划分 / 进程模型 / RPC 抽象 / ADR 决策记录 |
| [docs/05-database.md](docs/05-database.md) | SQLite 表结构 / JSONL 会话流 / 迁移策略 / 密钥引用制 |
| [docs/06-api-spec.md](docs/06-api-spec.md) | RPC 协议全集（方法 / 事件 / 错误码 / 版本策略） |
| [docs/07-dev-plan.md](docs/07-dev-plan.md) | 三里程碑排期 / 任务分解 / 风险清单 |
| [docs/testing.md](docs/testing.md) | 测试体系：单测 / 冒烟 / 基准 / 门禁 |
| [PROGRESS.md](PROGRESS.md) | 任务进度唯一事实来源（恢复开发第一步读它） |

## 贡献

欢迎 Issue 与 PR，见 [CONTRIBUTING.md](CONTRIBUTING.md)。开发前请务必阅读 [docs/README.md](docs/README.md) 文档索引与 [PROGRESS.md](PROGRESS.md) 当前进度；架构级改动需同步 `architecture/policy.yaml` 并通过 `architecture:check`。

## 许可证

[MIT](LICENSE) © 2026 rain
