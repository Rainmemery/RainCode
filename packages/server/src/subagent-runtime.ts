/**
 * SubagentRuntime：子代理域装配（06-api-spec §2.5 / 02-module-design §4）。
 *
 * - SubagentLoopHost 实现（ADR-06：server 是唯一组装点）：子会话记录（kind="subagent"）+
 *   工具白名单投影 + 共享权限链 + 复用 createSessionLoop 的子 turn 循环，不做第二套执行引擎；
 * - profile 双层目录解析（02 §4.3）：workspace `<ws>/.novacode/agents` 优先，global `<dataRoot>/agents` 兜底；
 * - `agent` 工具注册进主 registry（source="builtin"，构造时一次）；控制面 subagent 域 4 方法；
 * - subagent.* 全局事件：manager 镜像事件（kind）→ shared 构造函数（出口即合法）→ publish，
 *   全局 seq 自增（风格同 mcp-runtime），sessionId 缺省（06 §3.1 全局事件口径）。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RpcCallError } from "@novacode/rpc";
import type { RpcServiceBinding } from "@novacode/rpc";
import { buildSubagentCompletedEvent, buildSubagentProgressEvent, buildSubagentSpawnedEvent } from "@novacode/shared";
import type {
  CollaborationMode,
  MessageRecord,
  SubagentInfo,
  SubagentListParams,
  SubagentProfileInline,
  SubagentProfileSummary,
  SubagentSpawnParams,
  SubagentStopParams,
} from "@novacode/shared";
import {
  DEFAULT_SUBAGENT_MAX_TURNS,
  SubagentManager,
  SubagentProfileError,
  createAgentTool,
  parseProfileMarkdown,
  previewText,
  projectRegistry,
  resolveProfileFile,
} from "@novacode/agent-core";
import type {
  SubagentEvent,
  SubagentProfile,
  SubagentProfileDir,
  TurnAdmission,
} from "@novacode/agent-core";
import type { LlmPort, ToolPhaseDeps } from "@novacode/agent-core";
import type { BackgroundTaskRegistry } from "@novacode/tools";
import type { Storage } from "@novacode/storage";
import { createSessionLoop } from "./session-support.js";

/** 子代理域装配依赖（agent-service 注入；风格对齐 McpRuntimeOptions）。 */
export interface SubagentRuntimeOptions {
  storage: Storage;
  /** 主会话装配好的工具依赖（共享 registry/executor/permission/background，02 §4.4 同一链路）。 */
  toolDeps: ToolPhaseDeps & { background: BackgroundTaskRegistry };
  /** LLM 工厂：profile.model 覆盖时传模型名（server 侧按 config 域 Provider 匹配），缺省传 undefined。 */
  llmFor: (model?: string) => LlmPort | null;
  /** 数据根（global profile 目录 <dataRoot>/agents）。 */
  dataRoot: string;
  /** workspace 根（workspace profile 目录 <ws>/.novacode/agents）；null = 未配置（仅 global 层）。 */
  workspaceRoot: string | null;
  /** 全局事件出口（subagent.spawned/progress/completed）。 */
  publish: RpcServiceBinding["publish"];
  /** 诊断出口（缺省 console.error，风格同 mcp-runtime）。 */
  onDiagnostic?: (message: string, err?: unknown) => void;
}

export class SubagentRuntime {
  private readonly manager: SubagentManager;
  private readonly unsubscribe: () => void;
  private globalSeq = 0;

  constructor(private readonly options: SubagentRuntimeOptions) {
    this.manager = new SubagentManager({
      host: { spawnLoop: (input) => this.spawnChildLoop(input) },
      onDiagnostic: (message, err) => this.diag(message, err),
    });
    // 镜像事件出口（06 §3.2 C 组）：listener 异常由 manager 隔离，映射/合并在 manager 侧已完成
    this.unsubscribe = this.manager.onEvent((event) => this.publishMirrorEvent(event));
    this.registerAgentTool();
  }

  /** 控制面方法表（06 §2.5 subagent 域 4 方法；形态对齐 mcp-runtime.methods）。 */
  methods(register: (method: string, handler: (params: unknown) => Promise<unknown>) => unknown): Record<string, unknown> {
    return {
      "subagent.spawn": register("subagent.spawn", async (params) => this.spawn(params as SubagentSpawnParams)),
      "subagent.stop": register("subagent.stop", async (params) => this.stop(params as SubagentStopParams)),
      "subagent.list": register("subagent.list", async (params) => this.list(params as SubagentListParams)),
      "subagent.profiles.list": register("subagent.profiles.list", async () => ({ profiles: this.profileCatalog() })),
    };
  }

