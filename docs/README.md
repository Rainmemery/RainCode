# RainCode 文档索引

> 设计文档按阅读顺序编号。**开发前必读**：先读对应模块的设计文档，再动代码。

## 产品与规划

| 文档 | 内容 | 阅读时机 |
| --- | --- | --- |
| [01-PRD](01-PRD.md) | 产品定位、用户画像、功能清单（P0~P2）、性能指标（NFR）、与 Claude Code / Codex 对比矩阵 | 了解"做什么、做到什么程度" |
| [02-module-design](02-module-design.md) | 七大功能模块详细设计：Agent 内核、工具调用、MCP、子代理、沙箱、权限控制、项目记忆 | 实现任何模块前 |
| [07-dev-plan](07-dev-plan.md) | 三里程碑排期、任务分解表、依赖图、风险清单 | **每次开发会话开始时**（取任务、看验收标准） |

## 技术设计

| 文档 | 内容 | 阅读时机 |
| --- | --- | --- |
| [03-ui-design](03-ui-design.md) | 设计 tokens、桌面端布局、CLI TUI 形态、审批交互 | 桌面端 / TUI 开发前 |
| [04-architecture](04-architecture.md) | 包划分与依赖治理、进程模型、RPC 抽象、ADR 决策记录 | 架构级改动前 |
| [05-database](05-database.md) | SQLite 表结构、JSONL 会话流格式、migration 策略、密钥引用制 | 存储层改动前 |
| [06-api-spec](06-api-spec.md) | 控制面方法 / 数据面事件协议全集、错误码 | 协议层改动前 |

## 过程资产

| 路径 | 内容 |
| --- | --- |
| [../PROGRESS.md](../PROGRESS.md) | **任务进度唯一事实来源**：状态快照、任务日志、问题记录、下一步队列 |
| [testing.md](testing.md) | 测试说明：单元测试、冒烟脚本、基准测试、门禁体系、运行方法 |
| [defensive-patterns.md](defensive-patterns.md) | **防御式模式清单**：dsh 六条适配（P-1~P-6）+ RainCode M1~M4 原生沉淀（N-1~N-4）+ 问题记录格式（§0）与提交前自评审速查表 |
| [legacy-items.md](legacy-items.md) | **遗留项唯一台账**：处置口径（M4 收口 / 环境门控 / 保留申报）、21 项登记、收口路径 |
| [generated/protocol-catalog.md](generated/protocol-catalog.md) | 生成式协议目录（勿手改）：55 方法 / 19 事件 / 错误码族的 schema 机械投影，`pnpm protocol:gen` 再生成、`pnpm protocol:check` 防漂移（CI 门禁 6） |
| [research/2026-10-03-deepseek-harness.md](research/2026-10-03-deepseek-harness.md) | deepseek-harness 调研报告：项目定位/架构、与 RainCode 能力矩阵对照、设计思想与工程实践借鉴决策（M4 规划输入） |
| [benchmarks/](benchmarks/) | 各里程碑 NFR 基准留存报告：[m1-2026-09-28](benchmarks/m1-2026-09-28.md)（M1：NFR-1/2/3/5/7 首测）· [m2-2026-09-29](benchmarks/m2-2026-09-29.md)（M2：+NFR-4 桌面内存 / NFR-6 压缩非阻塞 / M1 指标复跑对比）· [m3-2026-10-02](benchmarks/m3-2026-10-02.md)（M3：NFR-1~7 全量重测 + 4.2 矩阵逐项核对 + 桌面 GUI 走查自动化） |
| [ui-mockups/](ui-mockups/) | HTML 高保真原型：桌面工作区 / 设置 / 记忆 / CLI TUI |

## 治理文件（仓库根目录）

| 文件 | 内容 |
| --- | --- |
| [architecture/policy.yaml](../architecture/policy.yaml) | 包依赖白名单、循环依赖禁令等架构策略（`architecture:check` 门禁依据） |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | 贡献指南 + 文档更新协议 |
| [LICENSE](../LICENSE) | MIT 许可证 |
