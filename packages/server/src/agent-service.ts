/**
 * AgentService：服务层唯一组装点（04-architecture §2.4 铁律 4 / 06-api-spec §2）。
 * 组装 Storage + LlmClient + SessionTurnLoop（agent-core），经 createServiceBinding 暴露控制面；
 * 方法表 schema 全部引用 @raincode/shared METHOD_SCHEMAS（04 ADR-07）；事件由 agent-core 构造 payload。
 */
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
import { RpcCallError, createServiceBinding, type IMessageTransport, type RpcMethodHandler, type RpcServiceBinding } from "@raincode/rpc";
import { Storage } from "@raincode/storage";
import { createBuiltinTools, ToolExecutor, type BackgroundTaskRegistry } from "@raincode/tools";
import { alwaysAllowApprover, alwaysDenyApprover, createMetadataPermissionPort, type AskUserChannelRequest, type CompactionOptions, type LlmPort, type MicrocompactOptions, type PermissionPort, type SessionEventPublisher, type ToolPhaseDeps, type TurnOutcome } from "@raincode/agent-core";
import { ConfigDomain } from "./config-domain.js";
import { ConfigStore } from "./config-store.js";
import { ToolDomain } from "./tool-domain.js";
import { SessionDomain } from "./session-domain.js";
import { appVersion } from "./app-version.js";
import { buildLlmClient, resolveLlmForModel, resolveLlmForProvider, type LlmProviderResolverDeps } from "./llm-factory.js";
import {
  assertNoRunningBackgroundTasks,
  buildCompactionOptions,
  compactSession,
  createSessionLoop,
  listSessions,
  assertExistingWorkspace,
  recordUsage,
  requireActiveSession,
  resumeSessionFlow,
  shutdownService,
  type SessionEntry,
} from "./session-support.js";
import { PermissionRuntime } from "./permission-runtime.js";
import type { McpRuntime } from "./mcp-runtime.js";
import type { PluginRuntime } from "./plugin-runtime.js";
import type { SubagentRuntime } from "./subagent-runtime.js";
import type { SkillRuntime } from "./skill-runtime.js";
import { HooksRuntime } from "./hooks-runtime.js";
import type { McpToolCatalog } from "./mcp-tool-catalog.js";
import { memoryLoopEnhancements, type MemoryRuntime } from "./memory-runtime.js";
import { buildRuntimeDomains } from "./runtime-domains.js";
import type { SectionEditHooks } from "@raincode/memory";

export type { PermissionConfig, ProviderRuntimeConfig, ToolRuntimeConfig } from "./service-config.js";
import type { PermissionConfig, ProviderRuntimeConfig, ToolRuntimeConfig } from "./service-config.js";

