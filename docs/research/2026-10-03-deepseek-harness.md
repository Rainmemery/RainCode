# deepseek-harness 调研报告（2026-10-03）

| 项目 | 内容 |
| --- | --- |
| 调研对象 | [deepseek-harness](../../deepseek-harness/)（DeepSeek 官方开源 agent harness，CLI 名 `dsh`，MIT，v0.2.1-alpha.1 developer preview） |
| 调研动因 | RainCode M1~M3 全部收官，07-dev-plan 无后续排期；为 M4 及以后规划提供参照系（能力对照 + 工程实践借鉴） |
| 调研方式 | 只读调研：README / AGENTS.md / docs/ 全目录（60+ 主题文档）/ packages 分层 / vitest 与 CI 配置 / scripts 门禁脚本 |
| 产出 | 本报告 + [07-dev-plan §10 M4 增补排期](../07-dev-plan.md) + [legacy-items 遗留项台账](../legacy-items.md) |
| 关联决策 | M4 主题定为「工程加固与遗留收口」；借鉴决策见本报告 §5 |

> 注：deepseek-harness 是被克隆进本工作区的外部参照仓库（已加入 .gitignore），不参与 RainCode 构建、门禁与提交。

---

## 1. 项目定位与整体架构

### 1.1 这是什么

DeepSeek Harness 是把「模型循环 + 工具 + 沙箱 + 会话持久化 + Web/桌面 UI」全部组装起来的通用 agent 运行时（`npx @deepseek-ai/dsh web` 即启动本地 Web UI）。规模：约 319 个 workspace 包、4300+ TS 源文件、docs/ 60+ 主题文档全部英中双语成对维护。

三个核心概念：

- **Cordis 插件框架**（vendored 自 cordiverse/cordis）：插件向共享 Context 贡献服务（声明式 `ctx.<key>` 占位）、类型化事件（emit/waterfall/parallel/serial/bail 五种派发模式）和可逆 effect（每个 `register()` 返回 disposer）。
- **一切皆插件**：模型适配器（`ctx.llm`）、工具注册表（`ctx.tools`）、会话日志（`ctx.sessions`）、**连 agent-loop 本身**（`ctx.agentLoop`）都是插件，全部可从配置替换，没有特权内核。
- **Profile / Bundle / Patch 三层组合**：运行实例 = 启动时按有序层叠出的插件树（内置 profile：web / headless / sdk / acp）；`dsh --profile web --dump-config` 可打印最终插件树，任何一行都能被用户 patch 替换。

运行形态四条：Web（Node Host + 浏览器 Typert RPC）、Desktop（Electron，Host 在 Node 模式 + 窗口加载 Web 资产）、Headless（一次性任务）、SDK（进程外 JSON-RPC over stdio，TS + Python 双 SDK）。

### 1.2 代码组织铁律

- **Capability Seam（能力接缝）三角色**：每个能力 = Service Definition（拥有 `ctx.<key>` 的抽象类）+ Service Provider（一个或多个实现）+ Consumer（消费者，常是模型工具）。**扩展插件只依赖 Definition，绝不依赖具体 Provider**——UI/工具插件依赖 `dsh-agent` 而非 `dsh-agent-loop`，所以 loop 可替换；模块依赖图由生成器产出并做新鲜度门禁。
- Spine 主干六个包承载一个 turn（session / system-prompt / tools / agent / agent-loop / scope）；能力家族按三件套拆包（如 shell 家族：`dsh-shell` 定义 + `dsh-bash-local`/`dsh-bash-sandbox` 提供者 + `dsh-tool-bash` 消费者）。

### 1.3 值得记录的设计不变量

- **Model-visible ⟺ logged**：任何到达模型请求的东西必须能从会话日志重建；新的模型可见输入必须有 session 事件——「派生历史、永不旁路存储」。失败尝试记录为 `assistant/attempt` 但不进模型历史。
- **请求冻结**：模型请求从日志派生并冻结，重试不重复组装；`agent/pre-step` waterfall 是权威入口裁决（压缩、技能目录、计划模式、时间上下文全部挂同一个有序瀑布）。
- **审批 fail-closed**：`ApprovalOutcome` 封闭集合，`allowed-once` 是唯一放行，缺答者/异常/野值一律归一化为 `unavailable`（拒绝）；asked/decided 双审计事件 log-only。
- **沙箱 enforcement 上报**：`full|partial` 明示执行完整度；runner 失败与命令被拒（denial signature）两类 stderr 分类器分离；per-call policy。
- **压缩锁括弧**：compaction/start → summary → end 三事件先 append start 最后 release end，崩溃留下可检测孤儿锁；压缩前可插独立 pass 预剪枝大工具结果。

## 2. 与 RainCode 的对照

