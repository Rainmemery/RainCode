/**
 * AgentService：服务层唯一组装点（04-architecture §2.4 铁律 4 / 06-api-spec §2）。
 *
 * - 组装 Storage + LlmClient + SessionTurnLoop（agent-core），经 createServiceBinding 暴露控制面；
 *   transport 由端层注入（CLI in-memory / 未来桌面 stdio），server 不选择传输载体；
 * - 方法表 schema 全部引用 @novacode/shared METHOD_SCHEMAS（04 ADR-07：未登记即无法暴露）；
 * - 会话事件（06 §3 数据面）由 agent-core 构造 payload（seq 会话内单调），经 binding.publish 发出；
 * - 业务错误以 RpcCallError(code, message) 抛出，binding 转换为 06 §4 结构化 error 应答。
 */
import { stat } from "node:fs/promises";
import {
  METHOD_SCHEMAS,
  PROTOCOL_VERSION,
  V1_CAPABILITIES,
  sessionSnapshotPayloadSchema,
} from "@novacode/shared";
import type {
  CollaborationMode,
  SessionCreateParams,
  SessionListParams,
  SessionResumeParams,
  SessionSendParams,
  SessionSnapshotPayload,
  SessionSummary,
  ToolBackgroundKillParams,
  ToolBackgroundListParams,
  ToolBackgroundOutputParams,
  ToolToolsListParams,
  PermissionDecisionsListParams,
  PermissionRespondParams,
  PermissionRulesAddParams,
  PermissionRulesListParams,
  PermissionRulesRemoveParams,
} from "@novacode/shared";
import { RpcCallError, createServiceBinding } from "@novacode/rpc";
import type { IMessageTransport, RpcMethodHandler, RpcServiceBinding } from "@novacode/rpc";
import { LlmClient } from "@novacode/llm";
import { Storage, StorageError, computeWorkspaceHash } from "@novacode/storage";
import type { SessionResume } from "@novacode/storage";
import { createBuiltinTools, ToolExecutor } from "@novacode/tools";
import type { BackgroundTaskRegistry, ToolRegistry } from "@novacode/tools";
import {
  SessionTurnLoop,
  alwaysAllowApprover,
  alwaysDenyApprover,
  createMetadataPermissionPort,
} from "@novacode/agent-core";
import type {
  LlmPort,
  PermissionPort,
  SessionEventPublisher,
  ToolPhaseDeps,
  TurnOutcome,
} from "@novacode/agent-core";
import { PermissionRuntime } from "./permission-runtime.js";
import type { PermissionPolicy, PermissionRuntimeOptions } from "./permission-runtime.js";

/** Provider 运行时配置（apiKey 已由调用方解析为明文注入；绝不落日志）。 */
export interface ProviderRuntimeConfig {
  id?: string;
  name: string;
  baseURL: string;
  model: string;
  apiKey?: string | null;
  maxContextTokens?: number;
}

/**
 * 工具系统装配（本波）：
 * - registry/executor 由 server 组装注入 AgentService（02 §0.2 依赖方向 server→tools）；
 * - approval 为 default-allow 策略下的测试审批实现（always-allow / always-deny）；
 *   normal（默认）策略走 PermissionRuntime（五级判定链 + 审批闭环，02 §6）。
 */
export interface ToolRuntimeConfig {
  /** 仅 default-allow 策略生效（normal 策略下忽略，走真实权限链）。 */
  approval?: "always-allow" | "always-deny";
  registry?: ToolRegistry;
}

/** 权限域装配（06 §2.2；策略模式：default-allow[仅开发] / normal[默认]）。 */
export interface PermissionConfig extends PermissionRuntimeOptions {
  policy: PermissionPolicy;
}

export interface AgentServiceOptions {
  storage: Storage;
  provider?: ProviderRuntimeConfig | null;
  /** 系统提示（随请求注入；缺省不注入）。 */
  systemPrompt?: string;
  /** 工具系统；缺省内置工具集。 */
  tools?: ToolRuntimeConfig;
  /** 权限策略；缺省 normal（五级判定链 + 审批闭环）。 */
  permission?: PermissionConfig;
}

