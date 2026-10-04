# M5 参照系三仓调研报告（2026-10-04）

| 项目 | 内容 |
| --- | --- |
| 调研对象 | [MiMo-Code](../../MiMo-Code/)（小米 MiMo 团队终端 AI 编码助手，OpenCode fork，Bun 运行时）· [deepseek-harness](../../deepseek-harness/)（第二轮增量调研，首轮报告见 [2026-10-03](2026-10-03-deepseek-harness.md)）· [ZCode](../../ZCode/)（AI 编程工作台：桌面 Electron + Web + TUI 三形态） |
| 调研动因 | M4 全量收官后队列清空；07 §10.5 纪律要求 M5 排期前先修订 01-PRD 登记编号——本报告为规划轮的证据基座 |
| 调研方式 | 三个只读调研子代理并行（搜索广度 very thorough），结论逐条落文件路径证据；dsh 轮二先读首轮报告、只做 M5 五个候选方向的机制级增量 |
| 产出 | 本报告 + [01-PRD v1.1 M5 登记](../01-PRD.md)（§1.5/§1.6）+ [07-dev-plan v1.2 §11 M5 排期](../07-dev-plan.md)（T5.1~T5.7） |
| 关联决策 | M5 主题定为**「扩展机制与上下文治理」**；采纳决策见 §3，明确不做见 §4，M6+ 候选沉淀见 §5 |

> 注：三仓均为克隆进本工作区的外部参照仓库（已全部加入 .gitignore），不参与 RainCode 构建、门禁与提交。

---

## 0. 三仓概览对照

| 维度 | MiMo-Code | deepseek-harness | ZCode |
| --- | --- | --- | --- |
| 定位 | 终端原生 AI 编码助手（OpenCode fork + 自研记忆/子代理/workflow/自我改进） | 通用 agent 运行时（Cordis 插件框架，一切皆插件） | AI 编程工作台（同一内核输出桌面/Web/TUI/SEA） |
| 形态 | CLI+TUI（`mimo`）+ `mimo serve` HTTP/SSE + ACP 接 IDE + Desktop Beta | Web / Desktop / Headless / SDK（JSON-RPC over stdio） | Electron 桌面 + Web（3030/5173）+ TUI/CLI 统一入口 + SEA 单文件 |
| 规模 | 4 包；非测试 TS 691 文件 + 测试 537 文件，约 29.6 万行；SQLite migration 60+ | 约 319 workspace 包、4300+ TS 源文件、docs/ 60+ 篇双语 | 14 包 + cli 内嵌 17 子包，约 76 万行 / 3900 文件（ui 包 32.7 万行） |
| 技术栈 | Bun 1.3、Effect 4、drizzle+SQLite、Hono、SolidJS+opentui、quickjs 沙箱 | Node、Cordis、zod、vitest、tsdown | Node≥24、turbo、React 19、esbuild、oxlint+oxfmt、koffi、release-it |
| 协议规模 | Hono 路由（session 单文件 43 端点）+ SSE | 未统计（本轮范围外） | 74 方法（zcode-protocol）+ 80 事件（SessionEventType） |
| 测试与门禁 | bun test 4 分片（path-hash）+ 6 独立进程套件；oxlint+tsgo；无覆盖率门禁 | vitest per-file 100% 覆盖 + 豁免 membership contract；lefthook 六 job | 全仓仅 4 个 .test.ts（开源发行版测试清零）；强在架构治理（architecture-policy + --changed） |
| 与 RainCode 同构度 | 中（CLI/记忆/子代理重叠，Bun+Effect 异构） | 中低（插件架构哲学差异大，工程实践可借鉴多） | 高（桌面+Web+CLI 三端、rpc 协议、hooks/skills/plugins 形态几乎逐点对照） |

---

## 1. 三仓共性定论（规划轮的七条收敛）

