# RainCode 测试说明

> 本文档描述 RainCode 的测试体系：单元测试、冒烟测试、NFR 基准、工程门禁。测试脚本变更时**必须同步更新本文档**（见 CONTRIBUTING 文档更新协议）。

## 1. 测试策略总览

RainCode 采用「**单元 + 冒烟 + 基准 + 门禁**」四层验证体系，全部可从仓库根目录一条命令运行：

| 层 | 目的 | 运行方式 | 密钥/外呼 |
| --- | --- | --- | --- |
| 单元（unit） | 包内模块级正确性（node:test，零外呼） | `pnpm test` | ✅ 全程本机 mock/临时目录 |
| 冒烟（smoke） | 功能链路端到端正确性 | `pnpm smoke:*` | ✅ 全程本机回环 mock，无外呼、无真实密钥 |
| 基准（bench） | NFR 性能指标验收与防劣化 | `pnpm bench:*` | ✅ 同上（LLM 为本机 mock SSE 服务器） |
| 门禁（gate） | 代码质量与架构治理 | `pnpm typecheck` / `lint` / `architecture:check` | — |

另有一个**可选真实冒烟** `pnpm smoke:remote`，走完整 CLI 路径调用真实 Provider（需要 `config/test-provider.local.json`，已被 .gitignore 隔离）。该脚本对全部 stdout/stderr 断言无密钥泄露；网络不通时如实报告 FAILED，不影响本地冒烟结论。

## 2. 单元测试

node:test 原生测试运行器 + tsx 加载器（根 package.json `pnpm test`，glob 收集 `packages/*/test/**/*.test.ts` 与 `apps/*/test/**/*.test.ts`），各包 tsconfig include 已含 test 目录。

| 命令 | 覆盖范围 |
| --- | --- |
| `pnpm test` | tools：truncate（字节预算头 70/尾 30 + 截断提示）、path-guard（workspace 越界）、executor-concurrency（只读并行上限/写串行）、ssrf（黑名单网段/localhost/scheme/重定向跳板/DNS mock）、web-fetch（HTML→文本转换/JSON 原文/非 2xx/maxBytes 截断/重定向跟随与拦截）、ask-user（通道应答/TOOL_UNAVAILABLE/TOOL_PERMISSION_DENIED）；permission：path-escape（越界强制 ask + 审批闭环）、ask-user-broker（respond answerText ↔ askAndWait/resolved 事件透出）、broker-pending（pendingGrantsOf 会话过滤/脱敏/收敛消失/可选字段透传）；rpc：stdio（跨 chunk 分帧/JSONL 出站/畸形行 PARSE_ERROR 与丢弃不断开/delta 窗口合并与边界 flush/跨 turn 不合并/tool_call argsPartial 拼接/close flush/onInputEnd 半开语义）；desktop：agent-host（stdout 帧行转发/sendLine/优雅 stop intentional/崩溃自动重启）；agent-core：tool-phase-path-escape（越界预检→放行钩子全链） |

**预期输出**：`# pass N`（当前 104）且 `# fail 0`，退出码 0。提交前与门禁一起全绿。

## 3. 冒烟测试

所有冒烟脚本共享同一模式：`node:http` 本机 mock OpenAI SSE 服务器（脚本化多轮回复，tool_call delta 分片下发以覆盖 llm 侧累积）→ 临时 `RAINCODE_HOME` → 进程内创建 Agent Service（in-memory RPC 绑定）→ RPC 驱动 → 断言落盘数据与事件流。