interface SessionEntry {
  loop: SessionTurnLoop;
  workspaceHash: string;
  mode: CollaborationMode;
  /** 工具执行 ctx 基准（session.create 传入；resume 经 storage 回查）。 */
  workspaceRoot: string;
}

export class AgentService {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly llm: LlmPort | null;
  private readonly toolDeps: ToolPhaseDeps & { background: BackgroundTaskRegistry };
  /** normal 策略的权限域装配（default-allow 策略下为 null）。 */
  private readonly permission: PermissionRuntime | null;
  private binding: RpcServiceBinding | null = null;

  readonly providerModel: string;
  readonly providerId: string;
  readonly maxContextTokens: number;

  constructor(private readonly options: AgentServiceOptions) {
    const provider = options.provider ?? null;
    this.llm = provider
      ? new LlmClient({
          provider: {
            id: provider.id,
            name: provider.name,
            baseURL: provider.baseURL,
            model: provider.model,
            maxContextTokens: provider.maxContextTokens ?? 32768,
            apiKeyRef: null,
          },
          apiKey: provider.apiKey ?? null,
        })
      : null;
    this.providerModel = provider?.model ?? "";
    this.providerId = provider?.id ?? "default";
    this.maxContextTokens = provider?.maxContextTokens ?? 32768;

    // 工具系统组装（server 是唯一组装点；tools→shared、agent-core→tools 依赖方向不变）
    const builtin = createBuiltinTools();
    const registry = options.tools?.registry ?? builtin.registry;
    let permission: PermissionPort;
    if ((options.permission?.policy ?? "normal") === "normal") {
      // normal（默认）：五级判定链 + 审批闭环 + 规则 + 审计（02 §6）
      this.permission = new PermissionRuntime(this.options.storage, {
        approvalTimeoutMs: options.permission?.approvalTimeoutMs,
      });
      permission = this.permission.port;
    } else {
      // default-allow（仅开发）：metadata 快速通道 + 测试审批（approval 选项驱动）
      this.permission = null;
      const approve =
        options.tools?.approval === "always-deny" ? alwaysDenyApprover : alwaysAllowApprover;
      permission = createMetadataPermissionPort(approve);
    }
    this.toolDeps = {
      registry,
      executor: new ToolExecutor({ registry }),
      permission,
      background: builtin.background,
    };
  }

  /** 绑定传输并暴露方法表（一次服务可多次 attach 到不同 transport）。 */
  attach(transport: IMessageTransport): RpcServiceBinding {
    const binding = createServiceBinding(transport, { methods: this.buildMethods() });
    this.binding = binding;
    return binding;
  }

  /** 停止受理（transport 生命周期由持有方管理）。 */
  close(): void {
    this.binding?.close();
    this.binding = null;
    this.permission?.close();
    this.sessions.clear();
  }

  // ---------------------------------------------------------------------------
  // 方法表（schema 真源 METHOD_SCHEMAS；handler 内不再校验传输结构，04 §4.3）
  // ---------------------------------------------------------------------------

