# M6 排期调研报告（2026-10-06）

> 调研指令：通过子代理调研工作盘（D:\）下的其余项目以及 RainCode 当前进展，进行详细调研分析，为 M6 排期提供证据基座。本文档是 [07 §12](../07-dev-plan.md) M6 增补排期与 [01-PRD §1.7](../01-PRD.md) 修订登记的**规划输入**（07 风险 7 纪律：排期前必须先修订 01-PRD）。

---

## 0. 调研方法与范围

四路并行只读子代理（Explore），2026-10-06 执行：

| # | 调研面 | 对象 |
| --- | --- | --- |
| R1 | RainCode 自身 | docs 全景（PROGRESS / 07 §11.5 五族与 §10.5 处置 / 01-PRD 结构 / legacy-items）+ 代码侧 M6 相关既有钩子复核（协议/存储/compact/skill/plugin/transport） |
| R2 | D:\ACMHelper\ACMHelper | 「ICPC 出题 Agent 系统」：设计文档全集 + Go 网关（gateway/，唯一真实后端代码）+ React 客户端 + Express mock（业务层仅文档+mock，接口契约抽象） |
| R3 | D:\ZCODE 安装包 | ZCode Desktop 3.14.4：app.asar 解包（out/main、out/host、out/scheduler）+ resources/glm（内嵌 CLI bundle zcode.cjs + 16 个内置插件源包）+ ~/.zcode 用户数据（plugins/marketplaces/cache、db.sqlite、rollout/model-io） |
| R4 | 其余同盘项目 | zhixue-engine（Spring Cloud 微服务）、smart-term（Java 智能终端）、finalVersion、DevGame/TxTGame、test/tmp-ui-test 等快速判定 |

诚实声明：R2 的 ACMHelper 后端未实现（文档+mock 形态），其价值在设计层；R4 的 smart-term 设计与代码有差距（如 chcp 65001 未实现）；finalVersion / TxTGame / test / tmp-ui-test / doc / zhixue(外层) / "wo rk" 与 M6 候选无关，仅作排除记录。

---

## 1. 各源关键发现

### 1.1 R1 · RainCode 当前进展与既有钩子

- **进展**：M1~M5 全部收口（T5.7 2026-10-06 ✅），单测 499、协议 58 方法/21 事件（v1.13）、CI「六门禁 gates + cli-bundle」双 job 全绿。M6+ 未排期；候选池 = 07 §11.5 五族 + §10.5 三条 ⏸ M6+ 行（回放 lane / session.delete / IDE·守护·更多端）。
- **回放 lane 前提已半成立**：每会话事件流 `packages/storage/src/paths.ts`（events.jsonl）+ 单写者 `jsonl-stream.ts` + 重放器 `jsonl-resume.ts`（resume 冷恢复已按事件重放）+ 存储级事件登记（compaction.applied/pruned、hook.invoked/result）+ T5.5 事件矩阵 25 事件。「回放格式 = 事件日志格式本身」只差录制→fixture→测试断言的 harness。
- **spill 无代码**：现有近似物是工具结果截断（`packages/tools/src/truncate.ts`）与 MCP 目录预算（`packages/server/src/mcp-tool-catalog.ts`，10% 窗口封顶 20000 tokens）；compact 线（`packages/agent-core/src/compact/`：service / microcompact / wiring）已完整。
- **Goal judge 代码为零**：文档锚点仅 07 §11.5 与三仓调研 `session/goal.ts` 条目。
- **marketplace 前置在位**：插件系统（`packages/tools/src/plugin/` scanPluginDir/readPluginManifest/activatePlugin + plugin.json 清单 + `packages/server/src/plugin-runtime.ts` plugins.rescan）与技能系统（`packages/server/src/skill-runtime.ts` workspace/global 双源 + T4.4 digest 热变更）均已落地，缺的是**分发**（市场清单/来源注册/安装布局/校验）。§11.5 明确前置条件：symlink/junction 逃逸防护。
- **session.delete**：AC-8 实现注记已声明「删除语义由 session.archive 承载，物理删除列 M5+ 候选」——升格即兑现该注记。
- **ACP**：`packages/rpc/src/transport.ts` IMessageTransport 扩展点 + stdio/ws 双实现验证了帧协议传输无关性；ACP spike 自评 2 人日（07 §11.5）。
- **守护**：serve/web 均为前台一次性宿主；`tool.background.*`（BackgroundTaskRegistry）已有后台任务生命周期原语，但无系统级 daemon/cron。