| 命令 | 脚本 | 覆盖范围 |
| --- | --- | --- |
| `pnpm smoke:e2e` | [scripts/smoke-e2e.mts](../scripts/smoke-e2e.mts) | 端到端主链路：`session.send` → llm 流式回复（SSE delta 累积 + usage + `[DONE]`）→ 事件流/JSONL 落盘 → 会话列表与恢复 |
| `pnpm smoke:tools` | [scripts/smoke-tools.mts](../scripts/smoke-tools.mts) | 工具调用系统：用例 A（allow）read+write 多轮工具调用、`tool_call.started/completed` 事件、结果文件落盘、最终回复无工具泄露；用例 B（deny）`needsApproval` 工具被 always-deny 审批拒绝 → 模型收到 `TOOL_PERMISSION_DENIED` 并继续收束 |
| `pnpm smoke:permission` | [scripts/smoke-permission.mts](../scripts/smoke-permission.mts) | 权限判定链脚本化场景：五级判定优先级、bash argv 求值与只读白名单、grantId 审批闭环（allow once/always、deny）、规则持久化（global 重启保留）、高危根命令通配 allow 降级 ask；**T2.5 合并矩阵 e 组**：project deny 覆盖 global allow（首个命中层级）、global deny 收敛 + removeRule 即时生效、清空回归 default ask、project 规则 workspace 隔离（ws2 免疫 ws1）、global 跨 workspace 放行对照 |
| `pnpm smoke:p0` | [scripts/smoke-p0.mts](../scripts/smoke-p0.mts) | **M1 P0 控制面全集**（并回归其余九个 smoke）：① 协议注册表对照（22 方法 / 12 事件）② Provider 密钥引用制（明文 key → 密钥文件 + apiKeyRef，响应零明文；移除活跃 Provider 报错）③ `session.steer` 运行中注入 ④ `session.setMode` 模式级 deny/恢复 ⑤ `session.archive` 归档语义与 events.jsonl 保留 ⑥ 明文密钥不落入任何响应/落盘/日志 |
| `pnpm smoke:compact` | [scripts/smoke-compact.mts](../scripts/smoke-compact.mts) | **auto-compact（M2 T2.1 / NFR-6 专项）**：用例 A auto 触发 + 压缩窗口内 send 不阻塞 + `compaction.applied`/epoch+1 提交 + 窗口期消息合并 + resume 连续性；用例 B 空摘要失败 → 保留原历史 + 阈值临时上调 90%；用例 C 手动 compact 低于阈值可用 + in-flight 幂等复用 ticket + 空历史 INVALID_PARAMS |
| `pnpm smoke:mcp` | [scripts/smoke-mcp.mts](../scripts/smoke-mcp.mts) | **MCP 接入（M2 T2.2）**：与手写 JSON-RPC fixture server（[mcp-fixture-stdio.mjs](../scripts/mcp-fixture-stdio.mjs) / [mcp-fixture-http.mjs](../scripts/mcp-fixture-http.mjs)，node 直跑）真实互操作——连接状态机（Connected/Failed 失败隔离）、命名空间工具注册、控制面直调（ToolExecutor 链路）、turn 内模型调用（权限链）、进程崩溃 → M4 重连 → 工具恢复、HTTP transport add/call/remove + mcp.json 持久化 |
| `pnpm smoke:subagent` | [scripts/smoke-subagent.mts](../scripts/smoke-subagent.mts) | **子代理（M2 T2.3）**：mock LLM 编排「主 → 子 → 主」请求序列——用例 A 完成链路（`agent` 工具派发 → 子会话独立 systemPrompt 收束 → 完成通知经 tool_call.completed 回传 → subagent.list 含 usage/turnsUsed）；用例 B 事件镜像（subagent.spawned → progress started → progress done → subagent.completed 顺序与字段）；用例 C profiles.list（workspace/global 双源 + frontmatter 投影 + 坏文件跳过）；用例 D 校验错误族（SUBAGENT_PROFILE_NOT_FOUND / SUBAGENT_PROFILE_INVALID / INVALID_PARAMS / SESSION_NOT_FOUND / SUBAGENT_NOT_FOUND）；用例 E stop 终态幂等（stopped:false）；用例 F 并发排队（并发 4 下第 5 个 Pending + queuePosition=1 + FIFO 补位全数 Completed） |
| `pnpm smoke:memory` | [scripts/smoke-memory.mts](../scripts/smoke-memory.mts) | **项目记忆（M2 T2.4）**：用例 A 模板与注入（memory.read exists:false → 模板骨架 + MEMORY.md 全文进 system 提示）；用例 B write（Agent 章节落盘 / 用户章节越界拦截 / mtime 并发冲突 MEMORY_WRITE_CONFLICT）；用例 C archive 抽取（session-end 落盘 + settings 幂等键二次抽取返回空）；用例 D search（≥3 字 FTS trigram / <3 字 LIKE 兜底 / kind 过滤 / confidence<0.6 不入召回但 entries.list 可见 / 无结果空数组）；用例 E promote（合入指定章节 + MEMORY_ENTRY_NOT_FOUND）；用例 F compact 抽取钩子（onBeforeReplace 先于历史替换，source=compact 落盘） |
| `pnpm smoke:migrations` | [scripts/smoke-migrations.mts](../scripts/smoke-migrations.mts) | **迁移回放（M2 T2.5 验收）**：t1 空库全量迁移 001→003（settings/permission_rules/memory_entries 功能探针）；t2 重开幂等（版本不重复执行、数据保留）；t3 存量库升级路径（模拟 001+002 时代库：DROP 003 表 + 删版本行 → 重开重放 003：表恢复、002 数据行原样保留、重建表可写入） |
| `pnpm smoke:p1tools` | [scripts/smoke-p1tools.mts](../scripts/smoke-p1tools.mts) | **P1 工具（T2.7 二阶段）**：用例 A web_fetch SSRF 端到端——turn 内 mock 下发 `web_fetch(http://127.0.0.1:<mock 端口>)` → SSRF 守卫拦截回环地址，`tool_call.completed` isError 且 `TOOL_SSRF_BLOCKED` 注明原因，模型收到错误后 turn 继续收束（正向抓取路径由单测覆盖，冒烟不断言正向网络）；用例 B ask_user_question headless fail-safe——无交互通道 → `TOOL_UNAVAILABLE` 收敛 + 两工具经 tool.tools.list builtin 可见（web_fetch metadata network/needsApproval） |
| `pnpm smoke:stdio` | [scripts/smoke-stdio.mts](../scripts/smoke-stdio.mts) | **stdio 绑定 + headless（T2.8）**：子进程 spawn `raincode serve`（无 Provider），断言 A 握手门禁（ping 前 session.list → VERSION_MISMATCH）；B system.ping（protocolVersion/capabilities）；C 畸形行带 id → PARSE_ERROR response 且不断开；D 畸形行无 id → 丢弃 + stderr 告警、连接继续；E session.create → session.resume 幂等快照（lastSeq/phase/model/contextUsage/messages/pendingApprovals 字段齐全）；F stdin end → 进程优雅退出 code 0（帧可人工 cat 重放的等价路径，ADR-08） |
| `node scripts/verify-agent-bundle.mjs` | [scripts/verify-agent-bundle.mjs](../scripts/verify-agent-bundle.mjs) | **桌面端打包产物（T2.9）**：esbuild bundle 的 agent 入口（apps/desktop/dist-electron/agent/entry.cjs，需先 `pnpm --filter @raincode/desktop build:agent`）以 node 直跑，stdin 注入 system.ping → 断言 pong response（验证 bundle + 随包 migrations env 注入通路；electron-builder 完整 dist 打包属人工验收环节） |