1. **embeddings / 向量检索：三仓都没做**。MiMo 全套走 SQLite FTS5+BM25（记忆 `memory/fts.sql.ts` + 会话历史 `history/fts.sql.ts` + MCP 工具目录手写 BM25 K1=1.2 `tool/mcp-tool-search.ts`），并沉淀两条关键经验：**相对分数地板**（top hit × 0.15，BM25 绝对阈值随语料尺寸漂移不可用）与 **3x 过取样**；dsh 用 FTS5 unicode61（对中文，RainCode 已有的 trigram 选型反而更优——RainCode 不落后）；ZCode 纯文件方案（每事实一文件 + frontmatter + wiki 链接 + MEMORY.md 索引注入）。→ **embeddings 移出 M5 候选**，有真实召回缺口再议。
2. **hooks 生命周期：两仓成熟，一仓反对自研**。ZCode 有完整体系（7 生命周期事件 / JSON 输出契约 / project 级 trust 授信且**授权决定绝不缓存**、每 dispatch 前重验 / matcher 管道多选）；MiMo 给出分层纪律（稳定钩子 + `experimental.` 前缀实验区）与 hook 注入消息的 **provenance 溯源**（`plugin/src/index.ts:394`）；dsh 反对自研生命周期、主张直接兼容 Claude Code hooks.json command 子集（`packages/hooks/`），其 **log-only 审计事件对**（`hook/invoked`+`hook/result`，stderr 500 字符截断）与 fail-closed 语义是稳态答案。→ M5 主菜（T5.1），契约以 ZCode 为蓝本、纪律取 MiMo、审计取 dsh。
3. **compact 前预剪枝旧工具结果：两仓同题互证**。ZCode `core/src/compact/microcompact.ts`（阈值 0.9 比例 / 保留最近 5 条 / 最小节省 256 tokens / 可压缩白名单 Read/Bash/Grep/WebFetch）；dsh `compaction-tool-result-pruner` 三不变量（压力确认后才剪 / `sourceEventSeqs` 回指原文保 resume/回放一致 / 单过确定性收敛 head+marker+tail 恒≤阈值，按 code point 切分不劈代理对）+ shadow-price 计价协议。→ 采纳（T5.4）。
4. **会话回放：正确顺序是「回放格式 = 会话日志格式本身」**。dsh 的录制品就是 Session JSONL（Model-visible⟺logged 的直接复用），另有 `llm-replay`/`session-snapshot` 两层测试基建；ZCode 无录制器只有 journal 底座；MiMo trajectory wire 格式 + QuickJS 沙箱剥离 Date/random 的确定性约定。→ M5 只做事件矩阵 + 导出基座，回放 lane 沉淀 M6+。
5. **IDE 接入的正确姿势是实现 ACP 标准协议而非自写插件**。MiMo 有完整 agent 侧 ACP 实现（`acp/agent.ts`，Zed 等编辑器的接入标准）；dsh 的 ACP server 定位 automation-only 且「IDE 作为 client 拉起 harness」；ZCode 无 IDE 插件但协议 client-agnostic 印证同一路线。→ M6+ spike（先 2 人日验证 ACP ↔ RainCode 协议对接）。
6. **后台守护进程：三仓形态各异且无共识**。MiMo `mimo serve` + cron 调度器全套（jitter/lock/sentinel）；dsh 无独立 daemon（长驻=web/desktop host，后台能力走 `jobs` 注册表 + **完成通知注入原会话**）；ZCode 有 automation/offPeak 方法族 + 独立 server 进程。→ M6+，采纳时 jobs 的「通知注入」形态优先。
7. **权限语义对照出差距**：MiMo 权限求值仅 8 行——**last-match-wins**（`permission/evaluate.ts`，findLast 后匹配者胜）+ `hardPermission` 不可放宽层（plan 模式防配置放宽）+ 审批持久化 + forced-ask 60s 超时自动拒绝；ZCode 五模式优先级有大量实战注释（alwaysAsk 压过 yolo 直通，`permission/service.ts:323-339`）。→ 对照补用例沉淀 M6+ 候选。

---

## 2. 逐仓机制精华（带证据路径）

### 2.1 MiMo-Code

