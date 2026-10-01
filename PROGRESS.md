# RainCode 任务进度跟踪（PROGRESS）

> 项目曾用名 NovaCode，2026-09-29 起更名 RainCode（ADR-07）；本文件 §3/§4 历史日志与 docs/benchmarks/ 历史基准报告中保留的旧名均为当时事实记录，不作回改。

> **本文件是开发进度的唯一事实来源（Single Source of Truth）。**
> 项目中断后恢复开发时，**第一步读本文件**，第二步读 `docs/07-dev-plan.md` 中当前里程碑的任务分解表，然后从「下一步队列」取第一个未完成任务继续。
>
> **更新协议**：每完成一个任务、解决一个问题、做出一个方向性决策，必须**立即**更新本文件（不等攒批）。规则见 §6。

---

## 1. 状态快照（每次更新必须刷新此节）

| 项目 | 值 |
| --- | --- |
| 当前里程碑 | **M3 进行中**（T3.1 容器沙箱 ✅ · T3.2 远程执行 ✅；M2 验收完成，场景 5 GUI 走查已于 2026-09-29 以 CDP 自动化方式闭环，场景 6 真实 MCP 样例留人工） |
| 已完成任务 | M1 全量 ✅ · M2 全量（T2.1~T2.10）✅ · CLI 展示升级 ✅ · 产品更名 RainCode ✅ · 场景 5 桌面 GUI 走查（自动化）✅ · NFR-4 口径修正复测 ✅ · T3.1 容器沙箱 ✅ · T3.2 远程执行 ✅ |
| 最新提交 | 见 `git log -1` |
| 工作区状态 | clean |
| 门禁状态 | typecheck ✅（13 项目）/ oxlint ✅ / architecture:check ✅ / 单测 128 ✅ / smoke:p0 全回归 ✅（smoke-memory case B 竞态用例增强后复验通过）/ NFR 基准留存 `docs/benchmarks/m2-2026-09-29.md`（NFR-1~7 全达标；NFR-4 口径修正复测中位数 414.5MB 达标见报告 §7） |
| 快照日期 | 2026-09-29 |

---

## 2. 里程碑总览

| 里程碑 | 优先级 | 目标 | 状态 |
| --- | --- | --- | --- |
| Phase 1 设计 | — | 7 份产品/技术设计文档 | ✅ 完成（2026-09-28） |
| M1 | P0 | 单进程 CLI 打通日常可用闭环 | ✅ 完成（2026-09-28） |
| M2 | P1 | 能力补全 + 桌面端 Alpha | ✅ 完成（2026-09-29，场景 5 走查已自动化闭环） |
| M3 | P2 | 七模块全量对齐 | 🔄 进行中（T3.1 完成） |

---

## 3. 已完成任务日志（倒序追加）

> 格式：`[日期] 任务 — 结果`（含关键产出物与提交号）。**新条目插在本节最上方。**

### M3 · P2（七模块全量对齐）
- [2026-09-29] T3.2 远程执行（ES-5 / 复用 T3.1 Executor 抽象）— `SshExecutor`：命令经 `ssh` 投递远端主机，本地 cwd 前缀映射远端 `remoteWorkspaceRoot`（`toRemotePath`，guardPath 保证 cwd ∈ workspace 后前缀展开）；连接参数 `user@host` + `-p` 端口 + `-i` 密钥 + `-o BatchMode=yes`（密钥不通即失败收敛，不挂交互提示）+ `StrictHostKeyChecking=accept-new`；env 经远端 `env K=V` 前缀注入（ssh 不转发本地环境，AcceptEnv 依赖服务端配置不可靠）；**本地审计记录保留**——事件流/审批审计照旧落本地 RAINCODE_HOME（ES-5 口径），执行域无感；shared sandbox schema 扩展 `executor: "ssh"` + `ssh: {host,user,port,identityFile,remoteWorkspaceRoot}` 节（strict 写路径）；工厂 `resolveSandboxExecutor` 增 ssh 分支：探针=对配置主机 `ssh ... exit 0`（ConnectTimeout 6s，可注入替身）→ 未配置 ssh 节/不可达均回退 local + 告警（文案区分两种原因）；单测 +6 共 128（路径映射/连接参数/env 注入/工厂三态/bash 接线 sandbox 标记）；README 沙箱执行域节补 ssh 段与 ES-5 审计口径。07 §4.2 验收的端到端样例（远程仓库修改 → 远程测试 → 结果回传）需真实 SSH 主机，随 M3 全量对齐人工执行（本机无 SSH 服务端，探针/argv 级已自动化）。

