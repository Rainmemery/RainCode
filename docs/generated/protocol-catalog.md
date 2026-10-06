# RainCode 协议目录（生成式）

> **本文件由 `scripts/gen-protocol-catalog.mts` 生成（T4.3 防漂移门禁），不要手改。**
> 手改会被 `pnpm protocol:check`（CI 门禁 6）逐字节比对拒绝；协议演进后运行 `pnpm protocol:gen` 再生成并随代码提交。
>
> **职责边界**：本生成物 = `METHOD_SCHEMAS` / `EVENT_SCHEMAS`（packages/shared/src/index.ts）与 shared 五个
> `*_ERROR_CODES` 常量的机械投影，只承载「有哪些字段、什么类型、是否必填、什么约束」；方法语义、
> 事件投递行为、交互时序、业务错误码含义**仍以 docs/06-api-spec.md 手写章节为唯一权威**（06 §1~§4、§7）。
> 两处不一致时以 schema 注册表为准修正 06 手写表，而不是反向手改本文件。

## 概览

- 协议方法 **62**（域 13 个：config / hooks / marketplace / mcp / memory / permission / plugins / session / skills / subagent / system / tool / ws）
- 数据面事件 **21**
- 代码侧错误码族 **6**（session / config / mcp / subagent / skills 域为调用点字面量，见 §3 注）

## 1. 方法表

按域分节（域名 = 方法首段）；每方法列出入参与出参的顶层字段。嵌套对象深度 ≥3 折叠为 `object`。

### 域 config（6 方法）

#### config.get

入参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `path` | `string` | 否 | len≥1 |

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `config` | `unknown` | 否 |  |
| `configVersion` | `int` | 是 |  |

#### config.providers.add

入参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `provider` | `{ id: string?, name: string, baseURL: string, model: string, maxContextTokens: int, apiKeyRef: string \| null?, inputPricePerMtok: number?, outputPricePerMtok: number?, apiKey: string? }` | 是 |  |

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `provider` | `{ id: string, name: string, baseURL: string, model: string, maxContextTokens: number, apiKeyRef: string \| null?, apiKeyConfigured: boolean, inputPricePerMtok: number?, outputPricePerMtok: number? }` | 是 |  |

#### config.providers.list

入参：
无字段（空对象）。

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `providers` | `{ id: string, name: string, baseURL: string, model: string, maxContextTokens: number, apiKeyRef: string \| null?, apiKeyConfigured: boolean, inputPricePerMtok: number?, outputPricePerMtok: number? }[]` | 是 |  |
| `activeProviderId` | `string` | 否 |  |

#### config.providers.remove

入参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `id` | `string` | 是 |  |

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `removed` | `boolean` | 是 |  |

#### config.providers.switch

入参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `providerId` | `string` | 是 | len≥1 |

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `activeProviderId` | `string` | 是 |  |

#### config.set

入参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `path` | `string` | 是 | len≥1 |
| `value` | `unknown` | 否 |  |

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `config` | `unknown` | 否 |  |
| `configVersion` | `int` | 是 |  |

### 域 hooks（3 方法）

#### hooks.list

入参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `sessionId` | `string` | 否 |  |

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `items` | `{ source: "user" \| "project", path: string, loaded: boolean, error: string?, events: string[], hookCount: int, trusted: boolean?, trustedDigest: string? }[]` | 是 |  |

#### hooks.trust.grant

入参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `sessionId` | `string` | 是 | len≥1 |

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `workspaceId` | `string` | 是 |  |
| `digest` | `string` | 是 |  |
| `hookCount` | `int` | 是 | ≥0 |

#### hooks.trust.revoke

入参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `sessionId` | `string` | 是 | len≥1 |

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `workspaceId` | `string` | 是 |  |
| `trusted` | `boolean` | 是 |  |

### 域 marketplace（4 方法）

#### marketplace.add

入参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `id` | `string` | 是 | regex |
| `source` | `{ path: string }` | 是 |  |

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `marketplace` | `{ id: string, source: { path: string }, name: string?, description: string?, addedAt: int }` | 是 |  |

#### marketplace.install

入参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `marketplaceId` | `string` | 是 | len≥1 |
| `plugin` | `string` | 是 | len≥1 |

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `name` | `string` | 是 |  |
| `marketplaceId` | `string` | 是 |  |
| `version` | `string` | 是 |  |
| `dir` | `string` | 是 |  |
| `status` | `"active" \| "disabled" \| "failed"` | 是 |  |