**运行全部**：

```bash
pnpm smoke:p0   # 内部已并复 smoke:e2e / smoke:tools / smoke:permission / smoke:compact / smoke:mcp / smoke:subagent / smoke:memory / smoke:migrations / smoke:kernel / smoke:p1tools
```

**预期输出**：各脚本末尾打印 `SMOKE OK`，退出码 0。

## 4. NFR 基准测试

实现入口 [scripts/bench.mts](../scripts/bench.mts)（共享逻辑 [scripts/bench-lib.mts](../scripts/bench-lib.mts)），口径对照 01-PRD §6.1 性能指标基线表。

| 命令 | 指标 | M1 实测（详见 [benchmarks/m1-2026-09-28.md](benchmarks/m1-2026-09-28.md)） |
| --- | --- | --- |
| `pnpm bench:start` | NFR-1 CLI 冷启动 ≤ 2s（20 次中位数） | ✅ 509.2ms |
| `pnpm bench:send` | NFR-2 输入→模型请求本地开销 ≤ 300ms（P95，n=100） | ✅ 16.7ms |
| `pnpm bench:render` | NFR-3 工具结果本地渲染延迟 ≤ 100ms（P95，n=100） | ✅ 0.0ms |
| `pnpm bench:resume` | NFR-5 万条消息会话恢复 ≤ 1s（10 次中位数） | ✅ 93.3ms |
| `pnpm bench:crash` | NFR-7 崩溃恢复专项（`taskkill /F /T` 强杀 → 四项断言） | ✅ PASS |
| `pnpm bench:all` | 全部五项 | ✅ |

