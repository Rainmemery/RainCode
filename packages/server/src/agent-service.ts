/**
 * AgentService：服务层唯一组装点（04-architecture §2.4 铁律 4 / 06-api-spec §2）。
 *
 * - 组装 Storage + LlmClient + SessionTurnLoop（agent-core），经 createServiceBinding 暴露控制面；
 *   transport 由端层注入（CLI in-memory / 未来桌面 stdio），server 不选择传输载体；
 * - 方法表 schema 全部引用 @novacode/shared METHOD_SCHEMAS（04 ADR-07：未登记即无法暴露）；
 *   M1 P0 22 方法全集：system 3 + session 8 + permission 2 + config 5（ConfigDomain 承接）+ tool 4；
 * - 会话事件（06 §3 数据面）由 agent-core 构造 payload（seq 会话内单调），经 binding.publish 发出；
 * - 业务错误以 RpcCallError(code, message) 抛出，binding 转换为 06 §4 结构化 error 应答。
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
import type { LlmPort, PermissionPort, SessionEventPublisher, SessionTurnLoop, ToolPhaseDeps, TurnOutcome } from "@novacode/agent-core";
import { ConfigDomain } from "./config-domain.js";
import { ConfigStore } from "./config-store.js";
import { ToolDomain } from "./tool-domain.js";
import { appVersion } from "./app-version.js";
import {
  assertNoRunningBackgroundTasks,
  buildSessionSnapshot,
  createSessionLoop,
  listSessions,
  recordUsage,
  seedEventSeq,
} from "./session-support.js";
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
  /** system.shutdown 的存储关闭回调（node 注入；缺省跳过——传输关闭由持有方承担）。 */
  onShutdown?: () => Promise<void>;
}

interface SessionEntry {
  loop: SessionTurnLoop;
  /** 会话绑定 LLM 端口（create 的 providerId 决定；resume 绑默认 Provider——限制申报见 resume）。 */
  llm: LlmPort | null;
  providerId: string;
  workspaceHash: string;
  mode: CollaborationMode;
  /** 工具执行 ctx 基准（session.create 传入；resume 经 storage 回查）。 */
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
  private binding: RpcServiceBinding | null = null;
  private shuttingDown = false;

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
        protocolVersion: PROTOCOL_VERSION,
        capabilities: [...V1_CAPABILITIES],
        serverTime: Date.now(),
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
      ...this.config.methods(register),
      ...this.toolDomain.methods(register),
      // default-allow 策略未装配 permission 域（requirePermission 在调用期报 PC_GRANT_NOT_FOUND）
      ...(this.permission !== null ? this.permission.methods(register) : {}),
    };
  }

  // ---------------------------------------------------------------------------
  // session 域（06 §2.1）
  // ---------------------------------------------------------------------------

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
    const llm = this.llmFor(params.providerId); // 显式 providerId 未知 → CONFIG_PROVIDER_NOT_FOUND
    const workspace = await this.options.storage.ensureWorkspace(params.workspaceRoot);
    const meta = await this.options.storage.createSession({
      workspaceHash: workspace.hash,
      workspaceRoot: params.workspaceRoot,
      title: params.title,
      mode: params.mode,
    });
    // project 权限规则判定域（首个会话的 workspace；02 §6.2 判定链第 4 级）
    this.permission?.setDefaultWorkspace(workspace.hash);
    const publish = this.publisher();
    // session.created（P0 事件；seq=1——JSONL 头行即创建事实的落盘形态，rpc 侧同序号广播）
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
    });
    this.sessions.set(meta.id, {
      loop,
      llm,
      providerId: params.providerId ?? this.providerId,
      workspaceHash: workspace.hash,
      mode: meta.mode,
      workspaceRoot: params.workspaceRoot,
      pending: null,
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

  /** 归档（06 §2.1 / 02 C4）：取消运行中 turn → flush → 后台任务检查 → status=archived（JSONL 不删除）。 */
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
    // P0 限制：会话级 Provider 绑定未持久化，resume 绑定默认 Provider（config.providers.switch 属 P1）
    const llm = this.llmFor(undefined);
    const publish = this.publisher();
    const loop = createSessionLoop({
      sessionId: meta.id, mode: meta.mode, llm, storage: this.options.storage, publish,
      ...(this.options.systemPrompt !== undefined && { systemPrompt: this.options.systemPrompt }),
      tools: this.toolDeps, workspaceRoot, workspaceId: meta.workspaceId,
      initialHistory: replay.history,
      // rpc seq 续起点 best-effort（delta 不落盘）；端层以 snapshot.lastSeq 为准继续消费（06 §3.3）
      initialEventSeq: seedEventSeq(replay),
    });
    const entry: SessionEntry = {
      loop,
      llm,
      providerId: this.providerId,
      workspaceHash: meta.workspaceId,
      mode: meta.mode,
      workspaceRoot,
      pending: null,
    };
    this.sessions.set(meta.id, entry);
    return { sessionId: meta.id, snapshot: await this.snapshotOf(meta.id, entry) };
  }

  // ---------------------------------------------------------------------------
  // system 域（06 §2.8）
  // ---------------------------------------------------------------------------

  /** 优雅停机：取消活动 turn → 等待收敛（flush）→ 关闭存储 → 应答 shuttingDown。 */
  private async shutdown(params: SystemShutdownParams): Promise<unknown> {
    this.shuttingDown = true;
    const pending: Array<Promise<unknown>> = [];
    for (const entry of this.sessions.values()) {
      entry.loop.cancel(params.reason ?? "shutdown");
      if (entry.pending !== null) pending.push(entry.pending.catch(() => undefined));
    }
    await Promise.all(pending);
    await this.options.onShutdown?.();
    return { shuttingDown: true as const };
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

  /** 会话 Provider 绑定：缺省/命中默认 → 构造期实例；config 域 Provider → 按需构建并缓存。 */
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

  /** 活动会话解析：内存缺失时回查存储——归档 → SESSION_ARCHIVED；不存在 → SESSION_NOT_FOUND。 */
  private async requireActive(sessionId: string): Promise<SessionEntry> {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      return entry;
    }
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