| 维度 | deepseek-harness | RainCode（M3 收官态） | 差距定性 |
| --- | --- | --- | --- |
| 定位 | 通用 agent harness（多形态多后端） | 个人 AI 编程工作台（PRD 锁定单机双端） | 定位不同，不构成追赶关系 |
| 插件化 | Cordis 全插件树，loop 可替换 | 目录扫描式插件（加载/启停/故障隔离） | 架构层级差异，**不采纳重构**（ADR-05/06 已收敛） |
| 工具系统 | 五段守卫管线 + `isConcurrencySafe` + timeoutMs 预算 + presentCall/Result | ToolRegistry/Executor + 三态权限 + 并行调度 | 基本对齐；守卫管线分层更细 |
| 权限/审批 | fail-closed 封闭集合 + 审计双事件 + 预设表 | 五级判定链 + grantId 单消费 + decisions 落盘（audit-logger） | 骨架对齐；fail-closed 归一化边界可对照补强 |
| 沙箱 | bwrap/Landlock/Seatbelt/Windows ACL + enforcement 上报 | Docker/WSL/SSH/local Executor + 回退告警 | RainCode 偏 argv 级策略；enforcement 上报可借鉴 |
| MCP | 官方 SDK + 每连接一插件 + 资源工具 | stdio/HTTP + 状态机 + 命名空间 + 启停/健康检查 | 对齐（RainCode T3.7 已补管理面） |
| 记忆 | 无独立记忆服务（session-query 检索 + context 注入 + 推荐第三方 memory MCP） | MEMORY.md 三层 + 抽取 + 晋升草案 + FTS 检索 | **RainCode 更完整**（产品化记忆是 PRD 功能点） |
| 压缩 | 压力触发 + 锁括弧 + toolResultPruner | 阈值触发 + epoch 守卫 + 保留区 + 失败上调 | 对齐；孤儿锁为 dsh 增量 |
| 子代理 | 六后端注册表（含跨产品 ACP/Codex/Claude Code）+ continuable + agent-team | 同工厂派生 + 并发槽 + 角色模板 + 并行汇聚 | dsh 后端生态更广；RainCode 够用 |
| 技能 | 目录优先级表 + 会话前缀目录注入 + digest 变更重发布 + modelInvocable/userInvocable 双开关 | markdown 技能包 + 控制面 skills.list/invoke + 斜杠面板 | **关键差距：模型侧不可见**（M4 T4.4 收口） |
| 多端 | Web/Desktop/Headless/SDK/ACP 五形态 | CLI/Desktop/Web 三端 | 形态差异，够用 |
| 测试 | 8 个 vitest lane + 覆盖率门禁 + 录制回放快照 + 真 API e2e | node:test 203 + 14 smoke + bench + 2 走查脚本 | dsh 工程化深一个量级；分层思想可借鉴 |
| 文档 | 生成式目录 + freshness 门禁 + 双语配对 + 字数预算 | 手写 7 份 + PROGRESS 单一事实源 | 生成式 + 防漂移可借鉴（T4.3） |

## 3. 值得借鉴的设计思想（含采用决策）

| # | dsh 实践 | RainCode 现状 | 决策 |
| --- | --- | --- | --- |
| 1 | **技能目录注入 + digest 重发布 + modelInvocable 双开关**：模型在会话内可见技能目录、自主按需加载正文；用户/模型调用分离 | 技能只有控制面方法与斜杠面板，模型完全不可见——模型永远无法自主使用技能 | **M4 采纳（T4.4）**，是本轮调研最高价值功能借鉴 |
| 2 | **生成式文档 + freshness 门禁**：tool-catalog / config-catalog / persistence-catalog / module-graph 全部由源码生成，`gen-*` 与 `verify-*` 双模式防漂移 | 06-api-spec 54 方法 / 19 事件手写表格，随协议演进靠人工同步 | **M4 采纳（T4.3）**：协议目录由 METHOD_SCHEMAS/EVENT_SCHEMAS 生成，--check 入 CI |
| 3 | **防御式模式清单**（`docs/defensive-patterns.md` 六条：正交结果独立上报 / 公共契约两侧遵守 / 异步状态不是同步状态 / dispose 必须达到静默 / 派发器收容回调异常 / 不给不可信输出环境变量或可预测路径） | 经验散落在 PROGRESS §4 问题记录（mtime 盲窗、双 readline、close 竞态） | **M4 采纳（T4.6）**：写自己的 defensive-patterns.md，dsh 六条 + RainCode 实战沉淀 |
| 4 | **审批 fail-closed 归一化**：封闭 outcome 集合，缺答/异常/野值 → `unavailable`（拒绝），审计 asked/decided 成对 | 判定链 + grantId 单消费 + decisions 落盘已有；超时视为 deny 已实现（07 风险 9） | **M5+ 对照补强**（骨架已对齐，增量收益小，不进 M4） |
| 5 | **沙箱 enforcement 上报**（full/partial 明示 + runner 失败 vs 命令被拒分类） | Executor 工厂 + 不可用回退 local 告警（一次性 warning） | **M5+ 候选**：回退 local 时工具结果 metadata 应持续明示「无隔离」而非一次性告警 |
| 6 | **压缩锁括弧**（start/end 事件对 + 崩溃孤儿检测） | epoch 守卫 + ticket 幂等已覆盖核心；崩溃窗口由 resume 连续性用例覆盖 | **M5+ 候选**（未观察到对应故障形态，不预支复杂度） |
| 7 | **事件生产者/消费者矩阵**（生成物：谁发、谁听、什么模式） | 事件面 19 个，接线分散在 server/agent-core/desktop | **M5+ 候选**（随 T4.3 生成式管线自然延伸） |
| 8 | **`--dump-config` 可观测性**（打印最终生效组合树） | 配置分层（文件/env/CLI）但无「最终生效配置」一键输出 | **M5+ 候选**（`raincode config dump`） |
| 9 | **capability seam 显式化**（扩展只依赖 Definition 的依赖约束 + seam 图） | 包依赖白名单（architecture-policy）已表达方向约束，但无 Definition/Provider 词汇 | **M5+ 候选**（包结构收敛后收益有限） |
| 10 | **agent-team 多代理协作**（roster/任务板/邮箱，dsh 自标实验性） | 并行编排汇聚已够 PRD 范围 | **不采纳**（超 PRD；dsh 自己也是实验态） |