- **架构**：`packages/cli/src/agent/agent.ts`（616 行，Agent Info 含 `hardPermission`/toolAllowlist/completionGate）+ actor 系统（`src/actor/`：spawn/waiter/inbox，turn 执行 `actor/turn.ts`）；Effect Layer 化 DI 贯穿全部服务。
- **工具并发闸门**：`tool/gate.ts`——每步工具调用 FIFO 准入（read/grep/glob 并行，edit/write/bash 屏障类，同一 assistant step 内按序进闸），文件头自述动机是「并发工具调用交错导致 edit 与 git commit 竞态」（RainCode M4 竞态修复同款问题的成熟答案）；同批前一工具失败即 fail-cascade 取消后续。
- **记忆**：三层文件（项目 MEMORY.md / 会话 checkpoint.md / notes.md）+ FTS5 索引（行带 scope/scope_id/type 过滤列，`memory/fts.sql.ts`）+ `globalMemoryPath` 跨项目记忆（`session/checkpoint-paths.ts`）+ 写入门禁（`memory/write-gate.ts`，MEMORY.md 编辑受权限管控）；还能索引 Claude Code 的 `~/.claude/projects`（`memory.cc_index`）。
- **结构化 checkpoint**：`session/checkpoint-templates.ts` 10 节模板（意图/下一步/任务树/发现的知识/错误与修复/设计决策…），§7 明确「候选晋升 MEMORY.md」；配预算化读取 `budgeted-read.ts` 与上下文重建 `checkpoint-context.ts`——比 RainCode L2 自由文本抽取更结构化。
- **自我改进**：`/dream`（扫会话轨迹把持久知识固化进项目记忆）+ `/distill`（把重复手工流程提炼成 skill/agent/command）且均有自动版（默认 7 天/30 天，`session/auto-dream.ts`）。
- **新大陆**：Goal/Stop 判定（`/goal` 设停止条件 + 独立 judge 模型评审防「乐观早停」，`session/goal.ts`）；Max Mode（并行 5 个 propose-only 候选流 + 评审选择 + n-gram 重复检测，`session/max-mode.ts`）；MCP 工具目录化延迟加载（20K token 目录 + `mcp_tool_search` BM25 检索上限 32 个）；git worktree 隔离并行（`src/worktree/`，compose workflow 自动分派）。
- **工程**：`bun build --compile` 单二进制 11 target（`script/build.ts`，含 pinned bun 版本硬校验——注释记录「杂散 bun 二进制导致 TUI worker RPC 挂起但 smoke 通过」教训，build.ts:22-29）；构建期宏注入 migrations/VERSION（`build-node.ts`）；CI path-hash 4 分片 + 「MCP 套件 process-wide mock 必须独立进程」约定（`.github/workflows/test.yml`）。

### 2.2 deepseek-harness（第二轮增量）

- **dsh 现状澄清**：无 embeddings/向量检索、无代码语义索引、无跨项目全局记忆、**无 session.delete**（JSONL 持久层是不可变 generation 文件 + 整代原子发布，`session-persistence-jsonl/src/generation.ts`；delete 仅 KV 表 tombstone，`storage-domain/domain.ts:315-326`）——RainCode 若做物理删除需自设计（tombstone + vacuum）。
- **hooks = Claude Code/Codex 兼容桥**（`packages/hooks/`）：只支持 `{type:'command', command, timeoutSec}` 子集；matcher 分 dialect（CC 纯 `[A-Za-z0-9_|]+` 走 literal 管道多选，否则 regex）；审计 log-only 事件对 `hook/invoked`+`hook/result`（`handlerId` 配对、turn-enclosed、stderr 500 字符截断、durationMs 落盘）；hook 可 block prompt/工具调用（model-visible）、注入上下文、强制续跑。
- **enforcement 上报落地细节**：`SandboxEnforcement = 'full' | 'partial'`（`sandbox/src/index.ts:60`，注释明言「绝对边界不得当作 full」）；Windows ACL 档自报 partial（`sandbox-local/src/index.ts:17`——与本机形态直接同构）；旧 Landlock ABI 经 `informationalLines` 上报 partial；`probeRunner` 三态择优；升级链 `sandbox/src/escalation.ts`：严格加宽表 + `sandbox_permissions`/`justification` 成对校验 + 模型可见拒绝标记 `[sandbox: file access denied under ${mode} mode]` + 同轮重试提示。
- **回放测试基建三层**：`test-support/llm-replay`（挂 `llm/stream` waterfall 重放 + `replay.override.json` sidecar 表示不可重建的预分块失败）+ `test-support/session-snapshot`（closed manifests + 身份脱敏 + 四协议适配器，ACP 适配器起真子进程）+ 仓库 `snapshots/` 全量证据；`DSH_SNAPSHOT=replay|record|refresh` 三态。
- **dump-config 机制**（`apps/cli/src/dump-config.ts`）：**不 boot、不 eval**，按 bundle→profile→home→`--patch` 顺序静态列层、逐项来源标签；`defaultOnly` 模式是配置文件损坏时的恢复诊断（坏文件不解析也能打印内置层）；配套 schema 发布 + e2e 期望快照。
- **事件矩阵**：`docs/event-producer-consumer.md` 由 `scripts/gen-doc-graphs.ts` 生成（Event | Mode | Declared in | Dispatchers | Listeners，显式收录故意绕过 ctx.emit 的派发点）——RainCode 已有 T4.3 生成管线，扩展一个生成器约 1~2 人日。
- **per-file 100% 覆盖**（`vitest.config.ts:379-386`）+ 豁免机制 `scripts/coverage-exempt.ts`（membership contract：重型套件豁免的前提是其被测文件已被其他套件全覆盖，否则降阈值等于骗自己）——豁免机制本身就是渐进式采纳的入口。
- **新大陆**：spill 溢出家族（`packages/spill/`，超大工具结果落盘 session 私有文件、模型拿 locator+检索指引，防上下文膨胀，改造采纳约 2 人日）；jobs 后台任务（`ctx.jobs` + `tool-jobs` read/wait/list/kill，完成以**通知注入原会话**而非轮询）；ssh 四包家族（一条共享 OpenSSH 连接 + 远端 helper，Harness 留本地只换 provider 四件套——capability seam 红利，超 PRD 不采纳）；持久化 shell 会话工具（`tool-pwsh-persistent`，Windows 相关值得对照）；compact-image-offload（图像预算超限的永久文本替换重试）。