  private buildMethods(): Record<string, RpcMethodHandler> {
    const register = (method: string, handler: (params: unknown) => Promise<unknown>) => {
      const schemas = METHOD_SCHEMAS[method];
      if (!schemas) {
        throw new Error(`method missing in METHOD_SCHEMAS: ${method}`);
      }
      return { schema: schemas.request, handler };
    };
    return {
      "system.ping": register("system.ping", async () => ({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: [...V1_CAPABILITIES],
        serverTime: Date.now(),
      })),
      "session.create": register("session.create", (params) => this.createSession(params as SessionCreateParams)),
      "session.send": register("session.send", (params) => this.send(params as SessionSendParams)),
      "session.cancel": register("session.cancel", (params) => this.cancel(params as { sessionId: string; reason?: string })),
      "session.list": register("session.list", (params) => this.list(params as SessionListParams)),
      "session.resume": register("session.resume", (params) => this.resume(params as SessionResumeParams)),
      "tool.tools.list": register("tool.tools.list", (params) =>
        this.listTools(params as ToolToolsListParams)),
      "tool.background.list": register("tool.background.list", (params) =>
        this.listBackgroundTasks(params as ToolBackgroundListParams)),
      "tool.background.kill": register("tool.background.kill", (params) =>
        this.killBackgroundTask(params as ToolBackgroundKillParams)),
      "tool.background.output": register("tool.background.output", (params) =>
        this.readBackgroundOutput(params as ToolBackgroundOutputParams)),
      "permission.respond": register("permission.respond", (params) =>
        this.requirePermission().respond(params as PermissionRespondParams)),
      "permission.rules.list": register("permission.rules.list", (params) =>
        this.requirePermission().listRules(params as PermissionRulesListParams)),
      "permission.rules.add": register("permission.rules.add", (params) =>
        this.requirePermission().addRule(params as PermissionRulesAddParams)),
      "permission.rules.remove": register("permission.rules.remove", (params) =>
        this.requirePermission().removeRule(params as PermissionRulesRemoveParams)),
      "permission.decisions.list": register("permission.decisions.list", (params) =>
        this.requirePermission().listDecisions(params as PermissionDecisionsListParams)),
    };
  }

  private async createSession(params: SessionCreateParams): Promise<unknown> {
    // workspaceRoot 必须为已存在目录（06 §2.1）；只读存在性探测，不读写任何数据，
    // 不构成对 storage「唯一持久化出口」的绕越（04 §2.4 铁律 2 注记）。
    try {
      const info = await stat(params.workspaceRoot);
      if (!info.isDirectory()) throw new Error("not a directory");
    } catch {
      throw new RpcCallError("INVALID_PARAMS", "workspaceRoot must be an existing directory", {
        workspaceRoot: params.workspaceRoot,
      });
    }
    const workspace = await this.options.storage.ensureWorkspace(params.workspaceRoot);
    const meta = await this.options.storage.createSession({
      workspaceHash: workspace.hash,
      workspaceRoot: params.workspaceRoot,
      title: params.title,
      mode: params.mode,
    });
    // project 权限规则判定域（首个会话的 workspace；02 §6.2 判定链第 4 级）
    this.permission?.setDefaultWorkspace(workspace.hash);
    const loop = new SessionTurnLoop({
      sessionId: meta.id,
      mode: meta.mode,
      llm: this.llm,
      storage: this.options.storage,
      publish: this.publisher(),
      systemPrompt: this.options.systemPrompt,
      tools: this.toolDeps,
      workspaceRoot: params.workspaceRoot,
      workspaceId: workspace.hash,
      onDiagnostic: (message, err) => console.error(`[novacode/server] ${message}`, err ?? ""),
    });
    this.sessions.set(meta.id, {
      loop,
      workspaceHash: workspace.hash,
      mode: meta.mode,
      workspaceRoot: params.workspaceRoot,
    });
    return { sessionId: meta.id, state: "Active", createdAt: meta.createdAt };
  }

  private async send(params: SessionSendParams): Promise<unknown> {
    const entry = this.requireActive(params.sessionId);
    if (!this.llm) {
      throw new RpcCallError(
        "CONFIG_PROVIDER_NOT_FOUND",
        "no provider configured: set --base-url/--model, NOVACODE_PROVIDER_* env, or config/providers.local.json",
      );
    }
    const admission = entry.loop.submit({ text: params.input.text, attachments: params.input.attachments });
    // turn 结果的旁路消费：usage 累计进 sessions 投影列（session.list 的 contextUsage 数据源）
    void admission.done.then((outcome: TurnOutcome) => {
      if (outcome.status === "completed" && outcome.usage !== undefined) {
        void this.recordUsage(params.sessionId, outcome.usage).catch((err: unknown) =>
          console.error("[novacode/server] failed to record usage", err),
        );
      }
    });
    return {
      turnId: admission.turnId,
      admission: admission.admission,
      ...(admission.queuePosition !== undefined && { queuePosition: admission.queuePosition }),
    };
  }

