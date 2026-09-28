/**
 * AgentService：服务层唯一组装点（04-architecture §2.4 铁律 4 / 06-api-spec §2）。
 * 组装 Storage + LlmClient + SessionTurnLoop（agent-core），经 createServiceBinding 暴露控制面；
 * 方法表 schema 全部引用 @novacode/shared METHOD_SCHEMAS（04 ADR-07）；事件由 agent-core 构造 payload。
 */
import { stat } from "node:fs/promises";
import {
  METHOD_SCHEMAS,
  PROTOCOL_VERSION,
  V1_CAPABILITIES,
  buildSessionCreatedEvent,
} from "@novacode/shared";
import type {
  CollaborationMode,
  SessionArchiveParams,
  SessionCompactParams,
  SessionCreateParams,
  SessionListParams,
  SessionResumeParams,
  SessionSendParams,
  SessionSetModeParams,
  SessionSnapshotPayload,
  SessionSteerParams,
  SystemShutdownParams,
} from "@novacode/shared";
import { RpcCallError, createServiceBinding } from "@novacode/rpc";
import type { IMessageTransport, RpcMethodHandler, RpcServiceBinding } from "@novacode/rpc";
import { LlmClient } from "@novacode/llm";
import { Storage, StorageError } from "@novacode/storage";
import type { SessionResume } from "@novacode/storage";
import { createBuiltinTools, ToolExecutor } from "@novacode/tools";
import type { BackgroundTaskRegistry, ToolRegistry } from "@novacode/tools";
import { alwaysAllowApprover, alwaysDenyApprover, createMetadataPermissionPort } from "@novacode/agent-core";
import type { CompactionOptions, LlmPort, PermissionPort, SessionEventPublisher, SessionTurnLoop, ToolPhaseDeps, TurnOutcome } from "@novacode/agent-core";
import { ConfigDomain } from "./config-domain.js";
import { ConfigStore } from "./config-store.js";
import { ToolDomain } from "./tool-domain.js";
import { appVersion } from "./app-version.js";
import {
  assertNoRunningBackgroundTasks,
  buildSessionSnapshot,
  compactSession,
  createSessionLoop,
  listSessions,
  recordUsage,
  seedEventSeq,
} from "./session-support.js";
import { PermissionRuntime } from "./permission-runtime.js";
import type { PermissionPolicy, PermissionRuntimeOptions } from "./permission-runtime.js";
import { McpRuntime } from "./mcp-runtime.js";

/** Provider 运行时配置（apiKey 已由调用方解析为明文注入；绝不落日志）。 */
export interface ProviderRuntimeConfig {
  id?: string;
  name: string;
  baseURL: string;
  model: string;
  apiKey?: string | null;
  maxContextTokens?: number;
}

/** 工具系统装配：approval 为 default-allow 策略的测试审批实现（normal 走 PermissionRuntime）。 */
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
  /** auto-compact 装配（02 §1.2.5；缺省 = 不启用；contextWindowTokens 取 Provider maxContextTokens）。 */
  compaction?: { thresholdRatio?: number; keepRecentCount?: number };
  /** MCP 域装配（02 §3；缺省 = 不启用 mcp 域；workspaceRoot 为 project 层 mcp.json 判定域）。 */
  mcp?: { workspaceRoot?: string };
  /** system.shutdown 的存储关闭回调（node 注入；缺省跳过——传输关闭由持有方承担）。 */
  onShutdown?: () => Promise<void>;
}

interface SessionEntry {
  loop: SessionTurnLoop;
  llm: LlmPort | null;
  providerId: string;
  workspaceHash: string;
  mode: CollaborationMode;
  workspaceRoot: string;
  /** 最近一次 submit 的 turn 终态句柄（archive / shutdown 的等待点）。 */
  pending: Promise<TurnOutcome> | null;
}