### 2.3 ZCode

- **架构**：contracts（Port+事件+zod）/ adapters（全部 Node IO）/ core（agent 域目录：turn-machine 状态机 344 行、tool executor 拆 call-runner/hook-flow/permission-flow/approval-gate、handlers 约 95 个工具处理器、bash 只读判定拆约 20 个 policy 文件）；依赖方向 adapters→contracts→shared，core 只依赖 contracts。
- **hooks 全解**（成熟度最高）：7 事件 SessionStart/UserPromptSubmit/PreToolUse/PermissionRequest/PostToolUse/PostToolUseFailure/Stop，每事件输入类型独立（含 toolInput/toolResponse/riskLevel/sideEffectScope/stopHookActive，`contracts/src/hooks/index.ts:7-16`）；配置 `hooks.events.<Event>[{matcher, hooks:[{type, command, args, timeoutMs, async, shell, statusMessage}]}]`（`adapters/src/config/schema.ts:227-306`）+ user/project/internal 来源分级；**workspace trust**：project 来源必须先授信（协议方法 `workspace/hooks/trustGrant`），且授权决定**绝不缓存**——每 dispatch 前重验 admission（`core/src/hooks/workspace-hook-trust-*` 七文件）；超时缺省 60s，HookOutcome=success/blocked/failed/cancelled/timed_out；输出契约 additionalContext/decision(approve|block)/continue/systemMessage/suppressOutput/`hookSpecificOutput.permissionDecision(allow|ask|deny)/updatedInput/permissionUpdates`（`contracts/src/hooks/index.ts:154-176`）；生效点：PreToolUse deny 直接拦截（`call-runner.ts:233-254`）、PermissionRequest hook 可代答并动态追加权限规则（`hook-flow.ts:60-110`）、Stop hook 可强制续跑；每次执行发 HookRunStarted/Blocked 事件供 UI 实时展示。
- **skills 渐进加载**：上下文只注入「名称+描述+路径」清单（20k 字符预算，超了降级为仅名称，`core/src/context/sections/skills.ts`），全文由模型调用 Skill 工具按需加载（RainCode T4.4 已是 metadata 注入 + skill 工具按需展开——差距主要在 when_to_use 字段/描述限长/预算降级细节）；发现顺序 config 额外根→用户级→项目级逐级到 worktree 根→插件根，兼容 `.agents` 目录；插件技能 `plugin:skill` 限定名；**插件作用域扫描一律不跟随符号链接（含 Windows junction）**防文件逃逸（`scan.ts` 头部注释）。
- **plugins/marketplace 三层分发**：官方市场（内置播种 + CDN sha256 校验 zip）+ 个人来源（git/GitHub/URL/本地目录，兼容 `.claude-plugin/marketplace.json`）+ inline；协议面 15+ 方法（Install/Uninstall/Update/SetEnabled/Configure/Validate/RestoreBuiltin…）；桌面↔CLI 间带 sha256 指纹与大小上限的同步归档通道。
- **上下文组装**：`core/src/context/builder.ts` 显式 pipeline（各 section 带 injectionTarget=system/meta_user 与 cacheHint，超预算自动降级）；microcompact（`core/src/compact/microcompact.ts`，常量见 §1-3）。
- **rewind checkpoint**：不建 git shadow repo，从 Edit/Write 输出的 structuredPatch+originalFile 构造 checkpoint 工件（`runtime/helpers/rewind.ts`）——实现轻但覆盖面窄，RainCode 若有 git 域可用 stash 方案替代。
- **CLI esbuild 三件套**（`packages/cli/scripts/build.mjs`）：外置原生模块清单（koffi/playwright-core）、**metafile 校验重复依赖**（zod 双实例是真实踩坑）、alias 逐条精确声明；SEA 用 postject。
- **避坑**：双 pnpm workspace 导致 zod 物理双实例、schema 只能手工副本同步（`config/schema.ts:227` 注释明言）——**RainCode 不要在 apps 内再嵌套 workspace**；开源发行版测试几乎清零（全仓 4 个 .test.ts）其测试组织不可照抄；ui 包 32.7 万行是 UI 失控样本（靠 DESIGN.md token 体系约束）。

