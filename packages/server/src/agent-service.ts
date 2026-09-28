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
} from "@novacode/shared";
import { RpcCallError, createServiceBinding } from "@novacode/rpc";
import type { IMessageTransport, RpcMethodHandler, RpcServiceBinding } from "@novacode/rpc";
import { LlmClient } from "@novacode/llm";
import { Storage, StorageError, computeWorkspaceHash } from "@novacode/storage";
import type { SessionResume } from "@novacode/storage";
import { SessionTurnLoop } from "@novacode/agent-core";
import type { LlmPort, SessionEventPublisher, TurnOutcome } from "@novacode/agent-core";

/** Provider 运行时配置（apiKey 已由调用方解析为明文注入；绝不落日志）。 */
export interface ProviderRuntimeConfig {
  id?: string;
  name: string;
  baseURL: string;
  model: string;
  apiKey?: string | null;
  maxContextTokens?: number;
}

export interface AgentServiceOptions {
  storage: Storage;
  provider?: ProviderRuntimeConfig | null;
  /** 系统提示（随请求注入；缺省不注入）。 */
  systemPrompt?: string;
}

interface SessionEntry {
  loop: SessionTurnLoop;
  workspaceHash: string;
  mode: CollaborationMode;
}

export class AgentService {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly llm: LlmPort | null;
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
    const loop = new SessionTurnLoop({
      sessionId: meta.id,
      mode: meta.mode,
      llm: this.llm,
      storage: this.options.storage,
      publish: this.publisher(),
      systemPrompt: this.options.systemPrompt,
      onDiagnostic: (message, err) => console.error(`[novacode/server] ${message}`, err ?? ""),
    });
    this.sessions.set(meta.id, { loop, workspaceHash: workspace.hash, mode: meta.mode });
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
    const loop = new SessionTurnLoop({
      sessionId: meta.id,
      mode: meta.mode,
      llm: this.llm,
      storage: this.options.storage,
      publish: this.publisher(),
      systemPrompt: this.options.systemPrompt,
      initialHistory: replay.history,
      // 跨进程 rpc seq 连续性为 best-effort：delta 不落盘导致原 seq 不可完全重建；
      // 以持久事件/检查点的最大行号续起点，端层以 snapshot.lastSeq 为准继续消费（06 §3.3）。
      initialEventSeq: seedEventSeq(replay),
      onDiagnostic: (message, err) => console.error(`[novacode/server] ${message}`, err ?? ""),
    });
    const entry: SessionEntry = { loop, workspaceHash: meta.workspaceId, mode: meta.mode };
    this.sessions.set(meta.id, entry);
    return { sessionId: meta.id, snapshot: await this.buildSnapshot(meta.id, entry) };
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
