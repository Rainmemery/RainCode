/**
 * AgentService：服务层唯一组装点（04-architecture §2.4 铁律 4 / 06-api-spec §2）。
 * 组装 Storage + LlmClient + SessionTurnLoop（agent-core），经 createServiceBinding 暴露控制面；
 * 方法表 schema 全部引用 @raincode/shared METHOD_SCHEMAS（04 ADR-07）；事件由 agent-core 构造 payload。
 */
import { stat } from "node:fs/promises";
import {
  METHOD_SCHEMAS,
  PROTOCOL_VERSION,
  V1_CAPABILITIES,
  buildSessionCreatedEvent,
} from "@raincode/shared";
import type {
  SessionArchiveParams,
  SessionCompactParams,
  SessionCreateParams,
  SessionListParams,
  SessionResumeParams,
  SessionSendParams,
  SessionSetModeParams,
  SessionSteerParams,
  SystemShutdownParams,
} from "@raincode/shared";
import { RpcCallError, createServiceBinding } from "@raincode/rpc";
import type { IMessageTransport, RpcMethodHandler, RpcServiceBinding } from "@raincode/rpc";
import { Storage } from "@raincode/storage";
import { createBuiltinTools, ToolExecutor } from "@raincode/tools";
import type { BackgroundTaskRegistry, Executor, ToolRegistry } from "@raincode/tools";
import { alwaysAllowApprover, alwaysDenyApprover, createMetadataPermissionPort } from "@raincode/agent-core";
import type { AskUserChannelRequest, CompactionOptions, LlmPort, PermissionPort, SessionEventPublisher, ToolPhaseDeps, TurnOutcome } from "@raincode/agent-core";
import { ConfigDomain } from "./config-domain.js";
import { ConfigStore } from "./config-store.js";
import { ToolDomain } from "./tool-domain.js";
import { SessionDomain } from "./session-domain.js";
import { appVersion } from "./app-version.js";
import { buildLlmClient } from "./llm-factory.js";
import {
  assertNoRunningBackgroundTasks,
  buildCompactionOptions,
  compactSession,
  createSessionLoop,
  eventPublisher,
  listSessions,
  recordUsage,
  resumeSessionFlow,
} from "./session-support.js";
import type { SessionEntry } from "./session-support.js";
import { PermissionRuntime } from "./permission-runtime.js";
import type { PermissionPolicy, PermissionRuntimeOptions } from "./permission-runtime.js";
import { McpRuntime } from "./mcp-runtime.js";
import { SubagentRuntime } from "./subagent-runtime.js";
import { MemoryRuntime, memoryLoopEnhancements } from "./memory-runtime.js";

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
  /** 沙箱执行域（M3 T3.1：node.ts 按 config.json sandbox.executor 解析注入；缺省 local）。 */
  executor?: Executor;
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
  /** 子代理域装配（02 §4；缺省 = 不启用 subagent 域；workspaceRoot 为 workspace 层 profiles 判定域）。 */
  subagent?: { workspaceRoot?: string };
  /** memory 域装配（02 §7；缺省 = 不启用 memory 域；workspaceRoot 为 promote 反查兜底域）。 */
  memory?: { workspaceRoot?: string };
  /** system.shutdown 的存储关闭回调（node 注入；缺省跳过——传输关闭由持有方承担）。 */
  onShutdown?: () => Promise<void>;
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
  /** 子代理域（06 §2.5；缺省未装配）。 */
  private readonly subagent: SubagentRuntime | null;
  /** memory 域（06 §2.6；缺省未装配）。 */
  private readonly memory: MemoryRuntime | null;
  private binding: RpcServiceBinding | null = null;
  private shuttingDown = false;

  readonly providerModel: string;
  readonly providerId: string;
  readonly maxContextTokens: number;
  /** auto-compact 装配（02 §1.2.5；undefined = 不启用）。 */
  private readonly compaction: CompactionOptions | undefined;

  constructor(private readonly options: AgentServiceOptions) {
    const provider = options.provider ?? null;
    this.llm = provider ? buildLlmClient(provider) : null;
    this.providerModel = provider?.model ?? "";
    this.providerId = provider?.id ?? "default";
    this.maxContextTokens = provider?.maxContextTokens ?? 32768;
    this.compaction = buildCompactionOptions(this.options.compaction, this.maxContextTokens);
    this.config = new ConfigDomain(new ConfigStore({ dataRoot: options.storage.dataRoot }));

    // 工具系统组装（server 唯一组装点）；沙箱执行域经 ToolRuntimeConfig.executor 注入（node.ts 解析 config.json sandbox）
    const builtin = createBuiltinTools(options.tools?.executor !== undefined ? { executor: options.tools.executor } : {});
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
      ...(this.permission !== null && { askUser: (q: AskUserChannelRequest) => this.permission!.askUser(q) }), // T2.7 P1 ask_user_question 通道（ApprovalBroker 闭环复用；default-allow 无装配 → TOOL_UNAVAILABLE）
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
    // 子代理域（02 §4）：agent 工具进同一 registry；子会话宿主经 SubagentLoopHost 注入（ADR-06）
    this.subagent =
      options.subagent === undefined
        ? null
        : new SubagentRuntime({
            storage: options.storage,
            toolDeps: this.toolDeps,
            llmFor: (model) => this.llmForModel(model),
            dataRoot: options.storage.dataRoot,
            workspaceRoot: options.subagent.workspaceRoot ?? null,
            publish: (event) => this.binding?.publish(event),
          });
    // memory 域（02 §7 / 06 §2.6）：未配置 → 不注册方法/不注入 MEMORY.md/不挂抽取钩子
    this.memory =
      options.memory === undefined ? null
        : new MemoryRuntime({ storage: options.storage, llmFor: () => this.llm,
            ...(options.memory.workspaceRoot !== undefined && { workspaceRoot: options.memory.workspaceRoot }) });
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
    void this.subagent?.dispose(); // 子代理级联停止 + agent 工具注销（异步收敛）
    void this.memory?.dispose(); // memory 域无长驻资源（dispose 最小实现）
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
      // session 域 T2.6 新增三方法（AC-9/AC-10；实现见 session-domain.ts，装配单点 createSessionLoop 复用）
      ...new SessionDomain({
        storage: this.options.storage, sessions: this.sessions, config: this.config,
        llmFor: (providerId) => this.llmFor(providerId), publisher: () => this.publisher(),
        systemPrompt: this.options.systemPrompt, tools: this.toolDeps, memory: this.memory,
        compaction: this.compaction,
      }).methods(register),
      ...this.config.methods(register),
      ...this.toolDomain.methods(register),
      // MCP 域未装配时不暴露（METHOD_SCHEMAS 已登记，缺 handler 调用期报 method not found）
      ...(this.mcp !== null ? this.mcp.methods(register) : {}),
      // 子代理域未装配时不暴露（同上；06 §2.5 subagent 域 4 方法）
      ...(this.subagent !== null ? this.subagent.methods(register) : {}),
      ...(this.memory !== null ? this.memory.methods(register) : {}), // memory 域未装配不暴露（同上）
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
      // 未传 title（桌面端新建会话）→ 落库缺省名：空标题会使会话列表渲染出无文字行（场景 5 走查发现）
      title: params.title ?? "新会话",
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
      ...((await memoryLoopEnhancements(this.memory, this.options.systemPrompt, params.workspaceRoot, meta.id, workspace.hash))),
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
        "no provider configured: set --base-url/--model, RAINCODE_PROVIDER_* env, config/providers.local.json, or config.providers.add",
      );
    }
    const admission = entry.loop.submit({ text: params.input.text, attachments: params.input.attachments });
    entry.pending = admission.done;
    // turn 结果的旁路消费：usage 累计进 sessions 投影列（session.list 的 contextUsage 数据源）
    void admission.done.then((outcome: TurnOutcome) => {
      if (outcome.status === "completed" && outcome.usage !== undefined) {
        void recordUsage(this.options.storage, params.sessionId, outcome.usage).catch(
          (err: unknown) => console.error("[raincode/server] failed to record usage", err),
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
    await this.subagent?.stopAll("archive"); // 子代理级联兜底（02 §4.4：agent 工具 ctx.signal 已覆盖 turn 内路径）
    assertNoRunningBackgroundTasks(this.toolDeps.background.list(), params.force);
    await this.memory?.onArchive(params.sessionId, meta.workspaceId); // 会话结束抽取（02 §7.4：失败仅诊断，幂等 05 §5.4 settings 键）
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
    // 主流程在 session-support.resumeSessionFlow（方法族拆分）；本层只注入装配依赖
    return await resumeSessionFlow({
      storage: this.options.storage,
      sessions: this.sessions,
      llmFor: (id) => this.llmFor(id),
      publishFactory: () => this.publisher(),
      toolDeps: this.toolDeps,
      memory: this.memory,
      ...(this.options.systemPrompt !== undefined && { systemPrompt: this.options.systemPrompt }),
      ...(this.compaction !== undefined && { compaction: this.compaction }),
      providerId: this.providerId,
      providerModel: this.providerModel,
      maxContextTokens: this.maxContextTokens,
      permissionPending: (sessionId) => this.permission?.pendingGrantsOf(sessionId) ?? [],
      sessionId: params.sessionId,
    });
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
    await this.subagent?.stopAll(params.reason ?? "shutdown"); // 子代理级联兜底（02 §4.4）
    await this.mcp?.close();
    await this.options.onShutdown?.();
    return { shuttingDown: true as const };
  }

  // 内部
  private publisher(): SessionEventPublisher {
    return eventPublisher(this.binding);
  }

  private llmFor(providerId: string | undefined): LlmPort | null {
    // AC-11（06 §2.3）：缺省绑定 = config.activeProviderId（switch 后新会话走新活跃项），
    // 无 active 或 active 即主 Provider 时回退主客户端（CLI 直传 provider 场景兼容）。
    const requested = providerId === undefined ? this.config.providersList().activeProviderId : providerId;
    if (requested === undefined || requested === null || requested === this.providerId) return this.llm;
    const cached = this.llmByProvider.get(requested);
    if (cached !== undefined) return cached;
    const runtime = this.config.providerRuntime(requested); // 未知 id → CONFIG_PROVIDER_NOT_FOUND
    if (runtime === null) {
      throw new RpcCallError("CONFIG_PROVIDER_NOT_FOUND", `provider not found: ${requested}`);
    }
    const client = buildLlmClient(runtime);
    this.llmByProvider.set(requested, client);
    return client;
  }

  /** 子代理 profile.model（模型名）→ LLM 客户端（02 §4.3）：缺省/同主模型 → 主客户端；否则按模型名匹配 config 域 Provider。 */
  private llmForModel(model: string | undefined): LlmPort | null {
    if (model === undefined || model === this.providerModel) return this.llm;
    const match = this.config.providersList().providers.find((provider) => provider.model === model);
    if (match === undefined) {
      throw new RpcCallError("CONFIG_PROVIDER_NOT_FOUND", `no provider serves model: ${model}`);
    }
    return this.llmFor(match.id);
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
}