---

## 3. M5 采纳决策（T5.1~T5.7 ← 依据）

| 任务 | 内容 | 主要依据（报告内章节） |
| --- | --- | --- |
| T5.1 hooks 生命周期 v1 | PreToolUse/PostToolUse/UserPromptSubmit/Stop 四事件 + command 类型（timeoutMs 缺省 60s/async）+ JSON 输出契约 + project trust 授信（每 dispatch 重验）+ provenance 溯源 + log-only 审计对 + 协议 additive v1.12；PermissionRequest hook/动态权限规则/updatedInput 留 M6 | §1-2 + §2.3 hooks 全解（契约蓝本）+ §2.1 MiMo 分层与 provenance + §2.2 dsh 审计对与 fail-closed |
| T5.2 沙箱 enforcement 上报 | `Enforcement='full'|'partial'` 类型 + Executor 工厂自报（local=partial、docker/wsl=full、ssh 按远端探测）+ 工具结果 metadata **持续携带** + 模型可见拒绝标记 | §2.2 dsh 落地细节（Windows ACL partial 先例与本机同构） |
| T5.3 记忆与历史检索增强 | history FTS5 trigram（part 级）+ 相对分数地板 + 3x 过取样 + 全局记忆（global MEMORY.md 双层注入 + scope 列预留）+「检索结果与模型所见一致」不变量；**不做 embeddings** | §1-1 三仓定论 + §2.1 MiMo memory 经验 + §2.2 dsh 一致性不变量 |
| T5.4 compact 预剪枝 | microcompact 触发阈值/白名单/保留 N 条/最小节省 + dsh 三不变量（压力确认/回指 sourceEventSeqs/单过确定性收敛） | §1-3 两仓同题互证 |
| T5.5 config dump + 事件矩阵 | `raincode config dump` 静态归并+来源标签+`--default-only` 诊断；T4.3 管线扩展生成事件矩阵 `--check` 入 CI | §2.2 dump-config 机制 + 事件矩阵生成器成本确认（1~2 人日） |
| T5.6 MCP 工具目录化 | BM25 目录摘要 + `mcp_tool_search` 按需加载（上限 32）+ 超预算降级；治 MCP 工具多时的 token 膨胀 | §2.1 MiMo mcp-tool-search（20K 目录 + K1=1.2） |
| T5.7 工程收尾 + 遗留批次 C | CLI esbuild 前置编译（L-16：原生模块外置/metafile 校验/alias 精确声明三件套）+ pinned 包管理器校验入 CI + SSH base64 加固（T4.8 残留申报）+ L-14/L-01 复查 | §2.3 build.mjs 三件套 + §2.1 pinned 教训 |

---

## 4. 明确不做（本轮定论）与理由

