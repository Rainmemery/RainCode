# RainCode 事件生产者/消费者矩阵（生成式）

> **本文件由 `scripts/gen-event-matrix.mts` 生成（T5.5 可观测性，扩展 T4.3 gen 管线），不要手改。**
> 手改会被 `pnpm event-matrix:check`（CI 门禁 6）逐字节比对拒绝；事件面演进后运行 `pnpm event-matrix:gen` 再生成并随代码提交。
>
> **职责边界**：本生成物 = 源码扫描（packages/<pkg>/src + apps/<app>/src，跳过 test）的机械投影，只承载
> 「事件在哪声明、谁派发、谁监听」；事件语义、payload 字段、投递时序仍以 docs/06-api-spec.md §3
> 与 docs/02-module-design.md 手写章节为唯一权威。协议事件 payload 字段见协议目录
>（docs/generated/protocol-catalog.md §2）。

## 概览

- 事件全集 **25**：协议（RPC 数据面）20 · 双栖（协议 + 存储头行）1 · 存储级（仅落盘事件流）4
- 派发点为空的事件（如 `session.snapshot`）是扫描事实，语义解释见行内备注——正是本矩阵要暴露的面。

## 分类规则与登记表

- **扫描范围**：`packages/<pkg>/src` + `apps/<app>/src` 的 .ts/.tsx（跳过 test 与注释行）；命中令牌 = 事件字面量或存储事件常量标识符。
- **派发形态**：`emitPersisted(` / `emitAudit(` / `publish(` / `appendEvent(` / `emit(` 调用行，或对象键 `name: "x.y"`（subagent-runtime 先例）。
- **监听形态**：apps 层 `case "x.y":` / `onEvent("x.y"` / 注册数组独立键行（store/state 先例）；packages 层 `=== 常量`（jsonl-resume 重放先例）。
- **排除登记**（命中但非事件语义）：
  - `apps/desktop/src/renderer/components/**` —— UI 组件内 case "error" 等为工具卡/条目状态分发（非协议事件监听）；
  - `apps/web/src/components/**` —— 同上（Web 端组件目录，ToolCard case "error" 为工具卡状态分发）；
  - `packages/rpc/**` —— 传输管道：分帧/批量窗口/转发，语义监听面在端层（06 §3）；
- **覆盖登记**（正则不可达的派发点显式补录）：
  - tool_call.started ← `packages/agent-core/src/subagent/mirror.ts`（子代理镜像：按字面量比对子 turn 事件并向上转发（事件经变量 emit，正则不可达））；
  - permission.requested ← `packages/agent-core/src/turn/tool-phase.ts`（tool-phase 事件出口：经 emitPersisted(name, build) 变量形态派发（首 turn 审批路径））；
  - permission.resolved ← `packages/agent-core/src/turn/tool-phase.ts`（tool-phase 事件出口：经 emitPersisted(name, build) 变量形态派发）；
  - compaction.applied ← `packages/agent-core/src/compact/service.ts`（经多行 appendEvent 调用写入（COMPACTION_EVENT_NAME 常量独立行，行级正则不可达））；
- **防漏登记守卫**：源码中事件域前缀（session/message/tool_call/permission/turn/compact/subagent/mcp/plugin/hook）
  的点分小写字面量，凡不在 EVENT_SCHEMAS ∪ STORAGE_EVENTS ∪ METHOD_SCHEMAS 即生成器报错退出 1。

## 矩阵