export class AgentService {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly llm: LlmPort | null;
  /** config 域 Provider 的按需 LLM 客户端缓存（session.create providerId 绑定路径）。 */
  private readonly llmByProvider = new Map<string, LlmPort>();
  private readonly toolDeps: ToolPhaseDeps & { background: BackgroundTaskRegistry };
  /** normal 策略的权限域装配（default-allow 策略下为 null）。 */
  private readonly permission: PermissionRuntime | null;
  /** config 域（全局 config.json + providers CRUD，06 §2.3）。 */
  private readonly config: ConfigDomain;
  /** tool 域（06 §2.7 P0 4 方法）。 */
  private readonly toolDomain: ToolDomain;
  /** MCP 域（06 §2.5；缺省未装配）。 */
  private readonly mcp: McpRuntime | null;
  private binding: RpcServiceBinding | null = null;
  private shuttingDown = false;

  readonly providerModel: string;
  readonly providerId: string;
  readonly maxContextTokens: number;
  /** auto-compact 装配（02 §1.2.5；undefined = 不启用）。 */
  private readonly compaction: CompactionOptions | undefined;

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
    this.compaction = this.buildCompaction();
    this.config = new ConfigDomain(new ConfigStore({ dataRoot: options.storage.dataRoot }));

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
    this.toolDomain = new ToolDomain({ registry, background: builtin.background });
    // MCP 域（02 §3）：命名空间工具进同一 registry；连接异步建立，状态经全局事件
    this.mcp =
      options.mcp === undefined
        ? null
        : new McpRuntime({
            registry,
            background: builtin.background,
            executor: this.toolDeps.executor,
            dataRoot: options.storage.dataRoot,
            workspaceRoot: options.mcp.workspaceRoot,
            publish: (event) => this.binding?.publish(event),
          });
    void this.mcp?.init();
  }

  /** 绑定传输并暴露方法表（一次服务可多次 attach 到不同 transport）。 */
  attach(transport: IMessageTransport): RpcServiceBinding {
    const binding = createServiceBinding(transport, { methods: this.buildMethods() });
    this.binding = binding;
    return binding;
  }

  close(): void {
    this.binding?.close();
    this.binding = null;
    this.permission?.close();
    void this.mcp?.close(); // MCP 子进程/连接异步收敛
    this.sessions.clear();
  }

  // 方法表（schema 真源 METHOD_SCHEMAS；handler 内不再校验传输结构，04 §4.3）
  private buildMethods(): Record<string, RpcMethodHandler> {
    const register = (method: string, handler: (params: unknown) => Promise<unknown>) => {
      const schemas = METHOD_SCHEMAS[method];
      if (!schemas) {
        throw new Error(`method missing in METHOD_SCHEMAS: ${method}`);
      }
      return {
        schema: schemas.request,
        handler: async (params: unknown): Promise<unknown> => {
          if (this.shuttingDown) {
            // 06 §4.3 段 8：停机中再收请求返回 CANCELLED
            throw new RpcCallError("CANCELLED", `server is shutting down: ${method} rejected`);
          }
          return handler(params);
        },
      };
    };
    return {
      "system.ping": register("system.ping", async () => ({
        protocolVersion: PROTOCOL_VERSION, capabilities: [...V1_CAPABILITIES], serverTime: Date.now(),
      })),
      "system.version": register("system.version", async () => ({
        protocolVersion: PROTOCOL_VERSION, appVersion: appVersion(),
        configVersion: this.config.configVersion(), nodeVersion: process.version,
      })),
      "system.shutdown": register("system.shutdown", (params) =>
        this.shutdown(params as SystemShutdownParams)),
      "session.create": register("session.create", (params) => this.createSession(params as SessionCreateParams)),
      "session.send": register("session.send", (params) => this.send(params as SessionSendParams)),
      "session.steer": register("session.steer", (params) => this.steer(params as SessionSteerParams)),
      "session.cancel": register("session.cancel", (params) => this.cancel(params as { sessionId: string; reason?: string })),
      "session.list": register("session.list", (params) => this.list(params as SessionListParams)),
      "session.resume": register("session.resume", (params) => this.resume(params as SessionResumeParams)),
      "session.archive": register("session.archive", (params) => this.archive(params as SessionArchiveParams)),
      "session.setMode": register("session.setMode", (params) => this.setMode(params as SessionSetModeParams)),
      "session.compact": register("session.compact", (params) => this.compact(params as SessionCompactParams)),
      ...this.config.methods(register),
      ...this.toolDomain.methods(register),
      // MCP 域未装配时不暴露（METHOD_SCHEMAS 已登记，缺 handler 调用期报 method not found）
      ...(this.mcp !== null ? this.mcp.methods(register) : {}),
      // default-allow 策略未装配 permission 域（requirePermission 在调用期报 PC_GRANT_NOT_FOUND）
      ...(this.permission !== null ? this.permission.methods(register) : {}),
    };
  }

  // session 域（06 §2.1）
  private async createSession(params: SessionCreateParams): Promise<unknown> {
    // workspaceRoot 必须为已存在目录（06 §2.1）；只读存在性探测，不读写任何数据（04 §2.4 铁律 2 注记）
    try {
      const info = await stat(params.workspaceRoot);
      if (!info.isDirectory()) throw new Error("not a directory");
    } catch {
      throw new RpcCallError("INVALID_PARAMS", "workspaceRoot must be an existing directory", {
        workspaceRoot: params.workspaceRoot,
      });
    }
    const llm = this.llmFor(params.providerId); // 显式 providerId 未知 → CONFIG_PROVIDER_NOT_FOUND
    const workspace = await this.options.storage.ensureWorkspace(params.workspaceRoot);
    const meta = await this.options.storage.createSession({
      workspaceHash: workspace.hash,
      workspaceRoot: params.workspaceRoot,
      title: params.title,
      mode: params.mode,
    });
    this.permission?.setDefaultWorkspace(workspace.hash); // project 权限规则判定域（02 §6.2 第 4 级）
    const publish = this.publisher();
    publish({
      name: "session.created",
      payload: buildSessionCreatedEvent({
        seq: 1, sessionId: meta.id, title: meta.title, workspaceRoot: params.workspaceRoot,
        mode: meta.mode, createdAt: meta.createdAt,
      }),
    });
    const loop = createSessionLoop({
      sessionId: meta.id, mode: meta.mode, llm, storage: this.options.storage, publish,
      ...(this.options.systemPrompt !== undefined && { systemPrompt: this.options.systemPrompt }),
      tools: this.toolDeps, workspaceRoot: params.workspaceRoot, workspaceId: workspace.hash,
      initialEventSeq: 1,
      ...(this.compaction !== undefined && { compaction: this.compaction }),
    });
    this.sessions.set(meta.id, {
      loop, llm, providerId: params.providerId ?? this.providerId,
      workspaceHash: workspace.hash, mode: meta.mode, workspaceRoot: params.workspaceRoot, pending: null,
    });
    return { sessionId: meta.id, state: "Active", createdAt: meta.createdAt };
  }

  private async send(params: SessionSendParams): Promise<unknown> {
    const entry = await this.requireActive(params.sessionId);
    if (entry.llm === null) {
      throw new RpcCallError(
        "CONFIG_PROVIDER_NOT_FOUND",
        "no provider configured: set --base-url/--model, NOVACODE_PROVIDER_* env, config/providers.local.json, or config.providers.add",
      );
    }
    const admission = entry.loop.submit({ text: params.input.text, attachments: params.input.attachments });
    entry.pending = admission.done;
    // turn 结果的旁路消费：usage 累计进 sessions 投影列（session.list 的 contextUsage 数据源）
    void admission.done.then((outcome: TurnOutcome) => {
      if (outcome.status === "completed" && outcome.usage !== undefined) {
        void recordUsage(this.options.storage, params.sessionId, outcome.usage).catch(
          (err: unknown) => console.error("[novacode/server] failed to record usage", err),
        );
      }
    });
    return {
      turnId: admission.turnId,
      admission: admission.admission,
      ...(admission.queuePosition !== undefined && { queuePosition: admission.queuePosition }),
    };
  }

  /** turn.steer（06 §2.1）：运行中注入 steeringBuffer（下一轮上下文合并）；空闲按 turn.new 处理。 */
  private async steer(params: SessionSteerParams): Promise<unknown> {
    const entry = await this.requireActive(params.sessionId);
    const result = entry.loop.steer(params.input.text);
    return { result: result.result, ...(result.turnId !== undefined && { turnId: result.turnId }) };
  }

  private async cancel(params: { sessionId: string; reason?: string }): Promise<unknown> {
    const entry = await this.requireActive(params.sessionId);
    const result = entry.loop.cancel(params.reason);
    return { cancelled: result.cancelled, ...(result.at !== undefined && { at: result.at }) };
  }

  /** 协作模式切换（06 §2.1）：运行中 turn 后续判定立即生效 + sessions.mode 落库。 */
  private async setMode(params: SessionSetModeParams): Promise<unknown> {
    const entry = await this.requireActive(params.sessionId);
    entry.loop.setMode(params.mode);
    entry.mode = params.mode;
    await this.options.storage.sessions.updateMeta(params.sessionId, { mode: params.mode });
    return { mode: params.mode };
  }

  /** 手动压缩（06 §2.1）：受理即返 ticket；完成/失败经 compact.started/completed 事件。 */
  private compact(params: SessionCompactParams): Promise<unknown> {
    return this.requireActive(params.sessionId).then((entry) => compactSession(entry));
  }

  private async archive(params: SessionArchiveParams): Promise<unknown> {
    const meta = await this.options.storage.sessions.get(params.sessionId);
    if (!meta) {
      throw new RpcCallError("SESSION_NOT_FOUND", `session not found: ${params.sessionId}`);
    }
    if (meta.status === "archived") {
      return { archived: true }; // 幂等（06 §2.0 写方法幂等约定）
    }
    const entry = this.sessions.get(params.sessionId);
    if (entry) {
      entry.loop.cancel("archive"); // 运行中 turn 收敛（事件事实先行落 JSONL）
      if (entry.pending !== null) await entry.pending.catch(() => undefined);
    }
    assertNoRunningBackgroundTasks(this.toolDeps.background.list(), params.force);
    await this.options.storage.sessions.updateMeta(params.sessionId, {
      status: "archived",
      archivedAt: Date.now(),
    });
    this.sessions.delete(params.sessionId); // 只读化：写入类方法经 requireActive 以 SESSION_ARCHIVED 拒绝
    return { archived: true };
  }

  private async list(params: SessionListParams): Promise<unknown> {
    return listSessions({
      storage: this.options.storage,
      params,
      providerModel: this.providerModel,
      maxContextTokens: this.maxContextTokens,
    });
  }

  private async resume(params: SessionResumeParams): Promise<unknown> {
    const existing = this.sessions.get(params.sessionId);
    if (existing) {
      // 幂等：会话已 Active 直接返回当前快照（06 §2.1；多端收敛单写者）
      return { sessionId: params.sessionId, snapshot: await this.snapshotOf(params.sessionId, existing) };
    }
    const meta = await this.options.storage.sessions.get(params.sessionId);
    if (!meta) {
      throw new RpcCallError("SESSION_NOT_FOUND", `session not found: ${params.sessionId}`);
    }
    if (meta.status === "archived") {
      // 归档会话不可恢复（本波口径；06 §2.1 未定义归档恢复路径）
      throw new RpcCallError("SESSION_NOT_FOUND", `session is archived: ${params.sessionId}`);
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
    const workspaceRoot = (await this.options.storage.workspaceRootOf(meta.id)) ?? process.cwd();
    const llm = this.llmFor(undefined);
    const publish = this.publisher();
    const loop = createSessionLoop({
      sessionId: meta.id, mode: meta.mode, llm, storage: this.options.storage, publish,
      ...(this.options.systemPrompt !== undefined && { systemPrompt: this.options.systemPrompt }),
      tools: this.toolDeps, workspaceRoot, workspaceId: meta.workspaceId,
      initialHistory: replay.history,
      initialEventSeq: seedEventSeq(replay),
      initialEpoch: replay.epoch,
      ...(this.compaction !== undefined && { compaction: this.compaction }),
    });
    const entry: SessionEntry = {
      loop, llm, providerId: this.providerId,
      workspaceHash: meta.workspaceId, mode: meta.mode, workspaceRoot, pending: null,
    };
    this.sessions.set(meta.id, entry);
    return { sessionId: meta.id, snapshot: await this.snapshotOf(meta.id, entry) };
  }

  // system 域（06 §2.8）
  /** 优雅停机：取消活动 turn → 等待收敛（flush）→ 断开 MCP → 关闭存储。 */
  private async shutdown(params: SystemShutdownParams): Promise<unknown> {
    this.shuttingDown = true;
    const pending: Array<Promise<unknown>> = [];
    for (const entry of this.sessions.values()) {
      entry.loop.cancel(params.reason ?? "shutdown");
      if (entry.pending !== null) pending.push(entry.pending.catch(() => undefined));
    }
    await Promise.all(pending);
    await this.mcp?.close();
    await this.options.onShutdown?.();
    return { shuttingDown: true as const };
  }

  // 内部
  private publisher(): SessionEventPublisher {
    return (event) => {
      if (!this.binding) {
        console.error("[novacode/server] event dropped: no transport attached", event.name);
        return;
      }
      this.binding.publish(event);
    };
  }

  private buildCompaction(): CompactionOptions | undefined {
    const raw = this.options.compaction;
    if (raw === undefined) {
      return undefined;
    }
    return {
      contextWindowTokens: this.maxContextTokens,
      ...(raw.thresholdRatio !== undefined && { thresholdRatio: raw.thresholdRatio }),
      ...(raw.keepRecentCount !== undefined && { keepRecentCount: raw.keepRecentCount }),
    };
  }

  private llmFor(providerId: string | undefined): LlmPort | null {
    if (providerId === undefined || providerId === this.providerId) {
      return this.llm;
    }
    const cached = this.llmByProvider.get(providerId);
    if (cached !== undefined) {
      return cached;
    }
    const runtime = this.config.providerRuntime(providerId); // 未知 id → CONFIG_PROVIDER_NOT_FOUND
    if (runtime === null) {
      throw new RpcCallError("CONFIG_PROVIDER_NOT_FOUND", `provider not found: ${providerId}`);
    }
    const client = new LlmClient({
      provider: {
        id: runtime.id,
        name: runtime.name,
        baseURL: runtime.baseURL,
        model: runtime.model,
        maxContextTokens: runtime.maxContextTokens ?? 32768,
        apiKeyRef: null,
      },
      apiKey: runtime.apiKey ?? null,
    });
    this.llmByProvider.set(providerId, client);
    return client;
  }

  private async requireActive(sessionId: string): Promise<SessionEntry> {
    const entry = this.sessions.get(sessionId);
    if (entry) return entry;
    const meta = await this.options.storage.sessions.get(sessionId);
    if (meta?.status === "archived") {
      throw new RpcCallError("SESSION_ARCHIVED", `session is archived (read-only): ${sessionId}`);
    }
    throw new RpcCallError("SESSION_NOT_FOUND", `session not found or not resumed: ${sessionId}`);
  }

  private async snapshotOf(sessionId: string, entry: SessionEntry): Promise<SessionSnapshotPayload> {
    return buildSessionSnapshot({
      storage: this.options.storage,
      sessionId,
      lastSeq: entry.loop.lastEventSeq,
      phase: entry.loop.phase,
      model: this.providerModel,
      activeProviderId: this.providerId,
      maxContextTokens: this.maxContextTokens,
    });
  }
}