| 方向 | 理由 |
| --- | --- |
| embeddings 向量检索 / 代码语义索引 | 三仓均无实现；FTS+BM25 路线（RainCode 已有 trigram 基础）零模型依赖零推理成本离线可用；有真实召回缺口再议 |
| 会话录制回放 lane | dsh 定论：先让回放格式=会话日志格式本身（RainCode JSONL 事件流已是）；M5 只做事件矩阵+导出基座，lane M6+ |
| IDE 插件（自写 VSCode 扩展） | 三仓印证正确姿势是 ACP 标准协议；M6+ 2 人日 spike 先行验证协议对接再决定 |
| 后台守护进程 | 无三仓共识形态；M6+ 采纳时以 jobs「完成通知注入原会话」+ MiMo cron 四件套（jitter/lock/sentinel）为蓝本 |
| 插件 marketplace | ZCode 8~12 人日且需先补安全前置（symlink/junction 逃逸防护、sha256 校验）；M6+ |
| per-file 覆盖率 100% / lefthook | dsh 哲学「100% or it doesn't merge」依赖豁免体系配套，RainCode 测试面未达该形态；维持 CI 六门禁现状；豁免 membership contract 作渐进入口候选 |
| 单二进制编译（MiMo 11 target / ZCode SEA） | Bun compile 不适用 pnpm+Node 生态；npm 分发 + esbuild bundle（T5.7）已覆盖需求 |
| session.delete 物理删除 | dsh 无参照（不可变 generation 设计反其道）；需自设计 tombstone+vacuum，M6+ 小项 |
| schedule 持久化提醒 / 跨产品子代理 | 超 PRD 范围（dsh 同判） |

---

## 5. M6+ 候选沉淀（新大陆项，排期前同样须先修订 01-PRD）

- **扩展生态**：PermissionRequest hook + permissionUpdates 动态权限规则（T5.1 留口，ZCode）；experimental 钩子区（chat.messages.transform/session.compacting 等，MiMo 分层）；插件 marketplace（ZCode 三层分发 + 五类组件枚举）；MCP OAuth 与进程树管控（ZCode，windows job object 兜底）。
- **上下文与记忆**：spill 溢出家族（dsh，约 2 人日，对接工具结果管线）；checkpoint 结构化模板 + 候选晋升 MEMORY.md（MiMo 10 节模板）；Dream/Distill 自动记忆固化（MiMo，7 天/30 天）；compaction-image-offload（dsh，桌面截图场景时再议）。
- **内核强化**：Goal/Stop 判定 judge（MiMo，防乐观早停低成本手段）；Max Mode best-of-N+评审（MiMo）；工具 FIFO 闸门 + fail-cascade（MiMo gate.ts，子代理并行编排强化前置）；last-match-wins 权限语义 + hardPermission 不可放宽层 + forced-ask 超时（MiMo）；session.delete tombstone+vacuum（自设计）；事件版本化+序号落库（MiMo sync，服务回放/远程 sync/插件三端）；持久化 shell 会话工具（dsh pwsh persistent，Windows 长驻终端对照）；rewind checkpoint 工件（ZCode，与 git stash 方案二选一）。
- **形态扩展**：ACP server 包装层（dsh/MiMo，3~5 人日，Zed 生态真实收益）；serve 长驻守护 + cron 调度四件套（MiMo）；jobs 后台任务 + 完成通知注入原会话（dsh，约 3 人日）；动态工作流子系统（ZCode compiler/engine + saved-workflows，subagent 之上的可编程编排层）。
- **工程**：架构治理升级（ZCode architecture-policy 声明式依赖方向 + `--changed` 增量 + maxFileLines + `architecture:context` 模块阅读包）；knip 未用导出检测（ZCode）；CI path-hash 分片（MiMo）；per-file 覆盖率渐进圈（dsh 豁免机制作入口）。

---

## 6. 避坑清单（后续 defensive-patterns 素材池，本轮只登记不展开）

1. 双 pnpm workspace → zod 物理双实例、schema 手工副本同步（ZCode `config/schema.ts:227`）——monorepo 禁止嵌套 workspace。
2. esbuild bundle 必须 metafile 校验重复依赖；alias 前缀改写漏声明要到打包产物才炸（ZCode `build.mjs:58,147-176`）。
3. 插件/技能扫描不跟随符号链接（含 Windows junction）防文件逃逸——marketplace 分发的前置安全件（ZCode `scan.ts`）。
4. process-wide mock 的测试套件必须独立进程跑，否则跨套件污染（MiMo CI test.yml）。
5. 构建期 pinned 包管理器校验：杂散二进制可致运行时挂死而 smoke 仍绿（MiMo `build.ts:22-29`）。
6. 权限兜底（allow-all）与遗留 ask 规则叠加会挂起 → forced-ask 必须 60s 超时自动拒绝并把反馈还给模型（MiMo `permission/index.ts:20-23`）。
7. nullable 列 `.get()` 返回 undefined vs SQL null 的语义差需代码规约明示（MiMo AGENTS.md）。
8. MCP SDK 子进程泄漏 → Windows job object 兜底（ZCode `windows-job-object.ts`，RainCode MCP stdio transport 可对照检查）。