## 4. 值得借鉴的工程实践（含采用决策）

| # | dsh 实践 | RainCode 现状 | 决策 |
| --- | --- | --- | --- |
| 1 | **CI 门禁编排**（run-gates 统一编排 + lane 划分 + runner 故障切换） | **无 CI**——T1.1 承诺的 GitHub Actions 骨架从未落地，四门禁只在本地跑 | **M4 采纳（T4.1）**，工程欠账核销优先级最高 |
| 2 | **录制会话回放 lane**（录制的 JSONL 既是输入又是期望输出；replay/record/refresh 三态） | smoke 体系用脚本化 mock 驱动，行为资产未录制化 | **M5+ 候选**（现有 smoke 覆盖足够，录制化是资产增强） |
| 3 | **「验证世界而非自述」/「测真实入口」**：e2e 重读文件而非信 agent 自述；bin 测构建产物；「guard 只在回归能变红时才叫 guard」 | walkthrough 脚本已践行（CDP 驱动真实构建产物）；未成文 | **M4 采纳**：作为原则写进 defensive-patterns / testing 文档 |
| 4 | **per-file 100% 覆盖率门禁**（「未覆盖行 = 待删死代码」） | 203 单测，无覆盖率门禁 | **不采纳**（存量规模不允许一刀切；可选 M5+ 划定渐进覆盖率圈） |
| 5 | **文档三件套双语机制**（.md + .zh.md + .i18n.yaml 按 section hash 配对） | 单人中文项目 | **不采纳**（成本 > 收益；若需英文版再启用该方案） |
| 6 | **文档字数预算 + slop checklist + one home per fact 分层法** | docs 七份结构清晰，无防膨胀机制 | **M5+ 候选**（先在 CONTRIBUTING 引入「one home per fact」原则） |
| 7 | **postmortem 制度**（subtle + systemic + costly to rediscover 三条件） | PROGRESS §4 问题记录承担同等职能 | **M5+ 候选**（重大事故再启用独立文档形态） |
| 8 | **lefthook 分层**（pre-commit staged 快检查 / pre-push typecheck / 全量归 CI） | 无 git hooks，门禁全靠手动/CI | **M5+ 候选**（CI 落地后再评估 hooks 收益） |
| 9 | **pnpm `allowBuilds` 默认拒绝 + 逐条理由** | 已采用 allowBuilds 白名单（better-sqlite3/esbuild/electron） | **已对齐** |
| 10 | **vendor 体系**（manifest 记 SHA + local-modification 日志 + gate） | 无 vendored 依赖 | **不适用** |

## 5. 结论

1. **定位判断**：dsh 是「框架级」的 harness（一切可替换），RainCode 是「产品级」的工作台（PRD 锁定范围）。两者规模差两个量级，**不应也不需要对齐 dsh 的架构复杂度**；ADR-05/06 的包收敛决策在 RainCode 体量下依然正确。
2. **最大功能差距**：技能的模型侧可发现性（dsh 技能目录注入 + modelInvocable）——RainCode 的技能目前只能被用户经斜杠面板调用，模型无法自主发现与使用，这是 M4 唯一的功能向任务（T4.4）。
3. **最大工程差距**：CI 缺失（T1.1 承诺项）与手写协议目录的漂移风险——分别由 T4.1 / T4.3 收口。
4. **最值得沉淀的软件资产**：防御式模式文档（T4.6）——把 M1~M3 实战踩坑从 PROGRESS 流水账升级为可评审的原则清单，这是 dsh「六条模式条条见血」的直接启发。
5. **遗留项**：三里程碑累积的 19 项遗留（环境门控 5、工程欠账 4、口径偏差 4、无留存验收 2、保留申报 4）全部登记入 [legacy-items 台账](../legacy-items.md)，M4 内收口 6 项、环境就绪即收口 5 项、其余明确保留口径。