#### marketplace.list

入参：
无字段（空对象）。

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `marketplaces` | `{ id: string, source: { path: string }, name: string?, description: string?, addedAt: int, pluginCount: int, plugins: object[], lastError: string \| null }[]` | 是 |  |

#### marketplace.uninstall

入参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `marketplaceId` | `string` | 是 | len≥1 |
| `plugin` | `string` | 是 | len≥1 |

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `removed` | `true` | 是 |  |

### 域 mcp（8 方法）

#### mcp.servers.add

入参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `config` | `{ serverKey: string, transport: "stdio" \| "http" \| "sse", command: string?, args: string[]?, env: Record<string, string>?, cwd: string?, url: string?, headers: Record<string, string>?, timeoutMs: int, enabled: boolean }` | 是 |  |
| `level` | `"project" \| "global"` | 否 | 默认 "global" |

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `serverKey` | `string` | 是 |  |
| `status` | `"Disconnected" \| "Connecting" \| "Connected" \| "Reconnecting" \| "Failed"` | 是 |  |

#### mcp.servers.health

入参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `serverKey` | `string` | 否 |  |

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `items` | `{ serverKey: string, status: "Disconnected" \| "Connecting" \| "Connected" \| "Reconnecting" \| "Failed", ok: boolean, latencyMs: number?, lastError: string? }[]` | 是 |  |

#### mcp.servers.list

入参：
无字段（空对象）。

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `servers` | `{ serverKey: string, transport: "stdio" \| "http" \| "sse", status: "Disconnected" \| "Connecting" \| "Connected" \| "Reconnecting" \| "Failed", enabled: boolean, toolCount: int?, lastError: string? }[]` | 是 |  |

#### mcp.servers.remove

入参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `serverKey` | `string` | 是 |  |

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `removed` | `boolean` | 是 |  |

#### mcp.servers.retry

入参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `serverKey` | `string` | 是 |  |

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `status` | `"Disconnected" \| "Connecting" \| "Connected" \| "Reconnecting" \| "Failed"` | 是 |  |

#### mcp.servers.setEnabled

入参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `serverKey` | `string` | 是 |  |
| `enabled` | `boolean` | 是 |  |

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `serverKey` | `string` | 是 |  |
| `enabled` | `boolean` | 是 |  |
| `status` | `"Disconnected" \| "Connecting" \| "Connected" \| "Reconnecting" \| "Failed"` | 是 |  |

#### mcp.tools.call

入参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `serverKey` | `string` | 是 |  |
| `toolName` | `string` | 是 | len≥1 |
| `args` | `unknown` | 否 |  |
| `timeoutMs` | `int` | 否 | ≥0 |

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `content` | `string` | 是 |  |
| `isError` | `boolean` | 是 |  |
| `raw` | `unknown` | 否 |  |

#### mcp.tools.list

入参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `serverKey` | `string` | 否 |  |

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `tools` | `{ name: string, serverKey: string, description: string?, inputSchema: unknown, available: boolean }[]` | 是 |  |

### 域 memory（7 方法）

#### memory.drafts.list

入参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `status` | `"pending" \| "confirmed" \| "rejected"` | 否 |  |

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `drafts` | `{ id: string, entryId: string, section: "项目概览" \| "技术栈与命令" \| "工作约定" \| "当前进行" \| "已知坑" \| "Agent 备忘", status: "pending" \| "confirmed" \| "rejected", createdAt: int, resolvedAt: int \| null, entry: { id: string, workspaceId: string, kind: "decision" \| "convention" \| "pitfall" \| "preference" \| "todo", content: string, refs: string[], confidence: number, source: "session-end" \| "compact" \| "manual" \| "memory-agent", status: "active" \| "superseded", supersededBy: string \| null, createdAt: int, lastSeenAt: int } }[]` | 是 |  |

#### memory.drafts.resolve

入参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `draftId` | `string` | 是 | len≥1 |
| `action` | `"confirm" \| "reject"` | 是 |  |
| `section` | `"项目概览" \| "技术栈与命令" \| "工作约定" \| "当前进行" \| "已知坑" \| "Agent 备忘"` | 否 |  |

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `resolved` | `true` | 是 |  |
| `promoted` | `boolean` | 是 |  |

#### memory.entries.list