### 1.2 R2 · ACMHelper：Goal judge 与长任务的参照

- **三态 checkReport 门禁模型**（Goal judge 最有价值参照）：发布前完整性检查把质量拆成固定检查项清单，每项产出 `{item, status: pass|warn|fail, message}`——fail 硬阻止、warn 放行带警告、整体返回结构化 checkReport（`doc/backend-guide.md` §7.3，mock 实现 `mock/routes/problem.js:384-450`）。
- **双程序对拍**：正确性不靠 LLM 自评——Agent 同时生成正解+暴力解，随机数据双程序输出逐行比较，失败样本 `{input, stdOutput, bruteOutput}` 三元组落盘供修复迭代（`doc/backend-guide.md` §7.2、`doc/database-design.md` §6.3）。→ 对 Goal judge 的启示：**判定要尽量落在可执行证据上，LLM verdict 只做收敛层**。
- **任务表 + 统一状态机**：`generation_tasks`（task_key/status/progress/message/result JSON/error/**token_usage JSON**/起止时间）为唯一事实源，`pending→running→completed/failed` 全类型复用，前端动态间隔轮询 + 全局超时（`doc/backend-guide.md` §3.4/§7.6）。→ jobs/daemon 线的任务持久化与计量参照。
- **失败不回滚 + 手动重试**：编排链路任一 Agent 失败只记录不回滚已完成产物（省 Token），按粒度手动重跑（§7.4）。
- **编排层/调用层分离**：LangGraph 仅限编排层（条件边/循环/并行/interrupt），单次 LLM 调用留轻量层（`doc/python-backend-tech-stack.md` §2.4）。
- 无 marketplace / ACP / 逐事件 replay / 会话级上下文治理。另有「全量快照 + changeLog + 字段级 diff」轻量版本回放模型（§7.9），作 replay lane 的对照形态记录。

### 1.3 R3 · ZCode 安装包：marketplace 核心交付物与其余候选的实证

**marketplace 最小可行集（本轮最具体的设计输入）**：

- 市场清单 `marketplace.json`：`{name, version, plugins[{name, version, source, cachePath, description(_i18n), displayName(_i18n), category, author, icon, examplePrompts(_i18n)}]}`——呈现元数据（icon/i18n/示例 prompt）放市场条目，**不放插件本体**；实例 `~/.zcode/cli/plugins/marketplaces/zcode-plugins-official/marketplace.json`。
- 市场注册表 `known_marketplaces.json`：`{version, marketplaces[{id, source{url|github|path}, name, description, addedAt, pluginCount}]}`——source 支持 url/github/本地；甚至可添加 Claude 官方市场（跨生态兼容）。
- 安装布局：`plugins/cache/<marketplace-id>/<plugin-name>/<semver>/` + 内容寻址校验种子 `.zcode-plugin-seed.json`（`{hash, marketplace, plugin, pluginVersion, source, version}`）；源目录、市场缓存副本、安装副本三者分离。
- 插件清单 plugin.json 最小只需 `{name}`；组件字段 `skills` / `commands` / `agents` / `hooks` / `mcpServers`（+路径限定在插件根内、`${PLUGIN_ROOT}` token、兼容 `.claude-plugin/` `.codex-plugin/` 目录名）；运行时宿主插件用 "Not user-facing" 文案在市场隐藏。权威规范：plugin-creator 插件内 `references/plugin-json-spec.md`。
- 技能契约：SKILL.md frontmatter 仅 `name` + `description`（触发路由靠 description 措辞），可选 `when_to_use` / `metadata` / `license`；大技能多文件目录（SKILL.md 为入口 + references/scripts 旁路）；bundled（系统级、不可卸载、不进市场）与插件级技能分层。
- 子 agent 判定范式（Goal judge 参照）：`agents/visual-judge.md`——只读 + 限定 tools + 输出「每页一行 JSON verdict（pass/fail + evidence）」+ 修复循环协议写在 system prompt 约定。