  /** 全量停止（02 §4.4：archive/shutdown 级联兜底；agent 工具 ctx.signal abort 已覆盖 turn 内路径）。 */
  async stopAll(reason?: string): Promise<void> {
    await this.manager.stopAll(reason);
  }

  /** 优雅停机：停全部子代理 + 退订镜像事件 + 注销 agent 工具（agent-service.close 调用）。 */
  async dispose(): Promise<void> {
    this.unsubscribe();
    await this.manager.stopAll("dispose");
    const registry = this.options.toolDeps.registry;
    if (registry.has("agent")) registry.unregister("agent");
  }

  // -------------------------------------------------------------------------
  // 控制面方法（06 §2.5）
  // -------------------------------------------------------------------------

  /** subagent.spawn：受理即返；主会话存在性预检 + profile 解析 + TOOLS_EMPTY 预检（06 §2.5 spawn 前校验）。 */
  private async spawn(params: SubagentSpawnParams): Promise<unknown> {
    const parent = await this.options.storage.sessions.get(params.sessionId);
    if (parent === null) {
      throw new RpcCallError("SESSION_NOT_FOUND", `session not found: ${params.sessionId}`);
    }
    const profile = this.resolveSpawnProfile(params.profile);
    if (this.projectAllow(profile.tools).size === 0) {
      throw new RpcCallError("SUBAGENT_TOOLS_EMPTY", `subagent "${profile.name}" 工具白名单为空（02 §4.4）`);
    }
    const handle = await this.manager.spawn(profile, params.task, { parentSessionId: parent.id });
    const queuePosition = handle.status === "Pending" ? this.manager.queuePositionOf(handle.id) : undefined;
    return { subagentId: handle.id, status: handle.status, ...(queuePosition !== undefined && { queuePosition }) };
  }

  /** subagent.stop：未知 id → SUBAGENT_NOT_FOUND；终态幂等 stopped:false（06 §2.5）。 */
  private async stop(params: SubagentStopParams): Promise<unknown> {
    if (this.manager.get(params.subagentId) === undefined) {
      throw new RpcCallError("SUBAGENT_NOT_FOUND", `subagent not found: ${params.subagentId}`);
    }
    return this.manager.stop(params.subagentId, { ...(params.reason !== undefined && { reason: params.reason }) });
  }

  /** subagent.list：sessionId 提供时过滤该主会话派生的子代理（parentSessionId 归属，02 §4.1）。 */
  private list(params: SubagentListParams): unknown {
    const items: SubagentInfo[] = this.manager
      .list()
      .filter(
        (handle) =>
          params.sessionId === undefined || this.manager.parentSessionIdOf(handle.id) === params.sessionId,
      )
      .map((handle) => ({
        id: handle.id,
        profileName: handle.profileName,
        status: handle.status,
        ...(handle.startedAt !== null && { startedAt: handle.startedAt }),
        usage: handle.usage,
        turnsUsed: handle.turnsUsed,
      }));
    return { items };
  }

  /** profile 解析：string → 双层目录解析（NOT_FOUND/INVALID 透传域码）；inline → schema 已校验 + maxTurns 缺省 20。 */
  private resolveSpawnProfile(profile: string | SubagentProfileInline): SubagentProfile {
    if (typeof profile === "string") {
      try {
        return resolveProfileFile(this.profileDirs(), profile).profile;
      } catch (reason: unknown) {
        if (reason instanceof SubagentProfileError) {
          throw new RpcCallError(reason.code, reason.message);
        }
        throw reason;
      }
    }
    // 内联形态无 markdown 正文，systemPrompt 置空（与 agent-tool inlineToProfile 同口径）
    return {
      name: profile.name,
      description: profile.description,
      ...(profile.tools !== undefined && { tools: profile.tools }),
      ...(profile.model !== undefined && { model: profile.model }),
      maxTurns: profile.maxTurns ?? DEFAULT_SUBAGENT_MAX_TURNS,
      systemPrompt: "",
    };
  }