入参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `kind` | `"decision" \| "convention" \| "pitfall" \| "preference" \| "todo"` | 否 |  |
| `source` | `"session-end" \| "compact" \| "manual" \| "memory-agent"` | 否 |  |
| `since` | `int` | 否 |  |
| `page` | `{ cursor: string?, limit: int? }` | 否 |  |

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `items` | `{ id: string, workspaceId: string, kind: "decision" \| "convention" \| "pitfall" \| "preference" \| "todo", content: string, refs: string[], confidence: number, source: "session-end" \| "compact" \| "manual" \| "memory-agent", status: "active" \| "superseded", supersededBy: string \| null, createdAt: int, lastSeenAt: int }[]` | 是 |  |
| `nextCursor` | `string` | 否 |  |

#### memory.promote

入参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `entryId` | `string` | 是 | len≥1 |
| `section` | `"项目概览" \| "技术栈与命令" \| "工作约定" \| "当前进行" \| "已知坑" \| "Agent 备忘"` | 是 |  |

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `promoted` | `boolean` | 是 |  |

#### memory.read

入参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `workspaceRoot` | `string` | 是 | len≥1 |

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `content` | `string` | 是 |  |
| `exists` | `boolean` | 是 |  |

#### memory.search

入参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `query` | `string` | 是 | len≥1 |
| `kind` | `"decision" \| "convention" \| "pitfall" \| "preference" \| "todo"` | 否 |  |
| `limit` | `int` | 否 | ≥1；≤50 |

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `entries` | `{ id: string, workspaceId: string, kind: "decision" \| "convention" \| "pitfall" \| "preference" \| "todo", content: string, refs: string[], confidence: number, source: "session-end" \| "compact" \| "manual" \| "memory-agent", status: "active" \| "superseded", supersededBy: string \| null, createdAt: int, lastSeenAt: int }[]` | 是 |  |

#### memory.write

入参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `workspaceRoot` | `string` | 是 | len≥1 |
| `section` | `"工作约定" \| "当前进行"` | 是 |  |
| `content` | `string` | 是 | len≥1 |

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `updated` | `boolean` | 是 |  |

### 域 permission（5 方法）

#### permission.decisions.list

入参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `sessionId` | `string` | 否 |  |
| `toolName` | `string` | 否 |  |
| `decision` | `"allow" \| "ask" \| "deny"` | 否 |  |
| `since` | `number` | 否 |  |
| `page` | `{ cursor: string?, limit: int? }` | 否 |  |

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `items` | `{ id: number, ts: number, sessionId: string, workspaceId: string, toolName: string, mode: "normal" \| "plan" \| "auto-accept", decision: "allow" \| "ask" \| "deny", matchedBy: "metadata" \| "mode" \| "session-rule" \| "project-rule" \| "global-rule" \| "default", ruleId: string \| null?, grantId: string \| null?, reason: string, inputDigest: string, respondLatencyMs: number \| null? }[]` | 是 |  |
| `nextCursor` | `string` | 否 |  |

#### permission.respond

入参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `grantId` | `string` | 是 |  |
| `decision` | `"allow" \| "deny"` | 是 |  |
| `always` | `boolean` | 否 |  |
| `scope` | `"session" \| "project" \| "global"` | 否 |  |
| `answerText` | `string` | 否 |  |

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `resolved` | `boolean` | 是 |  |
| `alreadyResolved` | `boolean` | 否 |  |
| `decision` | `"allow" \| "deny"` | 否 |  |
| `ruleId` | `string` | 否 |  |

#### permission.rules.add

入参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `scope` | `"project" \| "global"` | 是 |  |
| `tool` | `string` | 是 | len≥1 |
| `pattern` | `string` | 否 |  |
| `matchType` | `"wildcard" \| "exact" \| "regex"` | 否 |  |
| `behavior` | `"allow" \| "deny" \| "ask"` | 是 |  |

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `rule` | `{ id: string, scope: "session" \| "project" \| "global", tool: string, matchType: "wildcard" \| "exact" \| "regex"?, pattern: string \| null?, behavior: "allow" \| "deny" \| "ask", source: "user" \| "allow-always" \| "import", createdAt: number }` | 是 |  |

#### permission.rules.list

入参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `scope` | `"session" \| "project" \| "global"` | 否 |  |
| `tool` | `string` | 否 |  |

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `rules` | `{ id: string, scope: "session" \| "project" \| "global", tool: string, matchType: "wildcard" \| "exact" \| "regex"?, pattern: string \| null?, behavior: "allow" \| "deny" \| "ask", source: "user" \| "allow-always" \| "import", createdAt: number }[]` | 是 |  |