NFR-4（桌面端空载内存）、NFR-6（压缩异步不阻塞）属 M2 验收范围，M2 波次补齐。

**里程碑验收时**必须在 `docs/benchmarks/` 新增留存报告（含环境说明与复现命令，格式参照 m1-2026-09-28.md）。

## 5. 工程门禁

| 命令 | 工具 | 检查内容 |
| --- | --- | --- |
| `pnpm test` | node:test + tsx（§2 单元测试） | 包内模块级正确性（tools/permission/agent-core），与门禁同绿提交 |
| `pnpm typecheck` | tsc --noEmit strict（逐 workspace 项目） | 全仓类型正确性 |
| `pnpm lint` | oxlint | Lint 规则（当前基线：0 错误，6 条既有 warning，其中 rpc 层 2 条为刻意快照不修） |
| `pnpm architecture:check` | [scripts/architecture-check.mjs](../scripts/architecture-check.mjs) | 五项架构策略（依据 [architecture/policy.yaml](../architecture/policy.yaml)）：跨包依赖白名单、Tarjan 循环依赖、单文件 ≤ 500 行、深导入禁令（跨包只能从 `index.ts` 导入）、managedOnly |

**提交前必须全绿**。`architecture:check` 含 gate 自测（注入越权 import 可被拦截）。

## 6. 已知边界与注意事项

- 冒烟/基准全部使用**临时 RAINCODE_HOME** 与临时工作区，不污染真实用户数据；测试数据即用即弃。
- `smoke:remote` 读取的 `config/*.local.json` 含真实密钥，已被 `.gitignore` 隔离（`config/*.local.json` 模式）——**任何测试脚本不得将密钥写入被跟踪文件或输出**，这是架构级安全约束（04-architecture §5.3）。
- NFR-7 崩溃基准默认单轮专项口径；全量验收口径（强杀 ×20）可用 `--times 20` 扩展。
- Windows 专用实现（如进程树终止 `taskkill /F /T`）在非 Windows 平台的行为未经验证。

## 7. 新增测试的约定

1. 新功能合入前补对应单测（`packages/<pkg>/test/*.test.ts`，node:test 风格参照既有文件）与冒烟用例：功能级断言放既有脚本对应用例组，新领域新建 `scripts/smoke-<domain>.mts` 并在 `package.json` 注册 `smoke:<domain>`，同时更新本表。
2. 头部注释必须说明：链路、用例清单、隔离方式（参照现有脚本格式）。
3. 性能相关改动合入后复跑 `pnpm bench:all`，与上一里程碑基准对比不劣化（±10% 内）。
4. 测试文档（本文档）与测试脚本同 PR 变更。