export interface AgentServiceOptions {
  storage: Storage;
  provider?: ProviderRuntimeConfig | null;
  /** 系统提示（随请求注入；缺省不注入）。 */
  systemPrompt?: string;
  /** 工具系统；缺省内置工具集。 */
  tools?: ToolRuntimeConfig;
  /** 权限策略；缺省 normal（五级判定链 + 审批闭环）。 */
  permission?: PermissionConfig;
  /** auto-compact 装配（02 §1.2.5；缺省 = 不启用；contextWindowTokens 取 Provider maxContextTokens；microcompact 预剪枝选项随 compaction 传入，T5.4）。 */
  compaction?: { thresholdRatio?: number; keepRecentCount?: number; microcompact?: MicrocompactOptions };
  /** MCP 域装配（02 §3；缺省 = 不启用 mcp 域；workspaceRoot 为 project 层 mcp.json 判定域；toolSearch=false 关闭工具目录化）。 */
  mcp?: { workspaceRoot?: string; toolSearch?: boolean };
  /** plugins 域装配（06 §2.10 v1.8；缺省 = 不启用；数据根取 storage.dataRoot）。 */
  plugins?: Record<string, never>;
  /** 子代理域装配（02 §4；缺省 = 不启用 subagent 域；workspaceRoot 为 workspace 层 profiles 判定域）。 */
  subagent?: { workspaceRoot?: string };
  /** memory 域装配（02 §7；缺省 = 不启用 memory 域；workspaceRoot 为 promote 反查兜底域）；
   * sectionEditHooks 透传 ProjectMemoryService（宿主/测试确定性并发窗口注入，见 memory 包）。 */
  memory?: { workspaceRoot?: string; sectionEditHooks?: SectionEditHooks };
  /** skills 域装配（T3.4；缺省 = 不启用。workspace 层技能目录按会话 workspaceRoot 逐会话解析，无装配期参数）。 */
  skills?: Record<string, never>;
  /** hooks 域装配（T5.1；缺省 = 不启用。user 层 <dataRoot>/hooks.json + project 层 <workspace>/.raincode/hooks.json 双源）。 */
  hooks?: Record<string, never>;
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
  private readonly plugins: PluginRuntime | null;
  /** 子代理域（06 §2.5；缺省未装配）。 */
  private readonly subagent: SubagentRuntime | null;
  /** memory 域（06 §2.6；缺省未装配）。 */
  private readonly memory: MemoryRuntime | null;
  /** skills 域（06 §2.9；缺省未装配）。 */
  private readonly skills: SkillRuntime | null;
  /** hooks 域（06 §2.12；缺省未装配）。 */
  private readonly hooks: HooksRuntime | null;
  /** MCP 工具目录（T5.6；mcp 域未装配或 toolSearch=false → null，目录模式不生效）。 */
  private readonly mcpCatalog: McpToolCatalog | null;
  /** 活跃绑定集（T3.8：Web 多连接宿主逐连接 attach，事件扇出到全部绑定；stdio/in-memory 单连接）。 */
  private readonly bindings = new Set<RpcServiceBinding>();
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
    // 五域装配（T3.8 下沉 runtime-domains.ts，单文件 ≤500 行治理）：构造与接线集中一处
    const domains = buildRuntimeDomains(
      {
        mcp: options.mcp,
        plugins: options.plugins,
        subagent: options.subagent,
        memory: options.memory,
        skills: options.skills,
      },
      {
        registry,
        background: builtin.background,
        toolExecutor: this.toolDeps.executor,
        toolDeps: this.toolDeps,
        storage: options.storage,
        llm: this.llm,
        llmForModel: (model) => this.llmForModel(model),
        publish: (event) => this.publishEvent(event),
        submitTurn: (sessionId, text) => this.submitTurn(sessionId, text),
        maxContextTokens: this.maxContextTokens,
      },
    );
    this.mcp = domains.mcp;
    this.plugins = domains.plugins;
    this.subagent = domains.subagent;
    this.memory = domains.memory;
    this.skills = domains.skills;
    this.mcpCatalog = domains.mcpCatalog;
    // T5.1 hooks 域装配：user/project 双源 hooks.json + trust 授信（settings 表）；port 注入 turn-loop
    this.hooks = options.hooks !== undefined
      ? new HooksRuntime({
          dataRoot: options.storage.dataRoot,
          storage: options.storage,
          workspaceRootOf: (sessionId) => this.options.storage.workspaceRootOf(sessionId),
        })
      : null;
    // 模型侧工具通道（expandSkill/searchHistory/searchMcpTools）接线已集中 buildRuntimeDomains
  }

  /**
   * 绑定传输并暴露方法表（可多次 attach：每次连接一个绑定，事件扇出到全部活跃绑定——
   * Web 多连接语义；options.authGate 开启连接级鉴权门，见 06 §6.3）。
   */
  attach(transport: IMessageTransport, options?: { authGate?: { method: string } }): RpcServiceBinding {
    const binding = createServiceBinding(transport, {
      methods: this.buildMethods(),
      ...(options?.authGate !== undefined && { authGate: options.authGate }),
    });
    this.bindings.add(binding);
    return binding;
  }

  /** 解除一个绑定（Web 宿主在连接关闭时调用）：移出扇出集并停止受理。 */
  detach(binding: RpcServiceBinding): void {
    this.bindings.delete(binding);
    binding.close();
  }

  close(): void {
    for (const binding of this.bindings) binding.close();
    this.bindings.clear();
    this.permission?.close();
    void this.mcp?.close(); // MCP 子进程/连接异步收敛
    void this.subagent?.dispose(); // 子代理级联停止 + agent 工具注销（异步收敛）
    void this.memory?.dispose(); // memory 域无长驻资源（dispose 最小实现）
    void this.plugins?.dispose(); // 插件 deactivate + 工具注销（异步收敛）
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
        skills: this.skills, compaction: this.compaction, mcpToolCatalog: this.mcpCatalog,
      }).methods(register),
      ...this.config.methods(register),
      ...this.toolDomain.methods(register),
      // MCP 域未装配时不暴露（METHOD_SCHEMAS 已登记，缺 handler 调用期报 method not found）
      ...(this.mcp !== null ? this.mcp.methods(register) : {}),
      // 子代理域未装配时不暴露（同上；06 §2.5 subagent 域 4 方法）
      ...(this.subagent !== null ? this.subagent.methods(register) : {}),
      ...(this.memory !== null ? this.memory.methods(register) : {}), // memory 域未装配不暴露（同上）
      ...(this.skills !== null ? this.skills.methods(register) : {}), // skills 域未装配不暴露（同上）
      ...(this.plugins !== null ? this.plugins.methods(register) : {}), // plugins 域未装配不暴露（同上）
      ...(this.hooks !== null ? this.hooks.methods(register) : {}), // hooks 域未装配不暴露（同上；06 §2.12 hooks 域 3 方法）
      // default-allow 策略未装配 permission 域（requirePermission 在调用期报 PC_GRANT_NOT_FOUND）
      ...(this.permission !== null ? this.permission.methods(register) : {}),
    };
  }

  // session 域（06 §2.1）
  private async createSession(params: SessionCreateParams): Promise<unknown> {
    await assertExistingWorkspace(params.workspaceRoot);
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
    const memoryExtras = await memoryLoopEnhancements(this.memory, this.options.systemPrompt, params.workspaceRoot, meta.id, workspace.hash);
    const loop = createSessionLoop({
      sessionId: meta.id, mode: meta.mode, llm, storage: this.options.storage, publish,
      ...memoryExtras,
      // T4.4：skills 域装配时注入技能目录逐 turn 重发布的系统提示提供者（热变更 digest 检测）
      ...(this.skills !== null && { systemPromptProvider: this.skills.systemPromptProvider(meta.id, params.workspaceRoot, memoryExtras.systemPrompt) }),
      tools: this.toolDeps, workspaceRoot: params.workspaceRoot, workspaceId: workspace.hash,
      ...(this.hooks !== null && { hooks: this.hooks.port }), // T5.1：hooks 生命周期接线（四事件 dispatch 单点）
      ...(this.mcpCatalog !== null && { mcpToolCatalog: this.mcpCatalog }), // T5.6：MCP 工具目录化载荷端口
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
    return this.submitTurn(params.sessionId, params.input.text, params.input.attachments);
  }

  /**
   * turn 提交链（session.send / skills.invoke 共用，06 §2.1/§2.9）：
   * requireActive → provider 缺席拒绝 → 受理即返 + usage 旁路累计（session.list 的 contextUsage 数据源）。
   */
  private async submitTurn(sessionId: string, text: string, attachments?: SessionSendParams["input"]["attachments"]): Promise<unknown> {
    const entry = await this.requireActive(sessionId);
    if (entry.llm === null) {
      throw new RpcCallError(
        "CONFIG_PROVIDER_NOT_FOUND",
        "no provider configured: set --base-url/--model, RAINCODE_PROVIDER_* env, config/providers.local.json, or config.providers.add",
      );
    }
    const admission = entry.loop.submit({ text, attachments });
    entry.pending = admission.done;
    // turn 结果的旁路消费：usage 累计进 sessions 投影列
    void admission.done.then((outcome: TurnOutcome) => {
      if (outcome.status === "completed" && outcome.usage !== undefined) {
        void recordUsage(this.options.storage, sessionId, outcome.usage).catch(
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
      skills: this.skills,
      ...(this.hooks !== null && { hooks: this.hooks.port }), // T5.1：resume 路径 hooks 生命周期接线
      ...(this.mcpCatalog !== null && { mcpToolCatalog: this.mcpCatalog }), // T5.6：目录化载荷端口（resume 同接线）
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
  /** 优雅停机：取消活动 turn → 等待收敛（flush）→ 断开 MCP → 关闭存储。
   *  公开给 node.close 复用同一条收敛链（T4.2：排空持久化写链后才关存储）；幂等（级联各域 close 均可重入）。 */
  shutdown(params: SystemShutdownParams): Promise<unknown> {
    this.shuttingDown = true;
    // 主流程在 session-support.shutdownService（方法族拆分）；本层只注入装配依赖
    return shutdownService({
      sessions: this.sessions.values(),
      subagent: this.subagent,
      mcp: this.mcp,
      plugins: this.plugins,
      onShutdown: this.options.onShutdown,
      reason: params.reason,
    });
  }

  // 内部
  /** 事件扇出（06 §3.3 fire-and-forget）：投递到全部活跃绑定；无绑定时丢弃并告警（session-support 原口径）。 */
  private publisher(): SessionEventPublisher {
    return (event) => {
      if (this.bindings.size === 0) {
        console.error("[raincode/server] event dropped: no transport attached", event.name);
        return;
      }
      for (const binding of this.bindings) binding.publish(event);
    };
  }

  /** 运行时域（mcp/plugins/subagent）事件出口：同 publisher 扇出，但不做空集告警（域事件可选）。 */
  private publishEvent(event: { name: string; payload: unknown }): void {
    for (const binding of this.bindings) binding.publish(event);
  }

  /** 解析依赖投影（llm-factory 下沉后的结构注入；providersList 每次现取反映 switch 后活跃项）。 */
  private llmResolverDeps(): LlmProviderResolverDeps {
    const list = this.config.providersList();
    return {
      primaryProviderId: this.providerId,
      primary: this.llm,
      cache: this.llmByProvider,
      activeProviderId: list.activeProviderId,
      findProviderByModel: (model) => list.providers.find((provider) => provider.model === model),
      providerRuntime: (id) => this.config.providerRuntime(id),
    };
  }

  /** session.create.providerId → LLM 客户端（AC-11 语义见 llm-factory.resolveLlmForProvider）。 */
  private llmFor(providerId: string | undefined): LlmPort | null {
    return resolveLlmForProvider(this.llmResolverDeps(), providerId);
  }

  /** 子代理 profile.model（模型名）→ LLM 客户端（02 §4.3；语义见 llm-factory.resolveLlmForModel）。 */
  private llmForModel(model: string | undefined): LlmPort | null {
    return resolveLlmForModel(this.llmResolverDeps(), model, this.providerModel);
  }

  private requireActive(sessionId: string): Promise<SessionEntry> {
    return requireActiveSession(this.sessions, this.options.storage, sessionId);
  }
}