#### permission.rules.remove

入参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `id` | `string` | 是 |  |

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `removed` | `boolean` | 是 |  |

### 域 plugins（3 方法）

#### plugins.list

入参：
无字段（空对象）。

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `plugins` | `{ name: string, description: string, version: string?, dir: string, enabled: boolean, status: "active" \| "disabled" \| "failed", tools: string[], lastError: string \| null }[]` | 是 |  |

#### plugins.rescan

入参：
无字段（空对象）。

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `added` | `string[]` | 是 |  |

#### plugins.setEnabled

入参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `name` | `string` | 是 | len≥1 |
| `enabled` | `boolean` | 是 |  |

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `name` | `string` | 是 |  |
| `enabled` | `boolean` | 是 |  |
| `status` | `"active" \| "disabled" \| "failed"` | 是 |  |

### 域 session（12 方法）

#### session.archive

入参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `sessionId` | `string` | 是 |  |
| `force` | `boolean` | 否 |  |

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `archived` | `boolean` | 是 |  |

#### session.cancel

入参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `sessionId` | `string` | 是 |  |
| `turnId` | `string` | 否 |  |
| `reason` | `string` | 否 |  |

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `cancelled` | `boolean` | 是 |  |
| `at` | `"Idle" \| "ProcessingInput" \| "ModelRequest" \| "Streaming" \| "ToolSchedule" \| "ToolExecution" \| "AggregatingResults" \| "TurnComplete"` | 否 |  |

#### session.compact

入参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `sessionId` | `string` | 是 |  |

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `compactionId` | `string` | 是 |  |
| `epoch` | `int` | 是 | ≥0 |
| `alreadyRunning` | `boolean` | 是 |  |

#### session.create

入参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `workspaceRoot` | `string` | 是 | len≥1 |
| `title` | `string` | 否 |  |
| `providerId` | `string` | 否 |  |
| `mode` | `"normal" \| "plan" \| "auto-accept"` | 否 |  |

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `sessionId` | `string` | 是 |  |
| `state` | `"Active" \| "Archived"` | 是 |  |
| `createdAt` | `number` | 是 |  |

#### session.fork

入参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `sessionId` | `string` | 是 |  |
| `title` | `string` | 否 | len≥1；len≤200 |

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `sessionId` | `string` | 是 |  |
| `parentSessionId` | `string` | 是 |  |
| `title` | `string` | 是 |  |
| `messageCount` | `int` | 是 | ≥0 |

#### session.list

入参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `filter` | `{ state: "Active" \| "Archived"?, workspaceRoot: string?, keyword: string? }` | 否 |  |
| `page` | `{ cursor: string?, limit: int? }` | 否 |  |

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `items` | `{ id: string, title: string, state: "Active" \| "Archived", createdAt: number, lastActiveAt: number, model: string, contextUsage: { tokens: number, maxTokens: number } }[]` | 是 |  |
| `nextCursor` | `string` | 否 |  |

#### session.rename

入参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `sessionId` | `string` | 是 |  |
| `title` | `string` | 是 | len≥1；len≤200 |

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `sessionId` | `string` | 是 |  |
| `title` | `string` | 是 |  |

#### session.resume

入参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `sessionId` | `string` | 是 |  |

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `sessionId` | `string` | 是 |  |
| `snapshot` | `{ lastSeq: int, phase: "Idle" \| "ProcessingInput" \| "ModelRequest" \| "Streaming" \| "ToolSchedule" \| "ToolExecution" \| "AggregatingResults" \| "TurnComplete", turnId: string?, model: string, activeProviderId: string, contextUsage: { tokens: number, maxTokens: number }, messages: { id: string, role: "user" \| "assistant" \| "tool", content: string \| object \| object \| object[], attachments: object[]?, toolCallId: string?, isError: boolean?, reasoning: string? }[], history: { id: string, role: "user" \| "assistant" \| "tool", content: string \| object \| object \| object[], attachments: object[]?, toolCallId: string?, isError: boolean?, reasoning: string? }[]?, todoState: { content: string, status: "pending" \| "in_progress" \| "completed", activeForm: string? }[]?, pendingApprovals: { grantId: string, turnId: string?, toolCallId: string?, toolName: string, normalizedInput: unknown, metadata: object, mode: "normal" \| "plan" \| "auto-accept", matchedBy: "metadata" \| "mode" \| "session-rule" \| "project-rule" \| "global-rule" \| "default", reason: string, expiresAt: number, ruleCandidates: unknown[]? }[] }` | 是 |  |