| 事件 | 级别 | 声明于 | 派发点 | 监听点 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `compact.completed` | 协议（RPC 数据面） | `packages/shared/src/index.ts` | packages/agent-core/src/compact/service.ts、packages/agent-core/src/compact/wiring.ts | —（无） |  |
| `compact.started` | 协议（RPC 数据面） | `packages/shared/src/index.ts` | packages/agent-core/src/compact/service.ts、packages/agent-core/src/compact/wiring.ts | —（无） |  |
| `compaction.applied` | 存储级（仅落盘） | `packages/storage/src/jsonl-lines.ts` | packages/agent-core/src/compact/service.ts | packages/storage/src/jsonl-resume.ts | auto/manual compact 摘要落盘（epoch+1，05 §4.2）；经多行 appendEvent 调用写入（COMPACTION_EVENT_NAME 常量独立行，行级正则不可达） |
| `compaction.pruned` | 存储级（仅落盘） | `packages/storage/src/jsonl-lines.ts` | packages/agent-core/src/compact/microcompact.ts | packages/storage/src/jsonl-resume.ts | microcompact 预剪枝落盘（T5.4；不取压缩锁、不 bump epoch） |
| `done` | 协议（RPC 数据面） | `packages/shared/src/index.ts` | packages/agent-core/src/turn/loop-events.ts | apps/cli/src/stream.ts、apps/desktop/src/renderer/session-view.ts、apps/desktop/src/renderer/store.ts、apps/web/src/session-view.ts、apps/web/src/state.ts | 单词事件名（无域前缀）：llm 流结束与 turn 收束共用 done 字面量，矩阵只认 emit/case/注册键形态命中；已剔除假阳性：packages/agent-core/src/subagent/mirror.ts（stage:"done" 为 subagent.progress 载荷阶段值（this.emit 对象键），非协议 done 事件） |
| `error` | 协议（RPC 数据面） | `packages/shared/src/index.ts` | packages/agent-core/src/turn/loop-events.ts | apps/cli/src/stream.ts、apps/desktop/src/renderer/session-view.ts、apps/desktop/src/renderer/store.ts、apps/web/src/session-view.ts、apps/web/src/state.ts | 单词事件名（无域前缀）：UI 组件与 rpc 帧的同名状态字面量已登记排除（EXCLUDED_PREFIXES） |
| `hook.completed` | 协议（RPC 数据面） | `packages/shared/src/index.ts` | packages/agent-core/src/hooks/dispatcher.ts | apps/desktop/src/renderer/session-view.ts、apps/web/src/session-view.ts |  |
| `hook.invoked` | 存储级（仅落盘） | `packages/agent-core/src/turn/loop-events.ts` | packages/agent-core/src/hooks/dispatcher.ts | —（无） | log-only 审计对（T5.1；dispatch 即记，含未授信跳过计数） |
| `hook.result` | 存储级（仅落盘） | `packages/agent-core/src/turn/loop-events.ts` | packages/agent-core/src/hooks/dispatcher.ts | —（无） | log-only 审计对（T5.1；per hook 进程事实，stderr 截断落盘） |
| `hook.started` | 协议（RPC 数据面） | `packages/shared/src/index.ts` | packages/agent-core/src/hooks/dispatcher.ts | apps/desktop/src/renderer/session-view.ts、apps/web/src/session-view.ts |  |
| `mcp.server_status_changed` | 协议（RPC 数据面） | `packages/shared/src/index.ts` | packages/server/src/mcp-runtime.ts | apps/desktop/src/renderer/session-view.ts、apps/desktop/src/renderer/store.ts、apps/web/src/state.ts |  |
| `message.completed` | 协议（RPC 数据面） | `packages/shared/src/index.ts` | packages/agent-core/src/turn/loop-events.ts | apps/desktop/src/renderer/session-view.ts、apps/desktop/src/renderer/store.ts、apps/web/src/session-view.ts、apps/web/src/state.ts |  |
| `message.delta` | 协议（RPC 数据面） | `packages/shared/src/index.ts` | packages/agent-core/src/turn/loop-events.ts | apps/cli/src/stream.ts、apps/desktop/src/renderer/session-view.ts、apps/desktop/src/renderer/store.ts、apps/web/src/session-view.ts、apps/web/src/state.ts |  |
| `permission.requested` | 协议（RPC 数据面） | `packages/shared/src/index.ts` | packages/agent-core/src/turn/tool-phase.ts、packages/permission/src/approval-broker.ts | apps/cli/src/stream.ts、apps/desktop/src/renderer/session-view.ts、apps/desktop/src/renderer/store.ts、apps/web/src/session-view.ts、apps/web/src/state.ts | tool-phase 事件出口：经 emitPersisted(name, build) 变量形态派发（首 turn 审批路径）；已剔除假阳性：packages/agent-core/src/ports.ts（端口接口类型声明行（name: 联合类型），非派发）；packages/permission/src/types.ts（端口类型声明行（name: 联合类型），非派发） |
| `permission.resolved` | 协议（RPC 数据面） | `packages/shared/src/index.ts` | packages/agent-core/src/turn/tool-phase.ts、packages/permission/src/approval-broker.ts | apps/cli/src/stream.ts、apps/desktop/src/renderer/session-view.ts、apps/desktop/src/renderer/store.ts、apps/web/src/session-view.ts、apps/web/src/state.ts | tool-phase 事件出口：经 emitPersisted(name, build) 变量形态派发；已剔除假阳性：packages/agent-core/src/ports.ts（端口接口类型声明行（name: 联合类型），非派发）；packages/permission/src/types.ts（端口类型声明行（name: 联合类型），非派发） |
| `plugin.status_changed` | 协议（RPC 数据面） | `packages/shared/src/index.ts` | packages/server/src/plugin-runtime.ts | apps/desktop/src/renderer/session-view.ts、apps/desktop/src/renderer/store.ts、apps/web/src/state.ts |  |
| `session.created` | 双栖（协议 + 存储头行） | `packages/shared/src/index.ts` | packages/server/src/agent-service.ts、packages/server/src/session-domain.ts | —（无） | 双栖：协议事件（会话创建）+ 会话日志头行（HEADER_EVENT_NAME） |
| `session.snapshot` | 协议（RPC 数据面） | `packages/shared/src/index.ts` | —（无） | apps/desktop/src/renderer/session-view.ts、apps/desktop/src/renderer/store.ts、apps/web/src/session-view.ts、apps/web/src/state.ts | 派发点为空是既知事实：06 §3.2 响应投影——端层经 session.resume 响应携带快照本地重建（buildSessionSnapshotEvent 构造函数预留，零调用方） |
| `subagent.completed` | 协议（RPC 数据面） | `packages/shared/src/index.ts` | packages/server/src/subagent-runtime.ts | apps/desktop/src/renderer/store.ts、apps/desktop/src/renderer/subagent-view.ts、apps/web/src/state.ts |  |
| `subagent.progress` | 协议（RPC 数据面） | `packages/shared/src/index.ts` | packages/server/src/subagent-runtime.ts | apps/desktop/src/renderer/store.ts、apps/desktop/src/renderer/subagent-view.ts、apps/web/src/state.ts、apps/web/src/subagent-view.ts |  |
| `subagent.spawned` | 协议（RPC 数据面） | `packages/shared/src/index.ts` | packages/server/src/subagent-runtime.ts | apps/desktop/src/renderer/store.ts、apps/desktop/src/renderer/subagent-view.ts、apps/web/src/state.ts、apps/web/src/subagent-view.ts |  |
| `tool_call.completed` | 协议（RPC 数据面） | `packages/shared/src/index.ts` | packages/agent-core/src/turn/tool-phase.ts | apps/cli/src/stream.ts、apps/desktop/src/renderer/session-view.ts、apps/desktop/src/renderer/store.ts、apps/web/src/session-view.ts、apps/web/src/state.ts |  |
| `tool_call.progress` | 协议（RPC 数据面） | `packages/shared/src/index.ts` | packages/agent-core/src/turn/turn-loop.ts | apps/desktop/src/renderer/session-view.ts、apps/desktop/src/renderer/store.ts、apps/web/src/session-view.ts、apps/web/src/state.ts |  |
| `tool_call.started` | 协议（RPC 数据面） | `packages/shared/src/index.ts` | packages/agent-core/src/subagent/mirror.ts、packages/agent-core/src/turn/tool-phase.ts | apps/cli/src/stream.ts、apps/desktop/src/renderer/session-view.ts、apps/desktop/src/renderer/store.ts、apps/web/src/session-view.ts、apps/web/src/state.ts | 子代理镜像：按字面量比对子 turn 事件并向上转发（事件经变量 emit，正则不可达） |
| `turn.phase_changed` | 协议（RPC 数据面） | `packages/shared/src/index.ts` | packages/agent-core/src/turn/loop-events.ts | apps/desktop/src/renderer/session-view.ts、apps/desktop/src/renderer/store.ts、apps/web/src/session-view.ts、apps/web/src/state.ts |  |