**其余候选实证**：

- **ACP 已被 ZCode 退役**：main 进程含 `isRetiredAcpRuntimePath` 与退役目录清单（acp-auth/acp-config/acp-stream-diagnostics/acp-traffic-proxy），tasks 表曾有 `acp_session_id` 列并有专门迁移函数，官方还有 restore-legacy-sessions 插件恢复 ACP 时代会话；现行自有 "ZCode Protocol"。**多生态兼容做在插件格式层（`${CLAUDE_PLUGIN_ROOT}` token、兼容目录名、可加 Claude 市场），不在协议层**。→ 对 RainCode 的含义：ACP 投入产出比下调；若未来启用，DB 需预留外部会话 ID 列与迁移钩子。
- **无系统 daemon**：Electron main 用 `utilityProcess.fork` 起 host/scheduler；后台自动化（cron/off-peak）落 `v2/tasks-index.sqlite` 的 automations/automation_runs/off_peak_tasks 表 + budget 字段；hooks 的 async 字段无运行时效果，官方建议脚本自行 daemonize。→ serve 长驻守护线的形态参照：**调度态落库 + 子进程承载，不做系统级守护**。
- **compact**：`autoCompactThresholdTokens`（可空=关闭）+ trigger 枚举（manual/auto/partial/reactive/session_memory）+ `session.time_compacting` 列 + 时间线合成事件；**进行中的 compact 是不可 fork/不可分享的会话边界**。无 "spill" 概念（grep 0 命中）。
- **会话录制/回放**：模型 I/O 全量录制 `rollout/model-io-<sessionId>.jsonl`（每行完整 request/response + traceId/turnId/querySource/durationMs，开关在 settings）+ SQLite 结构化 session/part/sequence 两层分离。→ replay lane 的「录制开关 + 分层（I/O 录制 ≠ 结构化会话存储）」参照。

### 1.4 R4 · zhixue-engine / smart-term

- **zhixue-engine**（daemon 参照）：systemd unit 模板生成（Restart=always/RestartSec=5/Environment 注入）+ `/actuator/health` 健康端点 + 启动顺序用 healthcheck 条件表达（docker-compose `service_healthy`）+ JudgeWorker 生命周期样板（@PostConstruct 轮询线程 + 固定线程池 + @PreDestroy awaitTermination 优雅停机）+ Redis List 轻量队列（零 MQ）+ 能力探测降级（Docker 不可用走本地执行）+ 容器对象池（空闲回收/复用上限）。→ M7+ 守护/cron 线的设计素材。
- **smart-term**（replay 反向参考）：只有命令级历史三元组 `{command, sessionType, timestamp}`（补全加权用），**无输出记录、无回放**——反向定义了会话回放需要补的数据维度（输出流 + cwd + 时间戳对齐）。AI 无感降级（6 条触发条件静默回退本地）与过期结果丢弃（请求 ID 失配即弃）是 UI/异步层稳健性参照。
- **实现计划文档范式**（smart-term/TxTGame 的 `docs/compose/plans/`）：任务编号 → Files(Create) → Interfaces(Covers/Consumes/Produces) → checkbox 步骤（先失败测试后实现）→ 验证命令 → commit——与本仓 07 任务分解表同构，互证当前排期格式；其「验证命令」列对 T6.5 Goal judge 的验收基准格式有直接参考。

---

## 2. 对 M6 五族候选的证据映射