#### session.send

入参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `sessionId` | `string` | 是 |  |
| `input` | `{ text: string, attachments: { path: string, mediaType: string? }[]? }` | 是 |  |

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `turnId` | `string` | 是 |  |
| `admission` | `"started" \| "queued"` | 是 |  |
| `queuePosition` | `int` | 否 |  |

#### session.setMode

入参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `sessionId` | `string` | 是 |  |
| `mode` | `"normal" \| "plan" \| "auto-accept"` | 是 |  |

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `mode` | `"normal" \| "plan" \| "auto-accept"` | 是 |  |

#### session.steer

入参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `sessionId` | `string` | 是 |  |
| `input` | `{ text: string }` | 是 |  |

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `result` | `"injected" \| "started" \| "queued"` | 是 |  |
| `turnId` | `string` | 否 |  |

#### session.usage

入参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `sessionId` | `string` | 是 |  |

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `sessionId` | `string` | 是 |  |
| `inputTokens` | `number` | 是 |  |
| `outputTokens` | `number` | 是 |  |
| `turnsCount` | `number` | 是 |  |
| `costEstimateUsd` | `number` | 否 |  |

### 域 skills（2 方法）

#### skills.invoke

入参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `sessionId` | `string` | 是 |  |
| `name` | `string` | 是 | len≥1 |
| `arguments` | `string` | 否 |  |

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `turnId` | `string` | 是 |  |
| `admission` | `"started" \| "queued"` | 是 |  |
| `queuePosition` | `int` | 否 | ≥1 |

#### skills.list

入参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `sessionId` | `string` | 否 |  |

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `items` | `{ name: string, description: string, source: "workspace" \| "global" \| "plugin", argumentHint: string?, modelInvocable: boolean }[]` | 是 |  |

### 域 subagent（4 方法）

#### subagent.list

入参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `sessionId` | `string` | 否 |  |

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `items` | `{ id: string, profileName: string, status: "Pending" \| "Running" \| "Completed" \| "Failed" \| "Stopped", startedAt: string?, usage: { inputTokens: number, outputTokens: number, cachedTokens: number? }?, turnsUsed: int? }[]` | 是 |  |

#### subagent.profiles.list

入参：
无字段（空对象）。

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `profiles` | `{ name: string, description: string, source: "workspace" \| "global" \| "builtin", tools: string[]?, model: string?, maxTurns: int? }[]` | 是 |  |

#### subagent.spawn

入参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `sessionId` | `string` | 是 |  |
| `profile` | `string \| { name: string, description: string, tools: string[]?, model: string?, maxTurns: int? }` | 是 |  |
| `task` | `string` | 是 | len≥1 |

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `subagentId` | `string` | 是 |  |
| `status` | `"Pending" \| "Running"` | 是 |  |
| `queuePosition` | `int` | 否 | ≥1 |

#### subagent.stop

入参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `subagentId` | `string` | 是 |  |
| `reason` | `string` | 否 |  |

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `stopped` | `boolean` | 是 |  |
| `status` | `"Pending" \| "Running" \| "Completed" \| "Failed" \| "Stopped"` | 是 |  |

### 域 system（3 方法）

#### system.ping

入参：
无字段（空对象）。

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `protocolVersion` | `string` | 是 |  |
| `capabilities` | `string[]` | 是 |  |
| `serverTime` | `number` | 是 |  |

#### system.shutdown

入参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `reason` | `string` | 否 |  |

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `shuttingDown` | `true` | 是 |  |

#### system.version

入参：
无字段（空对象）。

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `protocolVersion` | `string` | 是 |  |
| `appVersion` | `string` | 是 |  |
| `configVersion` | `int` | 是 |  |
| `nodeVersion` | `string` | 否 |  |

### 域 tool（4 方法）

#### tool.background.kill

入参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `taskId` | `string` | 是 |  |

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `ok` | `boolean` | 是 |  |
| `reason` | `"not_found" \| "not_running" \| "ownership_rejected" \| "terminated"` | 否 |  |

#### tool.background.list

入参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `sessionId` | `string` | 否 |  |

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `tasks` | `{ taskId: string, command: string, status: "Running" \| "Completed" \| "Failed" \| "Timeout" \| "Killed", startedAt: number, exitCode: number \| null? }[]` | 是 |  |