  // -------------------------------------------------------------------------
  // SubagentLoopHost（02 §4.1：子会话创建 + 受限工具集 + 子 turn 循环）
  // -------------------------------------------------------------------------

  private async spawnChildLoop(input: {
    subagentId: string;
    profile: SubagentProfile;
    task: string;
    onChildEvent: (event: { name: string; payload: unknown }) => void;
  }): Promise<{
    sessionId: string;
    admission: TurnAdmission;
    cancel: () => void;
    lastAssistantText: () => string;
  }> {
    const { subagentId, profile, task } = input;
    // 主会话归属与执行环境（02 §4.4：子会话回链主会话，继承 workspace 与协作模式）
    const parentSessionId = this.manager.parentSessionIdOf(subagentId);
    if (parentSessionId === undefined) {
      throw new RpcCallError("SUBAGENT_NOT_FOUND", `subagent parent missing: ${subagentId}`);
    }
    const parent = await this.options.storage.sessions.get(parentSessionId);
    if (parent === null) {
      throw new RpcCallError("SESSION_NOT_FOUND", `parent session not found: ${parentSessionId}`);
    }
    const workspaceRoot = (await this.options.storage.workspaceRootOf(parent.id)) ?? process.cwd();
    // 工具白名单投影（02 §4.3）：过滤后为空 → spawn 前校验失败，不创建子会话（06 §2.5）
    const allow = this.projectAllow(profile.tools);
    if (allow.size === 0) {
      throw new RpcCallError("SUBAGENT_TOOLS_EMPTY", `subagent "${profile.name}" 工具白名单为空（02 §4.4）`);
    }
    // 子会话记录（05 §3.3：kind/parent_session_id；title 形如 [subagent:<profile>] <taskPreview>）
    const child = await this.options.storage.createSession({
      workspaceHash: parent.workspaceId,
      kind: "subagent",
      parentSessionId: parent.id,
      title: `[subagent:${profile.name}] ${previewText(task)}`,
      mode: this.modeOf(parent),
      workspaceRoot,
    });
    // LLM（02 §4.3）：profile.model 非空 → 覆盖（llmFor 按模型名解析）；缺省 → 主客户端
    const llm = this.options.llmFor(profile.model);
    const loop = createSessionLoop({
      sessionId: child.id,
      mode: child.mode,
      llm,
      storage: this.options.storage,
      publish: input.onChildEvent, // 子会话事件透传给 manager 镜像（映射/500ms 合并在 manager 侧）
      ...(profile.systemPrompt.length > 0 && { systemPrompt: profile.systemPrompt }),
      tools: { ...this.options.toolDeps, registry: projectRegistry(this.options.toolDeps.registry, allow) },
      workspaceRoot,
      workspaceId: parent.workspaceId,
      initialEventSeq: 1, // JSONL 头行占 seq 1（05 §4.2）
      maxRoundsPerTurn: profile.maxTurns, // 子任务短命：不传 compaction
    });
    const admission = loop.submit({ text: task });
    return {
      sessionId: child.id,
      admission,
      cancel: () => {
        loop.cancel("subagent-stopped");
      },
      lastAssistantText: () => lastAssistantText(loop.getHistory()),
    };
  }

  /** 子会话协作模式（02 §4.4 继承主会话；sessions 表为真源，主会话不存在已在上方拒绝）。 */
  private modeOf(parent: { mode: CollaborationMode }): CollaborationMode {
    return parent.mode;
  }

  /** 子会话工具白名单（02 §4.3）：主 registry 全集 − agent；profile.tools 非空 → 交集。 */
  private projectAllow(profileTools: string[] | undefined): Set<string> {
    const inherited = new Set(this.options.toolDeps.registry.list().map((descriptor) => descriptor.name));
    inherited.delete("agent"); // 层级固定 2：子会话投影不含 agent 工具（02 §4.4）
    if (profileTools === undefined) return inherited;
    const whitelist = new Set(profileTools);
    return new Set([...inherited].filter((name) => whitelist.has(name)));
  }

  // -------------------------------------------------------------------------
  // profile 目录与 agent 工具
  // -------------------------------------------------------------------------

  /** profile 目录候选（02 §4.3：workspace 层优先、global 兜底；resolveProfileFile 按序先命中生效）。 */
  private profileDirs(): SubagentProfileDir[] {
    const dirs: SubagentProfileDir[] = [];
    if (this.options.workspaceRoot !== null) {
      dirs.push({ path: join(this.options.workspaceRoot, ".novacode", "agents"), source: "workspace" });
    }
    dirs.push({ path: join(this.options.dataRoot, "agents"), source: "global" });
    return dirs;
  }