| 族 | 证据强度 | 关键输入 | 本轮结论 |
| --- | --- | --- | --- |
| 扩展生态（marketplace） | **强**（R3 给出全套真实文件格式；R1 确认 plugin/skill 系统在位） | marketplace.json 字段子集 + 注册表 + cache/seed 布局 + plugin.json 组件字段 + 逃逸防护前置 | ✅ 纳入 T6.1（path 源先行） |
| 上下文与记忆（回放 lane / spill） | **强**（R1 前提半成立；R3 给录制分层与开关参照；R4 反向定义数据维度） | events.jsonl=回放格式本身 + model-io 分层录制参照 | ✅ 纳入 T6.2 / T6.3 |
| 内核强化（Goal judge / session.delete） | **中强**（R2 三态 checkReport + 对拍证据化；R3 visual-judge 只读 JSON verdict 范式；session.delete 自设计口径 §10.5 已定） | 判定证据化 + verdict 三态 + 防早停续跑上限 | ✅ 纳入 T6.5（MVP）/ T6.4 |
| 形态扩展（ACP / 守护 / jobs） | **转弱**（R3 实证：ZCode 退役 ACP、无系统 daemon） | 兼容在插件格式层；调度态落库+子进程承载 | ⏸ M7+（证据入 §12.5） |
| 工程（knip / 架构 --changed） | 中（无新证据，维持 07 §11.5 原判） | — | ✅ 并入 T6.6 收尾 |

---

## 3. M6 取舍结论

**纳入（T6.1~T6.6，任务分解见 07 §12.2）**：插件 marketplace 分发基座（本地 path 源先行，url/github 预留不实现）；会话录制回放测试 lane（回放格式 = 事件日志格式本身）；spill 溢出家族（超大工具结果落盘 locator）；`session.delete` 物理删除（tombstone + vacuum 自设计）；Goal/Stop 判定 judge MVP（三态 verdict + 防乐观早停）；工程收尾与遗留批次 D（knip / 架构 --changed / NFR 复跑 / 基准留存）。

**明确不做 / 缓议（本轮调研定论）**：

- **ACP server 不排期**：ZCode v3.14.4 已退役 ACP 迁自有协议（退役目录清单 + acp_session_id 迁移器 + legacy 会话恢复插件实证），且其多生态兼容做在插件格式层而非协议层——RainCode 协议面（58 方法/21 事件）已双 transport 验证传输无关，协议层互投收益低；若未来启用，前置条件登记为「DB 预留外部会话 ID 列 + 迁移钩子」。
- **系统级守护进程不排期**：ZCode 无系统 daemon（utilityProcess 子进程 + automations 调度态落库）；RainCode 桌面端已有 AgentHost spawn + 崩溃自动重启，serve 长驻 + cron 四件套（jitter/lock/sentinel）列 M7+，设计参照 zhixue-engine 生命周期样板与 ZCode 调度态落库形态。
- **插件市场远端源与呈现层不排期**：url/github 源、i18n/icon/examplePrompts 等 UI 呈现字段（ZCode 已实证的完整面）对单机本地优先产品非最小需求，T6.1 仅取清单/注册/安装/校验骨架。
- **逐帧终端回放不做**：smart-term 反向参考 + ACMHelper 快照-diff 对照——回放 lane 限定为事件日志重放（测试设施），不做 UI 逐帧重放。

**Goal judge 设计要点沉淀（T6.5 实施输入）**：目标登记（objective + revision）→ Stop 判定时独立 judge 调用（只读、独立上下文）→ 三态 verdict（achieved / not_achieved / continue + evidence 摘要，参照 ACMHelper 三态 checkReport 与 ZCode visual-judge JSON verdict）→ not_achieved 注入 continue 指引续跑（防乐观早停，续跑次数有界）→ verdict 与证据审计落盘。判定证据化优先：能用可执行证据（测试/构建/文件落盘）就不用纯 LLM 自评（ACMHelper 对拍启示）。真实 LLM 验证走环境门控（smoke:remote 同口径，不计门槛）。

**排期纪律核对**：01-PRD v1.2 已修订登记（§1.5 M6 行 + §1.7 增补范围 + §5 新功能点 AC-13/TL-8/TL-9 与 AC-8 注记更新）——07 风险 7 前置条件满足；§10.5 三条 ⏸ M6+ 行在 07 §12.1 逐条销账。