#### tool.background.output

入参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `taskId` | `string` | 是 |  |
| `tail` | `int` | 否 | ≥0 |

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `output` | `string` | 是 |  |
| `truncated` | `boolean` | 是 |  |

#### tool.tools.list

入参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `source` | `"builtin" \| "mcp" \| "plugin"` | 否 |  |

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `tools` | `{ name: string, description: string, source: "builtin" \| "mcp" \| "plugin", metadata: { readOnly: boolean, destructive: boolean, sideEffectScope: "none" \| "workspace" \| "machine" \| "network", riskLevel: "low" \| "medium" \| "high", needsApproval: boolean, timeoutMs: int?, maxOutputBytes: int? }, parametersSchema: unknown }[]` | 是 |  |

### 域 ws（1 方法）

#### ws.auth

入参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `token` | `string` | 是 | len≥1 |

出参：
| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `ok` | `true` | 是 |  |

## 2. 事件表（21 事件）

所有事件 payload 均含信封基字段（06 §3.1 EventBase）：`seq`（会话内单调递增，从 1 起）·
`sessionId`（全局事件缺省）· `ts`（epoch ms）——下表只列各事件特有字段。

#### compact.completed

| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `compactionId` | `string` | 是 |  |
| `epoch` | `int` | 是 | ≥0 |
| `ok` | `boolean` | 是 |  |
| `tokensBefore` | `number` | 否 |  |
| `tokensAfter` | `number` | 否 |  |
| `failure` | `{ reason: string }` | 否 |  |

#### compact.started

| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `compactionId` | `string` | 是 |  |
| `epoch` | `int` | 是 | ≥0 |
| `trigger` | `"auto" \| "manual"` | 是 |  |

#### done

| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `turnId` | `string` | 是 |  |
| `outcome` | `"completed" \| "cancelled" \| "failed"` | 是 |  |
| `at` | `"Idle" \| "ProcessingInput" \| "ModelRequest" \| "Streaming" \| "ToolSchedule" \| "ToolExecution" \| "AggregatingResults" \| "TurnComplete"` | 否 |  |
| `usage` | `{ inputTokens: number, outputTokens: number, cachedTokens: number? }` | 否 |  |
| `rounds` | `int` | 否 |  |

#### error

| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `scope` | `"turn" \| "session" \| "system"` | 是 |  |
| `code` | `string` | 是 |  |
| `message` | `string` | 是 |  |
| `recoverable` | `boolean` | 是 |  |
| `turnId` | `string` | 否 |  |

#### hook.completed

| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `turnId` | `string` | 否 |  |
| `invocationId` | `string` | 是 |  |
| `phase` | `"PreToolUse" \| "PostToolUse" \| "UserPromptSubmit" \| "Stop"` | 是 |  |
| `hookIds` | `string[]` | 是 |  |
| `outcome` | `"success" \| "blocked" \| "failed" \| "timed_out" \| "skipped_untrusted"` | 是 |  |
| `reason` | `string` | 否 |  |
| `decision` | `"approve" \| "block"` | 否 |  |
| `contextInjected` | `boolean` | 否 |  |
| `durationMs` | `int` | 是 | ≥0 |

#### hook.started

| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `turnId` | `string` | 否 |  |
| `invocationId` | `string` | 是 |  |
| `phase` | `"PreToolUse" \| "PostToolUse" \| "UserPromptSubmit" \| "Stop"` | 是 |  |
| `hookIds` | `string[]` | 是 |  |
| `async` | `boolean` | 是 |  |

#### mcp.server_status_changed

| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `serverKey` | `string` | 是 |  |
| `status` | `"Disconnected" \| "Connecting" \| "Connected" \| "Reconnecting" \| "Failed"` | 是 |  |
| `toolCount` | `int` | 否 | ≥0 |
| `error` | `string` | 否 |  |

#### message.completed

| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `turnId` | `string` | 是 |  |
| `round` | `int` | 是 |  |
| `message` | `{ role: "assistant", content: string, toolCalls: { toolCallId: string, toolName: string, args: unknown }[]?, stopReason: "stop" \| "tool_calls", usage: { inputTokens: number, outputTokens: number, cachedTokens: number? }? }` | 是 |  |

#### message.delta

| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `turnId` | `string` | 是 |  |
| `round` | `int` | 是 |  |
| `delta` | `{ type: "text" \| "reasoning", text: string } \| { type: "tool_call", index: int, toolCallId: string?, toolName: string?, argsPartial: string? }` | 是 |  |