  private async cancel(params: { sessionId: string; reason?: string }): Promise<unknown> {
    const entry = this.requireActive(params.sessionId);
    const result = entry.loop.cancel(params.reason);
    return { cancelled: result.cancelled, ...(result.at !== undefined && { at: result.at }) };
  }

  private async list(params: SessionListParams): Promise<unknown> {
    const filter = params.filter;
    const rows = await this.options.storage.sessions.list({
      workspaceHash:
        filter?.workspaceRoot !== undefined ? computeWorkspaceHash(filter.workspaceRoot) : undefined,
      status: filter?.state !== undefined ? (filter.state === "Active" ? "active" : "archived") : undefined,
    });
    const keyword = filter?.keyword?.toLowerCase();
    const filtered = keyword
      ? rows.filter(
          (row) => row.title.toLowerCase().includes(keyword) || row.preview.toLowerCase().includes(keyword),
        )
      : rows;

    const limit = params.page?.limit ?? 50;
    const offset = parseCursor(params.page?.cursor);
    const paged = filtered.slice(offset, offset + limit);
    const items: SessionSummary[] = paged.map((row) => ({
      id: row.id,
      title: row.title,
      state: row.status === "active" ? "Active" : "Archived",
      createdAt: row.createdAt,
      lastActiveAt: row.lastActiveAt,
      model: this.providerModel,
      contextUsage: {
        tokens: row.inputTokens + row.outputTokens,
        maxTokens: this.maxContextTokens,
      },
    }));
    return {
      items,
      ...(offset + limit < filtered.length && { nextCursor: `o${String(offset + limit)}` }),
    };
  }

  private async resume(params: SessionResumeParams): Promise<unknown> {
    const existing = this.sessions.get(params.sessionId);
    if (existing) {
      // 幂等：会话已 Active 直接返回当前快照（06 §2.1；多端收敛单写者）
      return { sessionId: params.sessionId, snapshot: await this.buildSnapshot(params.sessionId, existing) };
    }

    let replay: SessionResume;
    try {
      replay = await this.options.storage.resumeSession(params.sessionId);
    } catch (reason: unknown) {
      if (reason instanceof StorageError && reason.code === "SESSION_NOT_FOUND") {
        throw new RpcCallError("SESSION_NOT_FOUND", `session not found: ${params.sessionId}`);
      }
      throw reason;
    }
    const meta = await this.options.storage.sessions.get(params.sessionId);
    if (!meta) {
      throw new RpcCallError("SESSION_NOT_FOUND", `session not found: ${params.sessionId}`);
    }
    const workspaceRoot = (await this.options.storage.workspaceRootOf(meta.id)) ?? process.cwd();
    const loop = new SessionTurnLoop({
      sessionId: meta.id,
      mode: meta.mode,
      llm: this.llm,
      storage: this.options.storage,
      publish: this.publisher(),
      systemPrompt: this.options.systemPrompt,
      tools: this.toolDeps,
      workspaceRoot,
      workspaceId: meta.workspaceId,
      initialHistory: replay.history,
      // 跨进程 rpc seq 连续性为 best-effort：delta 不落盘导致原 seq 不可完全重建；
      // 以持久事件/检查点的最大行号续起点，端层以 snapshot.lastSeq 为准继续消费（06 §3.3）。
      initialEventSeq: seedEventSeq(replay),
      onDiagnostic: (message, err) => console.error(`[novacode/server] ${message}`, err ?? ""),
    });
    const entry: SessionEntry = {
      loop,
      workspaceHash: meta.workspaceId,
      mode: meta.mode,
      workspaceRoot,
    };
    this.sessions.set(meta.id, entry);
    return { sessionId: meta.id, snapshot: await this.buildSnapshot(meta.id, entry) };
  }

