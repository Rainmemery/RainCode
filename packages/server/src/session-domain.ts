/**
 * SessionDomain：session 域 T2.6 新增三方法（06-api-spec §2.1 / AC-9 / AC-10）。
 *
 * - session.rename（AC-9）：会话重命名——title 已在 schema 层 trim（1~200），sessions.title 落库，
 *   session.list 读库即得（05 §3.3 投影列）；
 * - session.fork（AC-9）：从既有会话分叉新会话——源会话运行中 turn 先取消收束（对齐 archive 先例）、
 *   新会话行 kind="main" + parent_session_id 回链（05 §3.3）、全量历史消息逐条落盘复制（仅内存注入
 *   会使 fork 会话 resume 时丢历史，05 §4.4；消息 id 原样保留以维持 toolCallId 关联完整）、
 *   writeCheckpoint 建立恢复点（resume O(1) 定位基准，05 §4.3）；fork 后新会话独立演进；
 * - session.usage（AC-10）：会话累计用量读数 + 活跃 Provider 单价费用估算（两者齐备才算 cost，
 *   任一单价缺失则省略 costEstimateUsd 字段；估算口径 input×inputPrice/1M + output×outputPrice/1M，
 *   非精确计费）；
 * - 装配依赖经构造注入（AgentService 持有的会话表/LLM 工厂/事件出口闭包），内核装配单点复用
 *   createSessionLoop（04 §2.4 铁律 4，杜绝第二套装配）。
 */
import { RpcCallError } from "@raincode/rpc";
import { buildSessionCreatedEvent } from "@raincode/shared";
import type {
  SessionForkParams,
  SessionForkResult,
  SessionRenameParams,
  SessionRenameResult,
  SessionUsageParams,
  SessionUsageResult,
} from "@raincode/shared";
import type { CompactionOptions, LlmPort, SessionEventPublisher, ToolPhaseDeps } from "@raincode/agent-core";
import type { Storage } from "@raincode/storage";
import type { BackgroundTaskRegistry } from "@raincode/tools";
import type { ConfigDomain } from "./config-domain.js";
import type { MemoryRuntime } from "./memory-runtime.js";
import { memoryLoopEnhancements } from "./memory-runtime.js";
import { createSessionLoop } from "./session-support.js";
import type { SessionEntry } from "./session-support.js";

/** 装配依赖（agent-service.buildMethods 注入；闭包指向 AgentService 活动状态）。 */
export interface SessionDomainDeps {
  storage: Storage;
  /** AgentService.sessions 同一 Map 实例（fork 读取源会话运行态并登记新会话）。 */
  sessions: Map<string, SessionEntry>;
  /** config 域（session.usage 的活跃 Provider 单价取数）。 */
  config: ConfigDomain;
  llmFor: (providerId: string | undefined) => LlmPort | null;
  publisher: () => SessionEventPublisher;
  systemPrompt?: string;
  tools: ToolPhaseDeps & { background: BackgroundTaskRegistry };
  memory: MemoryRuntime | null;
  /** auto-compact 选项（undefined = 不启用；与 create/resume 同口径）。 */
  compaction?: CompactionOptions;
}

export class SessionDomain {
  constructor(private readonly deps: SessionDomainDeps) {}

  /** 方法表接线（agent-service buildMethods 展开；schema 校验仍由 METHOD_SCHEMAS 单点承担）。 */
  methods(register: (method: string, handler: (params: unknown) => Promise<unknown>) => unknown): Record<string, unknown> {
    return {
      "session.rename": register("session.rename", async (params) => this.rename(params as SessionRenameParams)),
      "session.fork": register("session.fork", async (params) => this.fork(params as SessionForkParams)),
      "session.usage": register("session.usage", async (params) => this.usage(params as SessionUsageParams)),
    };
  }

  // ---------------------------------------------------------------------------

  /** session.rename（AC-9）：存在校验（SESSION_NOT_FOUND）→ title 落库 → 返回。 */
  private async rename(params: SessionRenameParams): Promise<SessionRenameResult> {
    const meta = await this.deps.storage.sessions.get(params.sessionId);
    if (!meta) {
      throw new RpcCallError("SESSION_NOT_FOUND", `session not found: ${params.sessionId}`);
    }
    await this.deps.storage.sessions.updateMeta(params.sessionId, { title: params.title });
    return { sessionId: params.sessionId, title: params.title };
  }