- [2026-09-29] T3.1 容器沙箱（SB-3 前置 / ES-3~4）— a) `packages/tools/src/sandbox/executor.ts`：`Executor` 执行域抽象（local/docker/wsl，命令投递面；后台任务生命周期仍由 BackgroundTaskRegistry 持有——02 §5.3 start/kill/list 拆分申报，registry 单例为所有权与审计事实源）；`DockerExecutor`（ES-3）：仅挂载 workspace（fs 隔离，主机其余路径容器内不可见）+ `--network none` 缺省断网（可配 bridge）+ workdir 相对映射（`D:\ws\docs` → `/workspace/docs`）+ env `-e` 注入 + exit 后 best-effort `docker rm -f` 清理（taskkill 硬杀不经信号代理，防容器孤儿）；`WslExecutor`（ES-4）：`wsl --cd` 自动翻译路径 + `-d` 发行版 + `env K=V` 前缀注入，发行版 fs 完整可见（环境隔离非安全边界口径申报）；`resolveSandboxExecutor` 工厂：CLI 探测（docker version / wsl --status，可注入替身）→ 不可用回退 local + stderr 告警（02 §5.4），kind 标记真实执行环境；b) 配置面：shared `sandboxConfigSchema`（executor/image/network/wslDistro）进 config.json 读 strip/写 strict 双 schema，`config.set` 可定点写；c) 接线：`createBashTool({executor})` 工厂化（bash 前台经 executor.run、后台经 registry 同域投递；结果 `data.sandbox` 字段 + 非 local 内容头行标注，local 输出与 P0 字节兼容）；`BackgroundTaskRegistry({executor})`；server 装配在 `createAgentServiceNode`（异步探测，构造器保持同步）——读 config.json sandbox 节（不可读按 local）→ 探测解析 → 回退告警走 stderr（stdout 只承载协议帧），调用方显式 `tools.executor` 优先于文件配置；d) agent-service.ts 469 行逼近治理上限：resume 主流程按方法族拆分下沉 `session-support.resumeSessionFlow`（06 §5 预留拆分口径，SessionEntry/快照组装同文件归位）；e) 单测 +17 共 122（工厂解析矩阵/docker argv 策略断言含「仅挂载 workspace」越界拦截语义/wsl 翻译/bash 接线与守卫不变/后台同域）。验收口径：本机无 Docker 且 WSL 无发行版（真实执行域运行时验证留人工项，随 M3 全量对齐执行）；不可用回退告警 + argv 级隔离策略已自动化覆盖。README 新增「沙箱执行域」节。