#### permission.requested

| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `grantId` | `string` | 是 |  |
| `turnId` | `string` | 否 |  |
| `toolCallId` | `string` | 否 |  |
| `toolName` | `string` | 是 |  |
| `normalizedInput` | `unknown` | 否 |  |
| `metadata` | `{ readOnly: boolean, destructive: boolean, sideEffectScope: "none" \| "workspace" \| "machine" \| "network", riskLevel: "low" \| "medium" \| "high" }` | 是 |  |
| `mode` | `"normal" \| "plan" \| "auto-accept"` | 是 |  |
| `matchedBy` | `"metadata" \| "mode" \| "session-rule" \| "project-rule" \| "global-rule" \| "default"` | 是 |  |
| `reason` | `string` | 是 |  |
| `expiresAt` | `number` | 是 |  |
| `ruleCandidates` | `unknown[]` | 否 |  |

#### permission.resolved

| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `grantId` | `string` | 是 |  |
| `decision` | `"allow" \| "deny"` | 是 |  |
| `always` | `boolean` | 否 |  |
| `scope` | `"session" \| "project" \| "global"` | 否 |  |
| `by` | `"user" \| "timeout" \| "offline"` | 是 |  |
| `ruleId` | `string` | 否 |  |
| `respondLatencyMs` | `number` | 是 |  |
| `answerText` | `string` | 否 |  |

#### plugin.status_changed

| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `name` | `string` | 是 |  |
| `status` | `"active" \| "disabled" \| "failed"` | 是 |  |
| `toolCount` | `int` | 否 | ≥0 |
| `error` | `string` | 否 |  |

#### session.created

| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `title` | `string` | 是 |  |
| `workspaceRoot` | `string` | 是 |  |
| `mode` | `"normal" \| "plan" \| "auto-accept"` | 是 |  |
| `createdAt` | `number` | 是 |  |
| `kind` | `"main" \| "subagent"` | 否 |  |
| `parentSessionId` | `string` | 否 |  |

#### session.snapshot

| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `lastSeq` | `int` | 是 |  |
| `phase` | `"Idle" \| "ProcessingInput" \| "ModelRequest" \| "Streaming" \| "ToolSchedule" \| "ToolExecution" \| "AggregatingResults" \| "TurnComplete"` | 是 |  |
| `turnId` | `string` | 否 |  |
| `model` | `string` | 是 |  |
| `activeProviderId` | `string` | 是 |  |
| `contextUsage` | `{ tokens: number, maxTokens: number }` | 是 |  |
| `messages` | `{ id: string, role: "user" \| "assistant" \| "tool", content: string \| object \| object \| object[], attachments: object[]?, toolCallId: string?, isError: boolean?, reasoning: string? }[]` | 是 |  |
| `history` | `{ id: string, role: "user" \| "assistant" \| "tool", content: string \| object \| object \| object[], attachments: object[]?, toolCallId: string?, isError: boolean?, reasoning: string? }[]` | 否 |  |
| `todoState` | `{ content: string, status: "pending" \| "in_progress" \| "completed", activeForm: string? }[]` | 否 |  |
| `pendingApprovals` | `{ grantId: string, turnId: string?, toolCallId: string?, toolName: string, normalizedInput: unknown, metadata: { readOnly: boolean, destructive: boolean, sideEffectScope: "none" \| "workspace" \| "machine" \| "network", riskLevel: "low" \| "medium" \| "high" }, mode: "normal" \| "plan" \| "auto-accept", matchedBy: "metadata" \| "mode" \| "session-rule" \| "project-rule" \| "global-rule" \| "default", reason: string, expiresAt: number, ruleCandidates: unknown[]? }[]` | 是 |  |

#### subagent.completed

| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `subagentId` | `string` | 是 |  |
| `status` | `"Completed" \| "Failed" \| "Stopped"` | 是 |  |
| `summary` | `string` | 是 |  |
| `usage` | `{ inputTokens: number, outputTokens: number, cachedTokens: number? }` | 是 |  |
| `turnsUsed` | `int` | 是 |  |

#### subagent.progress

| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `subagentId` | `string` | 是 |  |
| `stage` | `"started" \| "tool" \| "done" \| "failed"` | 是 |  |
| `toolName` | `string` | 否 |  |
| `summary` | `string` | 否 |  |

#### subagent.spawned

| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `subagentId` | `string` | 是 |  |
| `profileName` | `string` | 是 |  |
| `taskPreview` | `string` | 是 |  |
| `status` | `"Pending" \| "Running"` | 是 |  |
| `queuePosition` | `int` | 否 | ≥1 |

#### tool_call.completed

| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `toolCallId` | `string` | 是 |  |
| `isError` | `boolean` | 是 |  |
| `error` | `{ code: string, message: string }` | 否 |  |
| `contentPreview` | `string` | 否 |  |
| `truncated` | `boolean` | 是 |  |
| `durationMs` | `number` | 是 |  |
| `display` | `unknown` | 否 |  |

#### tool_call.progress

| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `toolCallId` | `string` | 是 |  |
| `stream` | `"stdout" \| "stderr" \| "generic"` | 否 |  |
| `text` | `string` | 否 |  |
| `elapsedMs` | `number` | 是 |  |

#### tool_call.started

| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `turnId` | `string` | 是 |  |
| `toolCallId` | `string` | 是 |  |
| `toolName` | `string` | 是 |  |
| `input` | `unknown` | 否 |  |
| `metadata` | `{ readOnly: boolean, destructive: boolean, sideEffectScope: "none" \| "workspace" \| "machine" \| "network", riskLevel: "low" \| "medium" \| "high" }` | 是 |  |
| `batchIndex` | `int` | 否 |  |
| `batchSize` | `int` | 否 |  |

#### turn.phase_changed

| 字段 | 类型 | 必填 | 约束/说明 |
| --- | --- | --- | --- |
| `turnId` | `string` | 是 |  |
| `from` | `"Idle" \| "ProcessingInput" \| "ModelRequest" \| "Streaming" \| "ToolSchedule" \| "ToolExecution" \| "AggregatingResults" \| "TurnComplete" \| null` | 是 |  |
| `to` | `"Idle" \| "ProcessingInput" \| "ModelRequest" \| "Streaming" \| "ToolSchedule" \| "ToolExecution" \| "AggregatingResults" \| "TurnComplete"` | 是 |  |

## 3. 错误码族（代码侧常量）

| 常量 | 段/域 | 码 |
| --- | --- | --- |
| `MARKETPLACE_ERROR_CODES` | 段 15 marketplace | `MARKETPLACE_ESCAPE_BLOCKED`、`MARKETPLACE_INVALID`、`MARKETPLACE_NOT_FOUND`、`MARKETPLACE_SEED_MISMATCH` |
| `MEMORY_ERROR_CODES` | 段 6 memory | `MEMORY_DRAFT_NOT_FOUND`、`MEMORY_ENTRY_NOT_FOUND`、`MEMORY_SECTION_FORBIDDEN`、`MEMORY_WRITE_CONFLICT` |
| `PC_ERROR_CODES` | 段 2 permission | `PC_GRANT_CONSUMED`、`PC_GRANT_NOT_FOUND`、`PC_RULE_INVALID`、`PC_RULE_NOT_FOUND` |
| `PLUGIN_ERROR_CODES` | 段 10 plugins | `PLUGIN_INVALID`、`PLUGIN_NOT_FOUND` |
| `SYSTEM_ERROR_CODES` | 段 0 系统 | `CANCELLED`、`INTERNAL`、`INVALID_PARAMS`、`METHOD_NOT_FOUND`、`PARSE_ERROR`、`TIMEOUT`、`TRANSPORT_CLOSED`、`UNAUTHORIZED`、`VERSION_MISMATCH` |
| `TOOL_ERROR_CODES` | 段 7 tool | `TOOL_AMBIGUOUS_MATCH`、`TOOL_CANCELLED`、`TOOL_EXEC_FAILED`、`TOOL_HOOK_DENIED`、`TOOL_INPUT_RETRY_EXCEEDED`、`TOOL_INTERNAL`、`TOOL_INVALID_INPUT`、`TOOL_MCP_NOT_LOADED`、`TOOL_NO_MATCH`、`TOOL_PATH_ESCAPED`、`TOOL_PERMISSION_DENIED`、`TOOL_SSRF_BLOCKED`、`TOOL_TIMEOUT`、`TOOL_UNAVAILABLE`、`TOOL_UNKNOWN` |

> session / config / mcp / subagent / skills 域业务码为调用点字面量（无代码侧常量单源），
> 完整业务表以 06 §4.3 手写章节为权威；错误对象结构 `RpcError{code,message,details?}` 见 06 §1.2/§4.1。