  /**
   * session.fork（AC-9 / 06 §2.1）：源会话校验 → 运行中 turn 取消收束 → 新会话行（回链）→
   * 全量历史逐条 appendMessage 落盘 → writeCheckpoint 恢复点 → 内核循环装配（与 resume 同形态：
   * initialHistory 内存重建 + rpc seq 续起点）→ sessions.set → publish session.created。
   */
  private async fork(params: SessionForkParams): Promise<SessionForkResult> {
    const { storage } = this.deps;
    const source = await storage.sessions.get(params.sessionId);
    if (!source) {
      throw new RpcCallError("SESSION_NOT_FOUND", `session not found: ${params.sessionId}`);
    }
    // 源会话运行中 turn 先收束（事件事实先行落 JSONL；fork 后新会话才安全复制历史，archive 先例）
    const entry = this.deps.sessions.get(params.sessionId);
    if (entry) {
      entry.loop.cancel("fork");
      if (entry.pending !== null) await entry.pending.catch(() => undefined);
    }
    // 新会话：同 workspace、kind="main"、parent_session_id 回链源会话（05 §3.3 sessions 列）
    const workspaceRoot = (await storage.workspaceRootOf(source.id)) ?? process.cwd();
    const forked = await storage.createSession({
      workspaceHash: source.workspaceId,
      workspaceRoot,
      kind: "main",
      parentSessionId: source.id,
      title: params.title ?? `fork: ${source.title}`,
      mode: source.mode,
    });
    // 全量历史复制（必须落盘：JSONL 是会话历史唯一真源，05 §1.2；消息 id 原样保留）
    const replay = await storage.resumeSession(source.id);
    let lastSeq = 1; // 无历史时头行即 seq 1（05 §4.2）
    for (const message of replay.history) {
      const appended = await storage.appendMessage(forked.id, message);
      if (appended.accepted) lastSeq = appended.seq;
    }
    // 恢复点：checkpoint 落盘并回写 messageCount/checkpointOffset/epoch（05 §4.3）
    const checkpoint = await storage.writeCheckpoint(forked.id, {
      mode: source.mode, todo: [], messageCount: replay.history.length,
    });
    const publish = this.deps.publisher();
    publish({
      name: "session.created",
      payload: buildSessionCreatedEvent({
        seq: 1, sessionId: forked.id, title: forked.title, workspaceRoot,
        mode: forked.mode, createdAt: forked.createdAt, kind: "main", parentSessionId: source.id,
      }),
    });
    // 内核循环装配：对齐 resume 形态（initialHistory + rpc seq 续起点；epoch 起点缺省 0 = fork 文件头行）
    const llm = this.deps.llmFor(entry?.providerId); // 源会话活跃时继承其 Provider 绑定；否则主客户端
    const loop = createSessionLoop({
      sessionId: forked.id, mode: forked.mode, llm, storage, publish,
      ...(await memoryLoopEnhancements(this.deps.memory, this.deps.systemPrompt, workspaceRoot, forked.id, source.workspaceId)),
      tools: this.deps.tools, workspaceRoot, workspaceId: source.workspaceId,
      initialHistory: replay.history,
      initialEventSeq: checkpoint.accepted ? checkpoint.seq : lastSeq,
      ...(this.deps.compaction !== undefined && { compaction: this.deps.compaction }),
    });
    this.deps.sessions.set(forked.id, {
      loop, llm, providerId: entry?.providerId ?? "default",
      workspaceHash: source.workspaceId, mode: forked.mode, workspaceRoot, pending: null,
    });
    return {
      sessionId: forked.id,
      parentSessionId: source.id,
      title: forked.title,
      messageCount: replay.history.length,
    };
  }

  /**
   * session.usage（AC-10 / 06 §2.1）：累计用量读数（sessions 投影列）+ 活跃 Provider 单价估算；
   * 读方法对归档会话同样可用（只读不写）。
   */
  private async usage(params: SessionUsageParams): Promise<SessionUsageResult> {
    const meta = await this.deps.storage.sessions.get(params.sessionId);
    if (!meta) {
      throw new RpcCallError("SESSION_NOT_FOUND", `session not found: ${params.sessionId}`);
    }
    const { providers, activeProviderId } = this.deps.config.providersList();
    const active = providers.find((provider) => provider.id === activeProviderId);
    const inputPrice = active?.inputPricePerMtok;
    const outputPrice = active?.outputPricePerMtok;
    // 估算口径（06 §2.1）：input×inputPrice/1M + output×outputPrice/1M，保留 6 位小数；
    // 任一单价缺失则省略字段（undefined 条件展开），不用不完整单价给误导性估算
    const costEstimateUsd =
      inputPrice !== undefined && outputPrice !== undefined
        ? Number(((meta.inputTokens * inputPrice + meta.outputTokens * outputPrice) / 1_000_000).toFixed(6))
        : undefined;
    return {
      sessionId: params.sessionId,
      inputTokens: meta.inputTokens,
      outputTokens: meta.outputTokens,
      turnsCount: meta.turnsCount,
      ...(costEstimateUsd !== undefined && { costEstimateUsd }),
    };
  }
}