  // ---------------------------------------------------------------------------
  // tool 域（06 §2.7：工具发现 + 后台任务管理；直接调用 tool.call 随受限调用波次）
  // ---------------------------------------------------------------------------

  private async listTools(params: ToolToolsListParams): Promise<unknown> {
    return { tools: this.toolDeps.registry.list(params.source !== undefined ? { source: params.source } : undefined) };
  }

  private async listBackgroundTasks(_params: ToolBackgroundListParams): Promise<unknown> {
    // 会话级过滤随任务归属波次补齐（registry 当前全局共享，02 §5.3）
    return { tasks: this.toolDeps.background.list() };
  }

  private async killBackgroundTask(params: ToolBackgroundKillParams): Promise<unknown> {
    return this.toolDeps.background.kill(params.taskId);
  }

  private async readBackgroundOutput(params: ToolBackgroundOutputParams): Promise<unknown> {
    return this.toolDeps.background.readOutput(params.taskId, params.tail !== undefined ? { tail: params.tail } : undefined);
  }

  // ---------------------------------------------------------------------------
  // 内部
  // ---------------------------------------------------------------------------

  private publisher(): SessionEventPublisher {
    return (event) => {
      if (!this.binding) {
        console.error("[novacode/server] event dropped: no transport attached", event.name);
        return;
      }
      this.binding.publish(event);
    };
  }

  /** permission 域方法的前置（default-allow 策略下未装配，返回结构化业务错误）。 */
  private requirePermission(): PermissionRuntime {
    if (this.permission === null) {
      throw new RpcCallError(
        "PC_GRANT_NOT_FOUND",
        "permission domain not enabled: policy is default-allow",
      );
    }
    return this.permission;
  }

  private requireActive(sessionId: string): SessionEntry {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw new RpcCallError("SESSION_NOT_FOUND", `session not found or not resumed: ${sessionId}`);
    }
    return entry;
  }

  private async buildSnapshot(sessionId: string, entry: SessionEntry): Promise<SessionSnapshotPayload> {
    const meta = await this.options.storage.sessions.get(sessionId);
    // session.snapshot（06 §3.2）：恢复完成/重连补推的端层状态重建数据源；
    // 内存态会话的增量消息为空（客户端被认为已跟进到 lastSeq）。
    return sessionSnapshotPayloadSchema.parse({
      lastSeq: entry.loop.lastEventSeq,
      phase: entry.loop.phase,
      model: this.providerModel,
      activeProviderId: this.providerId,
      contextUsage: {
        tokens: (meta?.inputTokens ?? 0) + (meta?.outputTokens ?? 0),
        maxTokens: this.maxContextTokens,
      },
      messages: [],
      pendingApprovals: [],
    });
  }

  private async recordUsage(sessionId: string, usage: { inputTokens: number; outputTokens: number }): Promise<void> {
    const meta = await this.options.storage.sessions.get(sessionId);
    if (!meta) return;
    await this.options.storage.sessions.updateMeta(sessionId, {
      inputTokens: meta.inputTokens + usage.inputTokens,
      outputTokens: meta.outputTokens + usage.outputTokens,
    });
  }
}

/** resume 场景 rpc seq 续起点：持久事件行与 checkpoint 的最大行号。 */
function seedEventSeq(replay: SessionResume): number {
  let max = 0;
  for (const event of replay.events) {
    max = Math.max(max, event.seq);
  }
  if (replay.checkpoint) {
    max = Math.max(max, replay.checkpoint.seq);
  }
  return max;
}

/** 简单偏移游标：`o<number>`；非法/缺省回退 0（06 §2.0 分页约定的最小落地）。 */
function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined || !cursor.startsWith("o")) return 0;
  const parsed = Number.parseInt(cursor.slice(1), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}