  /** profile 清单（subagent.profiles.list / agent 工具 description 数据源）：扫描两目录 *.md，同名 workspace 优先。 */
  private profileCatalog(): SubagentProfileSummary[] {
    const byName = new Map<string, SubagentProfileSummary>();
    for (const dir of this.profileDirs()) {
      for (const fileName of this.listProfileFiles(dir.path)) {
        try {
          const raw = readFileSync(join(dir.path, fileName), "utf8");
          const profile = parseProfileMarkdown(raw, fileName.replace(/\.md$/, ""));
          if (byName.has(profile.name)) continue; // 同名跨层：dirs 有序，workspace 先命中生效
          byName.set(profile.name, {
            name: profile.name,
            description: profile.description,
            source: dir.source,
            ...(profile.tools !== undefined && { tools: profile.tools }),
            ...(profile.model !== undefined && { model: profile.model }),
            maxTurns: profile.maxTurns,
          });
        } catch (reason: unknown) {
          this.diag(`profile 解析失败，已跳过: ${join(dir.path, fileName)}`, reason);
        }
      }
    }
    return [...byName.values()];
  }

  /** 目录 *.md 文件名列举（目录缺失/不可读返回空——目录属可选配置，不视为错误）。 */
  private listProfileFiles(dir: string): string[] {
    if (!existsSync(dir)) return [];
    try {
      return readdirSync(dir).filter((name) => name.endsWith(".md"));
    } catch (reason: unknown) {
      this.diag(`profile 目录读取失败: ${dir}`, reason);
      return [];
    }
  }

  /** agent 工具注册（构造时一次；重名先注销防测试场景二次构造，02 §4.3）。 */
  private registerAgentTool(): void {
    const registry = this.options.toolDeps.registry;
    if (registry.has("agent")) registry.unregister("agent");
    registry.register(
      createAgentTool({
        manager: this.manager,
        profileCatalog: () => this.profileCatalog(),
        resolveProfile: (name) => resolveProfileFile(this.profileDirs(), name).profile,
      }),
      "builtin",
    );
  }

  // -------------------------------------------------------------------------
  // 事件镜像与内部
  // -------------------------------------------------------------------------

  /** 镜像事件出口（06 §3.2 C 组）：kind → 事件名 → shared 构造函数（出口即合法）+ 全局 seq 自增。 */
  private publishMirrorEvent(event: SubagentEvent): void {
    const seq = ++this.globalSeq;
    if (event.kind === "spawned") {
      this.options.publish({
        name: "subagent.spawned",
        payload: buildSubagentSpawnedEvent({
          seq,
          subagentId: event.subagentId,
          profileName: event.profileName,
          taskPreview: event.taskPreview,
          status: event.status,
          ...(event.queuePosition !== undefined && { queuePosition: event.queuePosition }),
        }),
      });
      return;
    }
    if (event.kind === "progress") {
      this.options.publish({
        name: "subagent.progress",
        payload: buildSubagentProgressEvent({
          seq,
          subagentId: event.subagentId,
          stage: event.stage,
          ...(event.toolName !== undefined && { toolName: event.toolName }),
          ...(event.summary !== undefined && { summary: event.summary }),
        }),
      });
      return;
    }
    this.options.publish({
      name: "subagent.completed",
      payload: buildSubagentCompletedEvent({
        seq,
        subagentId: event.subagentId,
        status: event.status,
        summary: event.summary,
        usage: event.usage,
        turnsUsed: event.turnsUsed,
      }),
    });
  }

  private diag(message: string, err?: unknown): void {
    const sink =
      this.options.onDiagnostic ??
      ((text: string, error?: unknown) => console.error(`[novacode/server] ${text}`, error ?? ""));
    sink(message, err);
  }
}

/** 子会话最后一条 assistant 纯文本（超轮次截断时保留已产出内容；tool_calls 块与空文本跳过）。 */
function lastAssistantText(history: MessageRecord[]): string {
  const record = [...history]
    .reverse()
    .find((entry) => entry.role === "assistant" && typeof entry.content === "string" && entry.content.length > 0);
  return record !== undefined && typeof record.content === "string" ? record.content : "";
}