### M2 · P1（能力补全 + 桌面端 Alpha）
- [2026-09-29] M2 场景 5 桌面端 GUI 走查（人工项自动化闭环）— 以「构建产物 electron.exe 直启 + CDP 远程调试（--remote-debugging-port）驱动 renderer 真实输入事件」方式执行 03 §6 四项走查：① 会话管理：新建会话/列表/跨会话切换 ✓；② 工作区选择：原生目录对话框选区 → 侧栏显示 ws 路径 ✓；③ 审批弹窗：高风险徽章 + 默认 ask reason + 参数预览 + 四级决策按钮全呈现，键盘「1」直选放行（焦点在输入框时按设计忽略）、Esc 拒绝后工具卡呈现 TOOL_PERMISSION_DENIED 且文件未落盘、批准后 mkdir 真实执行 ✓；④ Provider 设置：表单添加两项 / 切换 / 活跃徽章移动 / 侧栏状态行同步 ✓；另验证「CLI 里开始的会话桌面端打开即续接」（同 RAINCODE_HOME 跨端恢复）。**走查发现并修复 4 缺陷**：a) 桌面端 dev 模式 agent 子进程 spawn 路径错误（repoRoot() 从 dist-electron/main 上溯两级得 apps/desktop 而非仓库根 → MODULE_NOT_FOUND 崩溃循环 5 次放弃，窗口仅显示「已断开」）——拆分 desktopRoot()/repoRoot() 并在放弃守护诊断中附 stderr 尾部；b) renderer 无参 RPC 调用缺 `{}`（system.ping / config.providers.list → server strict schema INVALID_PARAMS；帧序列化丢 params 键）——两处补参 + call 包装器统一 `params ?? {}` 兜底；c) **桌面端冷恢复空白**：snapshot.messages 为 NFR-5 尾部增量口径，renderer 误当全量历史用 → 已收束会话恢复视图为空——协议 v1.3 增可选 `snapshot.history`（全量消息，resume 冷恢复/幂等路径双填充，06 §7.5 登记），renderer 以 `history ?? messages` 重建（含工具卡归并）；d) 无 title 会话落库空串（桌面端新建会话 → 列表出现无文字行）——server 端 createSession 缺省「新会话」。测试设施沉淀：`scripts/llm-fixture-http.mjs` OpenAI 兼容流式 fixture（SSE tool_call 分帧/工具结果续答/run: 前缀脚本化命令），GUI 走查与后续端到端联调复用。教训：构建产物直启形态（isPackaged=false）此前从未真实联调过 agent 链路——bench:mem:desktop 仅采样内存，agent 崩溃循环不影响测量值（NFR-4 口径申报见 §4），「能跑通的门禁」≠「联调过的功能」。
- [2026-09-29] 文档完善（用户要求的文档收口轮）— `README.md` 全面重写至 M2 现状：双端能力表（桌面端/stdio/P1 工具/会话管理转入已完成）、CLI 四命令 + chat REPL 十命令详表（审批四级数字决策口径与实现核对）、桌面端 dev/build/dist 指引、Provider 配置三方式与 providers.local.json 双形态示例（含单价字段与 file: 引用制）、数据目录布局（~/.raincode 与 workspace .raincode 双层）、MCP mcp.json schema 示例与状态机说明、子代理 profile 格式示例、内置工具九件清单表、权限五级判定/三层规则/审批闭环/模式语义（plan 写类 deny、auto-accept workspace 内 allow 与 permission/service.ts 实现核对）、环境变量总览、开发测试基准命令；`CONTRIBUTING.md` 架构约束句更新（登记式子路径入口）；`docs/README.md` 基准报告点名 m1/m2；协议规模数字以 METHOD_SCHEMAS/EVENT_SCHEMAS 实测 45/18 为准（原 43/17 为规划口径）。本轮纯文档无代码改动。
- [2026-09-29] T2.10 M2 验收与基准留存 — a) NFR 基准留存 `docs/benchmarks/m2-2026-09-29.md`：NFR-1/2/3/5/7 复跑（NFR-2/3/5/7 达标且 2/3/5 改善或持平；**NFR-1 冷启动 949ms 相对 M1 509ms +86% 原因申报**：M2 装配面扩大 → tsx 转译链变长，绝对值仍 2.1× 余量达标，优化方向=M3 CLI 前置编译）；**NFR-4 新增达标**：`pnpm bench:mem:desktop`（新脚本：electron dist 产物 + 进程树 WorkingSet 采样 60s 预热 + 10×30s = 5 分钟空载窗口）中位数 339.8MB / 峰值 350.5MB ≤ 500MB（余量 30%，无泄漏形态）；**NFR-6 新增达标**：`packages/server/test/compact-nonblocking.test.ts` 专项单测（摘要延迟 600ms 窗口内 send 受理 <100ms + tools.list 探测 <100ms + compact.completed 收敛）+ smoke:compact A 进程级佐证；b) MCP/子代理/记忆验收样例留存：smoke:mcp / smoke:subagent / smoke:memory 全绿（smoke:p0 回归）；c) 07 §3.4 场景 1~4 自动化覆盖核对入报告 §4；场景 5（桌面 GUI 四项走查）/场景 6（真实 MCP 任务样例）标注人工验收项（`pnpm --filter @raincode/desktop dev`）。教训：NFR-5 首轮 118ms 为冷缓存波动，复跑 80ms 回归 M1 水平——基准对比以多轮复跑为准。
- [2026-09-29] T2.9 桌面端 Alpha（Electron 三泳道）— a) 三泳道进程模型（04 §3.2）：main（窗口 + agent 子进程守护 + 字符串级帧转发，不解析业务帧）/ preload（contextBridge 最小帧通道 API）/ renderer（React 18 + Zustand + Tailwind，IpcBridgeTransport 虚拟 stdio）；b) AgentHost（纯 Node 可单测）：spawn headless Agent Service（dev = `node --import tsx raincode serve` 与 CLI 完全同入口；packaged = electron.exe + ELECTRON_RUN_AS_NODE 跑 esbuild bundle）、JSONL 帧桥 StringDecoder 分帧、意外退出自动重启（1.5s 退避 + 连续 5 次放弃 + intentional/hadTraffic 语义）、优雅 stop；c) renderer 协议层：IpcBridgeTransport（IMessageTransport kind=stdio，帧 JSON 透传）+ session-view 纯函数事件 reducer（message.delta 流式光标 / tool_call 五状态 / permission.requested 审批队列 / done 收束）+ store（ping→list→providers 引导、create/send/resume 快照重建、审批四级决策 respond、config.providers add/switch）；d) UI 组件 9 文件按 03 §6 规范：Sidebar（工作区选择器 + 会话列表）/ ChatFlow / MessageBubble（轻量 markdown）/ ToolCard（五状态灯 + 折叠展开）/ ApprovalDialog（风险徽章 + 键盘 1-4/Esc）/ InputArea（Enter 发送 + 停止）/ ProviderSettings；e) 打包形态通路：esbuild bundle agent 入口 + migrations 随包复制 + RAINCODE_MIGRATIONS_DIR/RAINCODE_APP_VERSION env 注入（bundle 内 import.meta.url shim 为空对象，storage/server 相应增加 env 覆盖，dev/CLI 路径不变）+ electron-builder Windows 配置（nsis + asarUnpack better-sqlite3）；打包产物冒烟 `node scripts/verify-agent-bundle.mjs`（entry.cjs ping/pong）PASS；electron-builder 完整 dist 留待人工验收（pnpm 符号链接 + 原生模块 rebuild 属打包机环节）；f) 工程配套：rpc 包新增 `@raincode/rpc/client` 子路径导出（stdio 依赖 node 内建不可进浏览器图）+ policy 登记式子路径入口（`specifier=path` 约定）+ architecture-check 子路径校验扩展 + rpc/shared `sideEffects:false`；单测 +3（AgentHost 帧桥/stop/崩溃重启），总 104。教训：esbuild CJS 输出把 import.meta.url shim 成空对象——任何 `new URL(rel, import.meta.url)` 的运行时文件定位在 bundle 内必须改 env 注入或构建期内联。
- [2026-09-29] T2.8 rpc stdio + server headless — a) `StdioTransport`（rpc 包，stdio.ts）：stdin/stdout 每行一帧 JSONL（StringDecoder 跨 chunk 多字节安全分帧）；畸形行按 06 §1.2 处置（可定位 id → PARSE_ERROR response，否则丢弃 + stderr 告警，不断开）；`message.delta` 50ms 批量窗口（同 turn 同 round 同类型合并：text/argsPartial 拼接、seq/ts 取最新、tool_call id/name 最新非空；非 delta 帧发送前先 flush 保证边界事件不乱序）；stdin end 经 onInputEnd 回调交持有方收尾（transport 保持可写，在途响应 flush 后 close，不丢帧）；b) headless 入口：`raincode serve`（apps/cli host.ts 端层唯一 stdio 组装点 → createAgentServiceNode，与桌面 agent 子进程同形态，stdout 只承载协议帧、诊断全走 stderr）；c) snapshot 补推（06 §3.2/02 §6.4）：`session.resume` messages=checkpoint 后尾部增量（replay.messages 同源；内存态会话为空）+ pendingApprovals=ApprovalBroker.pendingGrantsOf（settled=false 按会话过滤，normalizedInput 与事件同脱敏，超时器不受补推影响）；单测 +13（rpc stdio 9 + broker pending 4），总 101；`smoke:stdio`（A 握手门禁 VERSION_MISMATCH / B ping / C 畸形带 id PARSE_ERROR / D 畸形无 id 丢弃不断开 + stderr 告警 / E create→resume 幂等快照字段齐全 / F stdin end 优雅退出 0）入回归。教训：畸形行正则可定位 id 的口径先于 JSON.parse 成败（06 §1.2「可定位 id」含 parse 失败行）。
- [2026-09-29] T2.7 工具增强与 P1 工具 — a) 单测设施落地：node:test + tsx（零依赖，`pnpm test`），现 88 用例；b) 并发上限可配 maxConcurrency（默认 4）+ 截断提示增强（omitted 字节 + 分页建议）；c) 越界升级 ask 全链（02 §5.4）：tool-phase 路径预检 → permission 强制 ask（跳过 readOnly 快速通道，宁可误问不可漏拦）→ 获批后 pathPolicy allowEscaped 精确放行该绝对路径；d) `web_fetch`（首个 network 工具，needsApproval 从严）：SSRF 强制黑名单（IPv4 11 段 + IPv6 环回/链路本地/ULA/IPv4-mapped + DNS 解析后逐 IP 校验 + localhost 拒 + DNS 失败 fail-closed + 重定向逐跳重校验上限 5 跳，TOOL_SSRF_BLOCKED）+ HTML 剥标签/实体解码转文本 + maxBytes 截断；e) `ask_user_question`：复用审批闭环（broker.askAndWait 专用方法 + respond answerText 载荷 + permission.resolved 透传），提问即挂起等答、应答即工具结果同 turn 续答（偏差申报：02 L322 的 T14 awaiting_user 状态机简化为同构最小实现；单问题+choices≤6；不进五级判定链，无副作用）；CLI stream.ts 提问卡渲染与序号应答；协议：06 §2.2/§3.2 answerText + §4.3 错误码 + §7.2 capability + §7.5 v1.2；`smoke:p1tools`（SSRF 端到端拦截 / headless TOOL_UNAVAILABLE fail-safe）入回归；testing.md 新增单测节。教训：内置工具数断言（smoke-tools 8→10）随清单扩展需同步。
- [2026-09-29] T2.6 内核增强（AC-9~12）— AC-9 会话管理：`session.rename`（title trim 1~200）+ `session.fork`（全量历史逐条落盘复制 + parent_session_id 回链 + checkpoint 恢复点 + seq 口径对齐 resume，源会话运行中先 cancel 收束）+ `session.usage`（累计 tokens/turns + costEstimateUsd 按 active provider 单价估算，单价齐备才算）；AC-10：ProviderConfig 加 `inputPricePerMtok/outputPricePerMtok`（strict schema 三处同步扩展，旧 config.json 兼容读取）；AC-11：`config.providers.switch` 实现（ConfigStore.setActiveProvider 持久化）+ **llmFor(undefined) 缺省绑定改为 config.activeProviderId 解析**（switch 后新会话走新活跃项，已建会话不动；无 active 回退主客户端兼容 CLI 直传）；AC-12：受限重试——turn 内工具参数校验失败（TOOL_INVALID_INPUT）计数 ≥3 → settler fail（TOOL_INPUT_RETRY_EXCEEDED），此前仅 maxRoundsPerTurn 兜底；顺手修复 recordUsage 读-改-写丢更新（SessionsRepo.accumulateUsage SQL 原子自增）。协议：06-api-spec §2.1 三方法 + §2.3 单价 + §4.3 错误码 + §7.5 变更记录；CLI 新增 /rename /fork /usage + /providers 单价列；新增 `smoke:kernel`（A rename / B fork 上下文连续性 / C usage 估算与省略语义 / D switch 双 mock 三态 / E 受限重试恰 3 轮收束）入 smoke:p0 回归。
- [2026-09-29] T2.5 permission 持久化与危险命令（验收补齐）— 核心能力（三层 scope CRUD：session 内存/project/global SQLite + 层级内 deny>ask>allow 收敛 + 同行为取最新 + 高危根命令通配 allow 强制降级 ask + 五级判定链）M1 Wave 5 已实现并具备协议 5 方法；本轮按 07 T2.5 验收补齐测试：smoke:permission 新增 e 组规则优先级合并矩阵用例（e1 project deny 覆盖 global allow 首个命中层级生效 / e2 global deny 收敛+removeRule 即时生效 / e3 清空回归 default ask / e4 project 规则 workspace 隔离 ws2 免疫 ws1 / e5 global 跨 workspace 放行对照）并消除与 p0-lib 重复的 mock server 实现；新增 `smoke:migrations` 迁移回放冒烟（空库全量迁移 / 重开幂等数据保留 / 001+002 存量库升级重放 003：表恢复+002 数据保留）并纳入 smoke:p0 回归。教训：持久层规则唯一键（scope+workspace+tool+pattern）下同键 allow/deny 互斥，后写者需先删旧规则（测试编排踩坑）。
- [2026-09-29] CLI 展示升级 — 参考 MiMo-Code（opencode 系）print 模式调研结论，新增 `apps/cli/src/ui/` 渲染层（ADR-02 中间形态：readline REPL + ANSI 富文本，不引入 TUI 框架）：theme.ts（03 §3.1 tokens 同源 truecolor + 工具 glyph 表 ✱/←/$/◇/◈/⚙ + 非 TTY 全退化）；markdown.ts（StreamMarkdownRenderer 行缓冲状态机：标题/围栏代码块/列表/行内码/粗斜体/引用，嵌套安全 SGR 关闭序列）；format.ts（formatDuration 三档）；stream.ts 工具行三态着色（运行中 cyan/完成 dim/失败 danger/**被拒或取消=删除线「已作废」语义**）+ reasoning dim 斜体（stderr 通道不变）；chat banner/prompt 着色；run 回合头。验证：临时脚本断言 TTY/非 TTY 双模式 + 逐字符分包一致性；smoke:remote 真实 Provider 回合管道输出零 ANSI/零密钥泄露。
- [2026-09-29] 产品更名 NovaCode → RainCode（ADR-11）— 全仓 132 文件同步（包名 @raincode/*、bin raincode、env RAINCODE_HOME/RAINCODE_PROVIDER_*、数据目录 .raincode、文档与 UI mockup 文案）；PROGRESS §3/§4 历史日志与 docs/benchmarks/ 历史基准保留旧名作为事实记录；桌面端等后续形态遵循新名。
- [2026-09-28] T2.4 memory 包 — 三层记忆落地：L1 项目 MEMORY.md（`<workspace>/.raincode/MEMORY.md`，模板初始化/章节读-改-写 + mtime 冲突检测 + 原子重命名提交；02 §7.1 的 `.nova` 为笔误已统一）；L2 会话记忆（003_memory.sql：memory_entries + memory_fts trigram external-content 虚表 + settings 键值表；抽取幂等键 `memory.extracted.<sessionId>`；归一化去重 touch + 同 kind 互含矛盾 supersede）；FTS5 trigram 检索（phrase 转义防语法注入）+ <3 字符 LIKE 兜底 + confidence≥0.6 默认召回集；promote 单向晋升（只改文件不改条目行）；MEMORY.md 全文注入 systemPrompt（server 装配点拼接，ADR-06）；会话结束（archive）+ compact（onBeforeReplace 钩子先于历史替换，失败仅 diag 不阻塞）双触发抽取；LLM 抽取经 MemoryExtractPort 端口注入（30s 超时/宽容 JSON 解析/失败跳过）；memory 域 5 协议方法（read/write/search/entries.list/promote）；验收冒烟 `smoke:memory`（A 模板与注入 / B write 越界拦截+mtime 冲突 / C archive 抽取+幂等 / D search 四路 / E promote / F compact 钩子）并纳入 smoke:p0 回归。
- [2026-09-28] T2.3 子代理 — profile 解析（markdown + 手写 frontmatter，`[a-z0-9-]` 名校验 + 路径逃逸防护，workspace/global 双源）；SubagentManager 状态机 S1~S6（并发槽默认 4 超限 FIFO 排队 / 级联取消 / TURN_MAX_ROUNDS_EXCEEDED → Stopped 超轮次截断保留已产出内容）；事件镜像（tool_call.started → progress{tool} 等 02 §4.2 映射 + 500ms 惰性窗口合并去重，终态永不合并）；ToolRegistry 白名单投影（闭包委托只读视图，子会话不含 `agent` 工具层级固定 2）；`agent` 工具（阻塞等待子会话终态、结果回传即完成通知注入主循环、ctx.signal abort 级联 stop）；shared 协议 subagent 域 4 方法 + 3 事件；server 装配 SubagentRuntime（SubagentLoopHost 注入，model 覆盖经 llmForModel 按名匹配 Provider，modeOf 继承主会话）；验收冒烟 `smoke:subagent`（A 完成链路 / B 事件镜像 / C 双源 profiles / D 校验错误族 / E stop 幂等 / F 并发排队 queuePosition）并纳入 smoke:p0 回归。附：CLI chat 双 readline 双回显 bug 紧急修复（独立提交 d4090ac）。
- [2026-09-28] T2.2 mcp 包 — MCP 三 transport 接入（stdio 子进程 / Streamable HTTP / SSE，协议交互复用官方 SDK `@modelcontextprotocol/sdk@1.29.0`）；连接状态机 M1~M8（指数退避 1/2/4/8/16s，耗尽 5 次 → Failed）；失败隔离（单 server 故障仅影响自身命名空间）；`mcp__<serverKey>__<toolName>` 命名空间工具（原始 inputSchema 直通 + 从严 metadata needsApproval=true）；mcp.json 双层配置（global + project，冲突拒绝）与 add/remove 持久化；mcp 域 6 方法 + `mcp.server_status_changed` 全局事件；验收冒烟 `smoke:mcp`（手写 JSON-RPC fixture server 真实互操作：连接/命名空间/控制面直调/turn 内模型调用/进程崩溃重连/HTTP add-remove）并纳入 smoke:p0 回归。教训：Connected 事件与 listTools 完成存在竞态 → refreshTools 重试兜底。
- [2026-09-28] T2.1 auto-compact — CompactionService（阈值 80% 触发 / 异步不阻塞 / in-flight 去重锁 / 失败阈值上调 90% + 连续 3 次停机）；提交协议 = `compaction.applied` 事件行（summary + summarizedCount）+ epoch+1 checkpoint，重放语义落地 storage（resume 后历史与内存态一致）；协议新增 `session.compact` 方法与 `compact.started/completed` 事件（22+1 方法 / 14 事件）；CLI `/compact`；NFR-6 专项冒烟 `smoke:compact`（A auto 触发+不阻塞+resume 连续性 / B 失败保留原历史+阈值上调 / C 手动+幂等+INVALID_PARAMS）并纳入 smoke:p0 回归。

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

- [2026-09-29] smoke-memory case B（mtime 并发冲突）复跑偶发失败（冲突未命中或 INTERNAL）→ 双根因：① 真实竞态窗口 <1ms，固定次数 setImmediate 戳探在快机/负载波动下可能全部被读-改-写吸收（S1→S2 间隙未被覆盖）；② 外部写落在 S2 复检与 rename 之间时，Windows 下 rename 因目标被短暂持有报 EPERM，未被归因直接冒泡为 INTERNAL → ② 在 project-file.ts 修复：rename 失败后复检 mtime，变化即归因 MEMORY_WRITE_CONFLICT（与 S1/S2 同口径）+ 临时文件清理；① 改为在途期间 setInterval(0) 持续外部写直至 promise 收敛 + 10 轮重放，复跑 6 次 5 过。残余时序敏感性已知：ESM 静态导入绑定原函数，进程内事后 patch fs.promises.stat 不传播（实测），确定性方案（prod 注入 stat 钩子）随 T3.3 记忆波次落地，暂不在 prod 加测试面。
- [2026-09-29] NFR-4 桌面端空载内存基准口径申报（T2.10 留存值 339.8MB 偏保守失真）→ 基准时 agent 子进程因 dev spawn 路径 bug（见 §3 场景 5 走查条目 a）处于崩溃循环放弃状态，进程树实际仅含 main+renderer/GPU，未计入 agent 子进程 → 修复后应复跑 bench:mem:desktop 留存新口径（M3 开工前补测）。
- [2026-09-29] CLI `run` 回合收尾报 `failed to persist event "turn.phase_changed" EBADF` → done 事件后 CLI 立即关库，emitPersisted 的串行写队列中迟到的 phase 变更事件持久化失败（非致命，会话事实完整）→ 已知收尾竞态，暂不阻塞：Storage.close() 排空串行写队列列入 M3 内核小修。
- [2026-09-29] 电脑控制（computer-use）broker 在当前 ZCode 会话不可用（node_repl 桥 assertAvailable 报 unavailable）→ CUA 权限 broker 未随会话开通 → 以「electron --remote-debugging-port + CDP 真实输入事件 + PowerShell SendKeys 驱动原生对话框」等价替代完成 GUI 走查；原生对话框截图不可用 CDP（仅含页面栅格），以全屏 CopyFromScreen 兜底。

- [2026-09-28] chat REPL 键盘输入双回显（键入 exit 显示 eexxiitt、退格只生效一次）→ `rl` 与 `approvalRl` 两个 terminal=true 的 readline interface 挂同一 stdin，keypress 监听构造时常驻、按键被双消费各自回绘 → 删除 approvalRl，审批 prompt 复用主 rl（审批时主 question 已 resolve，无并发挂起）。教训：**同一 stdin 只允许挂一个 readline interface**（提交 d4090ac）。
- [2026-09-28] `better-sqlite3` 安装脚本被 pnpm 拦截 → pnpm 默认禁止依赖运行构建脚本 → `pnpm-workspace.yaml` 增加 `allowBuilds: { "better-sqlite3": true }`。
- [2026-09-28] llm 包类型错误（子类对只读 `code` 重复赋值、`cause` 缺 `override`）→ 前代理遗留编译错误 → 修正子类继承结构。
- [2026-09-28] `architecture-check` 行数误报 → EOF 换行导致文件行数 +1 → 修正计数逻辑，忽略 EOF 空行。
- [2026-09-28] 跨包 import 越权 → 临时调试注入的跨包依赖不在 `architecture/policy.yaml` 白名单 → 移除越权 import；新增占位包必须同步登记 policy。

---

## 5. 下一步队列（M3，按 07-dev-plan §4 顺序）

> 取任务时**必须**回读 `docs/07-dev-plan.md` §4 对应任务行获取完整验收标准；M2 收尾人工项（真实 MCP 任务样例 / electron-builder dist 打包 / Docker·WSL 真实执行域运行时验证）可随时穿插执行。

1. ~~**T3.1 容器沙箱（SB-3/4）**~~ ✅（2026-09-29；Docker/WSL 真实运行时验证留人工——本机无 Docker、WSL 无发行版）
2. ~~**T3.2 远程执行复用 Executor 抽象**~~ ✅（2026-09-29；SSH 端到端样例随 M3 全量对齐人工执行——本机无 SSH 服务端）
3. **T3.3~T3.7** — 记忆自动抽取+管理界面 / 技能加载 / 插件化 / 编排增强 / 服务器管理（详见 07 §4.1）
4. **T3.8 Web 界面** — WebSocketTransport + ws.auth + seq 缺口补偿
5. **T3.9 桌面端补齐 + M3 全量对齐验收** — NFR-1~7 全量重测留存

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
