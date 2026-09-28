# NovaCode

> 个人本地 AI 编程工作台 —— 单机优先、数据全本地、自带 API Key 接入任意 OpenAI 兼容模型。

[![Status](https://img.shields.io/badge/status-M1%20P0%20%E5%B7%B2%E5%AE%8C%E6%88%90-brightgreen)](PROGRESS.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
![vibecoding](https://img.shields.io/badge/%E6%9C%AC%E9%A1%B9%E7%9B%AE%E4%B8%BA-vibecoding%20%E4%BA%A7%E7%89%A9-ff69b4)

> **🤖 本项目为 vibecoding 产物**：本项目由 AI 编程助手（vibe coding 工作流）全程协作设计与开发，人类角色定位为需求提出、方案评审与验收。设计与实现过程见 [PROGRESS.md](PROGRESS.md) 与 [docs/](docs/README.md)。

NovaCode 的功能定位与 Claude Code / Codex 对齐：整合**代码生成、工具调用、MCP 调用、子代理管理、沙箱执行环境、命令权限控制、项目记忆**七大核心模块，提供 CLI 与 Windows 桌面应用双端形态，两端共享同一套后端服务与协议。

## 当前状态

**M1（P0：Agent 内核 + CLI 可用）已完成** ✅ —— 可在真实仓库中端到端完成对话、工具调用、权限审批闭环。**M2 进行中**：auto-compact、MCP 接入、子代理管理、项目记忆已落地，桌面端 Alpha 待开发。进度详情见 [PROGRESS.md](PROGRESS.md)。

| 能力 | 状态 |
| --- | --- |
| Agent 内核（turn 状态机 / 会话生命周期 / checkpoint 恢复 / epoch 守卫） | ✅ M1 |
| 工具调用（8 内置工具 / 声明式权限元数据 / Schedule-Execution 状态） | ✅ M1 |
| 命令权限控制（五级判定链 / bash argv 求值 / grantId 审批闭环 / 审计） | ✅ M1 |
| 控制面协议（22 方法 / 12 事件 / 密钥引用制） | ✅ M1 |
| 上下文压缩 compact（80% 阈值 / 异步 / epoch 单调） | ✅ M2 |
| MCP 接入（stdio/HTTP/SSE，`mcp__<server>__<tool>` 命名空间） | ✅ M2 |
| 子代理管理（profile 双源解析 / spawn 并发槽 / 事件镜像 500ms 合并 / `agent` 工具） | ✅ M2 |
| 项目记忆（MEMORY.md 注入 / FTS5 检索 / 会话记忆抽取 / promote 晋升） | ✅ M2 |
| 桌面端 Alpha（Electron + React，共享后端） | ⬜ M2 |
| 容器沙箱 / 技能 / 插件 / 远程执行 / Web 界面 | ⬜ M3 |

## 环境要求

- Node.js ≥ 20
- pnpm 11（`packageManager` 已锁定）
- Windows 优先（开发/测试均在 Windows 上进行），理论兼容 macOS/Linux

## 快速开始

```bash
# 1. 安装依赖
pnpm install

# 2. 类型检查与门禁（可选，验证环境健康）
pnpm typecheck && pnpm lint && pnpm architecture:check

# 3. 配置模型 Provider（OpenAI 兼容协议，任选其一）
#    方式 A：环境变量
export NOVACODE_PROVIDER_BASE_URL="https://your-endpoint/v1"
export NOVACODE_PROVIDER_MODEL="your-model"
export NOVACODE_PROVIDER_API_KEY="sk-..."

#    方式 B：本地配置文件（已被 .gitignore 隔离，不入库）
#    创建 config/providers.local.json：
#    { "baseURL": "https://your-endpoint/v1", "apiKey": "sk-...", "model": "your-model" }
#    也可用 file: 引用：--api-key "file:config/apikey.txt"（密钥引用制，明文不落库）

# 4. 运行
pnpm --filter @novacode/cli novacode ping     # 握手，打印协议版本
pnpm --filter @novacode/cli novacode run "解释这个仓库的目录结构"
pnpm --filter @novacode/cli novacode chat     # 交互 REPL
```

`chat` REPL 内置命令：`/exit` `/sessions` `/resume` `/mode` `/archive` `/compact` `/providers`；写操作等敏感工具会触发交互式审批。

> ⚠️ API Key 只存在于内存与本地配置文件，绝不写入任何被跟踪文件、日志或输出（架构安全约束，见 docs/04-architecture §5.3）。

## 项目结构

```
NovaCode/
├── apps/
│   ├── cli/          # CLI（readline REPL，Ink TUI 为 M2+ 演进点）
│   └── desktop/      # Windows 桌面端（M2 Alpha，Electron）
├── packages/
│   ├── shared/       # 协议 schema（zod）+ 共享类型
│   ├── rpc/          # 传输无关 RPC 抽象（in-memory / stdio）
│   ├── llm/          # OpenAI 兼容流式客户端（Provider 差异 fixture 消化）
│   ├── storage/      # SQLite + JSONL 会话流 / checkpoint
│   ├── agent-core/   # turn 状态机 + 会话生命周期（内核）
│   ├── tools/        # 工具注册中心 + 内置工具 + 沙箱执行缝
│   ├── permission/   # 五级判定链 + 审批闭环 + 规则持久化
│   ├── server/       # Agent Service 组装（双端共享）
│   ├── mcp/          # MCP 接入（M2）
│   └── memory/       # 项目记忆（M2）
├── architecture/     # policy.yaml（架构治理策略，门禁依据）
├── docs/             # 设计文档全集（见 docs/README.md 索引）
├── scripts/          # smoke 测试 / NFR 基准 / 架构检查脚本
└── PROGRESS.md       # 任务进度唯一事实来源
```

## 开发与测试

```bash
pnpm typecheck            # 全仓类型检查
pnpm lint                 # oxlint
pnpm architecture:check   # 架构门禁（依赖白名单/循环依赖/500 行上限）
pnpm smoke:p0             # P0 全集冒烟（含回归其余 smoke）
pnpm bench:all            # NFR 基准五项
```

测试体系与各脚本的覆盖范围详见 [docs/testing.md](docs/testing.md)。

## 贡献

欢迎 Issue 与 PR，见 [CONTRIBUTING.md](CONTRIBUTING.md)。开发前请务必阅读 [docs/README.md](docs/README.md) 文档索引与 [PROGRESS.md](PROGRESS.md) 当前进度。

## 许可证

[MIT](LICENSE) © 2026 rain
