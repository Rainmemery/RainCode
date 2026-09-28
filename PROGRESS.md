# NovaCode 任务进度跟踪（PROGRESS）

> **本文件是开发进度的唯一事实来源（Single Source of Truth）。**
> 项目中断后恢复开发时，**第一步读本文件**，第二步读 `docs/07-dev-plan.md` 中当前里程碑的任务分解表，然后从「下一步队列」取第一个未完成任务继续。
>
> **更新协议**：每完成一个任务、解决一个问题、做出一个方向性决策，必须**立即**更新本文件（不等攒批）。规则见 §6。

---

## 1. 状态快照（每次更新必须刷新此节）

| 项目 | 值 |
| --- | --- |
| 当前里程碑 | **M1 已完成 ✅**（P0：Agent 内核 + CLI 可用） |
| 下一里程碑 | M2（P1：压缩 / MCP / 子代理 / 记忆 + 桌面端 Alpha） |
| 最新提交 | `58c17fd` feat: M1 收尾（NFR 基准脚本五项达标 + architecture:check/oxlint 门禁 + 基准数据留存） |
| 工作区状态 | clean（无未提交变更） |
| 门禁状态 | typecheck ✅ / oxlint ✅ / architecture:check ✅ / smoke-p0 ✅ / bench 五项达标 ✅ |
| 快照日期 | 2026-09-28 |

---

## 2. 里程碑总览

| 里程碑 | 优先级 | 目标 | 状态 |
| --- | --- | --- | --- |
| Phase 1 设计 | — | 7 份产品/技术设计文档 | ✅ 完成（2026-09-28） |
| M1 | P0 | 单进程 CLI 打通日常可用闭环 | ✅ 完成（2026-09-28） |
| M2 | P1 | 能力补全 + 桌面端 Alpha | ⬜ 未开始 |
| M3 | P2 | 七模块全量对齐 | ⬜ 未开始 |

---

## 3. 已完成任务日志（倒序追加）

> 格式：`[日期] 任务 — 结果`（含关键产出物与提交号）。**新条目插在本节最上方。**

### 文档管理与开源准备
- [2026-09-28] 文档管理与进度持久化体系落地 — 新增 `PROGRESS.md`（进度唯一事实来源 + 更新协议）、根 `README.md`（功能清单/快速开始/vibecoding 标注）、`docs/testing.md`（测试体系说明）、`docs/README.md`（文档索引）、`LICENSE`（MIT）、`CONTRIBUTING.md`（含文档更新协议）。提交 `94bad1d`。

### Phase 1 · 产品设计与开发规划
- [2026-09-28] 7 份设计文档定稿 — `docs/01-PRD.md` ~ `docs/07-dev-plan.md` + 4 份 UI mockup（`docs/ui-mockups/`）。提交 `c48964a`。

### M1 · P0（Agent 内核 + CLI 可用）
- [2026-09-28] Wave 1 monorepo 脚手架 — pnpm workspace + tsconfig + shared/rpc 协议基座。提交 `8d52409`。
- [2026-09-28] Wave 2 llm + storage — OpenAI 兼容流式客户端（fixture 测试消化 Provider 差异）、JSONL 会话流 + checkpoint 恢复 + epoch 守卫。提交 `a05e0d1`。
- [2026-09-28] Wave 3 walking skeleton — agent-core turn 循环 + server 组装 + CLI（ping/run/chat）+ smoke-e2e。提交 `e9c41db`。
- [2026-09-28] Wave 4 工具调用系统 — 8 个内置工具 + 声明式权限元数据 + ToolSchedule/ToolExecution 状态接入。提交 `3fa2006`。
- [2026-09-28] Wave 5 命令权限控制 — 五级判定链 + bash argv 求值 + grantId 审批闭环 + 规则持久化 + 审计。提交 `d44cfc4`。
- [2026-09-28] Wave 6 P0 控制面补齐 — 22 方法 / 12 事件（steer/setMode/archive/config 域）+ 密钥引用制（apiKeyRef）。提交 `26eb694`。
- [2026-09-28] M1 收尾 — NFR 基准脚本五项达标（详见 `docs/benchmarks/m1-2026-09-28.md`）、architecture:check 与 oxlint 门禁。提交 `58c17fd`。

---

## 4. 问题与解决方案记录

> 格式：`[日期] 问题 → 根因 → 解决`。同类问题复现时先查此表。

- [2026-09-28] `better-sqlite3` 安装脚本被 pnpm 拦截 → pnpm 默认禁止依赖运行构建脚本 → `pnpm-workspace.yaml` 增加 `allowBuilds: { "better-sqlite3": true }`。
- [2026-09-28] llm 包类型错误（子类对只读 `code` 重复赋值、`cause` 缺 `override`）→ 前代理遗留编译错误 → 修正子类继承结构。
- [2026-09-28] `architecture-check` 行数误报 → EOF 换行导致文件行数 +1 → 修正计数逻辑，忽略 EOF 空行。
- [2026-09-28] 跨包 import 越权 → 临时调试注入的跨包依赖不在 `architecture/policy.yaml` 白名单 → 移除越权 import；新增占位包必须同步登记 policy。

---

## 5. 下一步队列（M2，按 07-dev-plan §3.2 顺序）

> 取任务时**必须**回读 `docs/07-dev-plan.md` 对应任务行获取完整验收标准。

1. **T2.1 auto-compact** — CompactionService，阈值 80% 触发、epoch 守卫、保留区（系统提示 + 最近 20 条）、失败阈值上调 90%。验收：NFR-6 专项用例。
2. **T2.2 mcp 包** — stdio / http / sse 三 transport、连接状态机 M1~M8、`mcp__<serverKey>__<toolName>` 命名空间、失败隔离与重连退避。
3. **T2.3 子代理** — profile 解析校验、spawn / 并发槽 / 级联取消、事件镜像（500ms 合并）、`agent` 工具注册。
4. **T2.4 memory 包** — MEMORY.md 模板初始化与注入、会话结束/compact 抽取落盘、FTS5 trigram 检索 + LIKE 兜底、promote 单向晋升。
5. **T2.5 permission 持久化与危险命令** — project/global 规则 CRUD、层级合并、高危根命令禁止通配 allow。
6. **T2.6~T2.10** — 内核增强（AC-9~12）、工具增强与 P1 工具、rpc stdio + headless、桌面端 Alpha（Electron 三泳道 + stdio RPC 绑定）、M2 验收与基准留存。

---

## 6. 更新协议（严格执行）

| 触发事件 | 必须更新的文档 |
| --- | --- |
| 完成一个任务/波次 | §1 状态快照 + §3 追加日志（含提交号） |
| 解决一个技术问题 | §4 追加问题记录（复用价值高时另写入 `docs/` 对应设计文档） |
| 完成一个里程碑 | §1 + §2 状态、`docs/benchmarks/` 新增基准报告、README 功能清单 |
| 新增/变更用户可见功能 | README 功能特性节 |
| 新增/变更测试与门禁 | `docs/testing.md` |
| 方向性决策变更 | 对应设计文档（01~07）+ §3 记一笔 |

**中断恢复三步**：① 读本文件 §1/§5 → ② `git log --oneline -10` 核对最新提交 → ③ 读 07-dev-plan 对应任务行，继续开发。
