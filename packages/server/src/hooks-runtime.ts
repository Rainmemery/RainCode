/**
 * HooksRuntime：hooks 域装配（T5.1 / 06-api-spec §2.12）。
 *
 * - 双源配置：user = RAINCODE_HOME/hooks.json、project = <workspace>/.raincode/hooks.json
 *   （hooksFileSchema，CC 兼容形态）；损坏文件按源降级跳过（诊断告警不阻塞会话）；
 *   stat（mtime+size）重验缓存——热路径 dispatch 只付两次 stat，文件未变不重读（NFR-2 护栏）；
 * - project trust 授信：hooks.trust.grant 把当前 project 配置 digest 绑定写入 settings 表
 *   （键 hooks.trust.<workspaceHash>）；**授权决定绝不缓存**——每 dispatch 前重读授信记录并
 *   比对 digest（ZCode workspace-hook-trust 纪律），撤销（revoke 删键）或文件改动立即失效；
 * - dispatch：user → project 顺序组链，组内 hook 按序执行；async hook 触发即返、完成仅补审计；
 *   聚合 first-block-wins + additionalContext 拼接（执行序）。
 * 执行编排在 server 侧（唯一组装点 04 ADR-06），agent-core 只做生命周期接线与事件投影。
 */
import { createHash } from "node:crypto";
import { stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { RpcCallError } from "@raincode/rpc";
import { runHook } from "@raincode/agent-core";
import type {
  HookDispatchResult,
  HookPlanEntry,
  HookRunResult,
  HooksPort,
} from "@raincode/agent-core";
import {
  hookInputSchema,
  hooksFileSchema,
  type HookInput,
  type HookMatcherGroup,
  type HooksEvents,
  type HooksFile,
  type HookSourceInfo,
  type HooksListParams,
  type HooksTrustGrantParams,
  type HooksTrustGrantResult,
  type HooksTrustRevokeParams,
  type HooksTrustRevokeResult,
} from "@raincode/shared";
import type { Storage } from "@raincode/storage";

export interface HooksRuntimeOptions {
  /** 数据根（user 层 hooks.json = <dataRoot>/hooks.json）。 */
  dataRoot: string;
  /** storage 注入（settings trust 记录 + ensureWorkspace workspaceHash 解析）。 */
  storage: Storage;
  /** 会话 → workspace 根反查（storage.workspaceRootOf 转发；skill-runtime 同形态）。 */
  workspaceRootOf: (sessionId: string) => Promise<string | null>;
  onDiagnostic?: (message: string, err?: unknown) => void;
}

interface SourceState {
  path: string;
  source: "user" | "project";
  /** stat 缓存键（mtime+size 未变即复用解析结果）。 */
  stamp: string | null;
  file: HooksFile | null;
  error?: string;
}

/** settings 表 trust 记录（授信绑定 project 配置 digest + 授信时刻）。 */
interface TrustRecord {
  digest: string;
  grantedAt: number;
}

export class HooksRuntime {
  private readonly userSource: SourceState;
  private readonly projectSources = new Map<string, SourceState>(); // workspaceRoot → project 源
  private readonly diagnostics: (message: string, err?: unknown) => void;

  /** rpc 端口（HooksPort：agent-core turn-loop 注入消费）。 */
  readonly port: HooksPort;

  constructor(private readonly options: HooksRuntimeOptions) {
    this.userSource = { path: join(options.dataRoot, "hooks.json"), source: "user", stamp: null, file: null };
    this.diagnostics = options.onDiagnostic ?? ((message, err) => console.error(`[raincode/server] ${message}`, err ?? ""));
    this.port = { dispatch: (request) => this.dispatch(request) };
  }

  // -------------------------------------------------------------------------
  // 控制面方法表（06 §2.12 hooks 域 3 方法）
  // -------------------------------------------------------------------------

  methods(register: (method: string, handler: (params: unknown) => Promise<unknown>) => unknown): Record<string, unknown> {
    return {
      "hooks.list": register("hooks.list", async (params) => this.list(params as HooksListParams)),
      "hooks.trust.grant": register("hooks.trust.grant", async (params) => this.trustGrant(params as HooksTrustGrantParams)),
      "hooks.trust.revoke": register("hooks.trust.revoke", async (params) => this.trustRevoke(params as HooksTrustRevokeParams)),
    };
  }

  /** hooks.list：双源清单投影（坏文件只产 error 注记；sessionId 未命中 → SESSION_NOT_FOUND）。 */
  private async list(params: HooksListParams): Promise<{ items: HookSourceInfo[] }> {
    const items: HookSourceInfo[] = [await this.sourceInfo(this.userSource)];
    if (params.sessionId !== undefined) {
      const source = await this.projectSource(params.sessionId);
      const info = await this.sourceInfo(source);
      const trust = await this.readTrust(params.sessionId, source);
      items.push({
        ...info,
        trusted: trust.trusted,
        ...(trust.record !== null && { trustedDigest: trust.record.digest }),
      });
    }
    return { items };
  }

  /** 授信（按会话工作区）：绑定当前 project 配置 digest；无配置文件时拒绝（无可授信内容）。 */
  private async trustGrant(params: HooksTrustGrantParams): Promise<HooksTrustGrantResult> {
    const source = await this.projectSource(params.sessionId);
    await this.loadSource(source); // 刷新缓存
    if (source.file === null) {
      throw new RpcCallError(
        "HOOKS_CONFIG_INVALID",
        `no project hooks config to trust: ${source.path}${source.error !== undefined ? ` (${source.error})` : ""}`,
      );
    }
    const events = source.file.hooks ?? {};
    const digest = digestOf(events);
    const workspaceId = await this.workspaceHashOf(params.sessionId);
    await this.options.storage.settings.set(trustKey(workspaceId), JSON.stringify({ digest, grantedAt: Date.now() } satisfies TrustRecord));
    return { workspaceId, digest, hookCount: countHooks(events) };
  }

  /** 撤销授信：删 settings 键——下一 dispatch 重读即未授信（立即生效，重验纪律的对偶面）。 */
  private async trustRevoke(params: HooksTrustRevokeParams): Promise<HooksTrustRevokeResult> {
    const workspaceId = await this.workspaceHashOf(params.sessionId);
    await this.options.storage.settings.del(trustKey(workspaceId));
    return { workspaceId, trusted: false };
  }

  // -------------------------------------------------------------------------
  // dispatch（HooksPort 实现）
  // -------------------------------------------------------------------------

  private async dispatch(request: Parameters<HooksPort["dispatch"]>[0]): Promise<HookDispatchResult> {
    const plan: HookPlanEntry[] = [];
    const runs: HookRunResult[] = [];
    let untrustedSkipped = 0;

    // 双源装载 + project trust 每 dispatch 前重验（授信记录绝不缓存）
    const userFile = (await this.loadSource(this.userSource)).file?.hooks ?? {};
    let projectFile: HooksEvents = {};
    let projectSource: SourceState | null = null;
    try {
      const root = await this.options.workspaceRootOf(request.sessionId);
      if (root !== null) projectSource = this.projectSourceByRoot(root);
    } catch {
      projectSource = null; // 会话工作区不可得：仅 user 源生效（dispatch 期不抛）
    }
    if (projectSource !== null) {
      await this.loadSource(projectSource);
      const trust = await this.readTrust(request.sessionId, projectSource);
      const events = projectSource.file?.hooks ?? {};
      if (trust.trusted) {
        projectFile = events;
      } else {
        // 只计当前事件命中面（其他事件的 hook 与本 dispatch 无关，不发 skipped 事件）
        untrustedSkipped = countGroups(events[request.event]);
      }
    }

    // 组链：user → project；matcher 对 Pre/PostToolUse 匹配 toolName、UserPromptSubmit 匹配 prompt、Stop 恒匹配
    const event = request.event;
    const subject = event === "PreToolUse" || event === "PostToolUse" ? (request.toolName ?? "") : event === "UserPromptSubmit" ? (request.prompt ?? "") : "";
    let ordinal = 0;
    for (const source of [{ file: userFile, source: "user" as const }, { file: projectFile, source: "project" as const }]) {
      for (const group of source.file[event] ?? []) {
        if (!matcherApplies(group.matcher, subject)) continue;
        for (const hook of group.hooks) {
          plan.push({
            hookId: `${source.source}:${event}:${String(ordinal)}`,
            source: source.source,
            command: hook.command,
            ...(hook.args !== undefined && { args: hook.args }),
            ...(hook.timeoutMs !== undefined && { timeoutMs: hook.timeoutMs }),
            async: hook.async ?? false,
          });
          ordinal += 1;
        }
      }
    }
    if (plan.length === 0 && untrustedSkipped === 0) {
      return { blocked: false, suppressOutput: false, hookIds: [], plan: [], untrustedSkipped: 0, runs: [] };
    }

    // 审计 hook.invoked 的载荷基础（wire 输入 schema 校验后下发 stdin）
    const wireInput = hookInputSchema.safeParse(this.toWireInput(request));
    const input: HookInput | undefined = wireInput.success ? wireInput.data : undefined;
    if (!wireInput.success) {
      this.diagnostics("hook wire input schema mismatch; hooks run with empty input", wireInput.error);
    }

    let blocked = false;
    let reason: string | undefined;
    const contexts: string[] = [];
    let systemMessage: string | undefined;
    let suppressOutput = false;

    for (const entry of plan) {
      if (entry.async) {
        // async 后台触发即返：完成仅补审计（onAsyncResult），结果不回灌主流程
        void runHook({
          hook: { type: "command", command: entry.command, ...(entry.args !== undefined && { args: entry.args }), ...(entry.timeoutMs !== undefined && { timeoutMs: entry.timeoutMs }) },
          hookId: entry.hookId,
          event,
          input: input ?? { event },
          signal: request.signal,
          onDiagnostic: this.diagnostics,
        })
          .then((run) => {
            request.onAsyncResult?.(run);
          })
          .catch((err: unknown) => this.diagnostics(`async hook ${entry.hookId} crashed`, err));
        continue;
      }
      const run = await runHook({
        hook: { type: "command", command: entry.command, ...(entry.args !== undefined && { args: entry.args }), ...(entry.timeoutMs !== undefined && { timeoutMs: entry.timeoutMs }) },
        hookId: entry.hookId,
        event,
        input: input ?? { event },
        signal: request.signal,
        onDiagnostic: this.diagnostics,
      });
      runs.push(run);
      if (run.outcome === "blocked" && !blocked) {
        blocked = true;
        reason = run.reason;
      }
      if (run.additionalContext !== undefined) contexts.push(run.additionalContext);
      if (run.systemMessage !== undefined && systemMessage === undefined) systemMessage = run.systemMessage;
      if (run.suppressOutput === true) suppressOutput = true;
      if (run.outcome === "failed" || run.outcome === "timed_out") {
        this.diagnostics(`hook ${entry.hookId} ${run.outcome}: ${run.reason ?? "no reason"}`);
      }
    }

    return {
      blocked,
      ...(reason !== undefined && { reason }),
      ...(contexts.length > 0 && { additionalContext: contexts.join("\n") }),
      ...(systemMessage !== undefined && { systemMessage }),
      suppressOutput,
      hookIds: plan.filter((entry) => !entry.async).map((entry) => entry.hookId),
      plan,
      untrustedSkipped,
      runs,
    };
  }

  /** dispatch 请求 → hook stdin 契约投影（session_id snake_case 别名 CC 兼容）。 */
  private toWireInput(request: Parameters<HooksPort["dispatch"]>[0]): Record<string, unknown> {
    return {
      event: request.event,
      sessionId: request.sessionId,
      session_id: request.sessionId,
      turnId: request.turnId,
      ...(request.toolName !== undefined && { toolName: request.toolName }),
      ...(request.toolInput !== undefined && { toolInput: request.toolInput }),
      ...(request.toolResponse !== undefined && { toolResponse: request.toolResponse }),
      ...(request.prompt !== undefined && { prompt: request.prompt }),
      stopHookActive: request.stopHookActive ?? false,
    };
  }

  // -------------------------------------------------------------------------
  // 源装载与授信
  // -------------------------------------------------------------------------

  /** project 源（按 sessionId 反查工作区；未命中 → SESSION_NOT_FOUND，skills.list 同口径）。 */
  private async projectSource(sessionId: string): Promise<SourceState> {
    const root = await this.options.workspaceRootOf(sessionId);
    if (root === null) {
      throw new RpcCallError("SESSION_NOT_FOUND", `session not found: ${sessionId}`);
    }
    return this.projectSourceByRoot(root);
  }

  private projectSourceByRoot(root: string): SourceState {
    let source = this.projectSources.get(root);
    if (source === undefined) {
      source = { path: join(root, ".raincode", "hooks.json"), source: "project", stamp: null, file: null };
      this.projectSources.set(root, source);
    }
    return source;
  }

  /**
   * stat 重验装载：mtime+size 未变复用缓存；ENOENT = 无配置（合法态）；读/解析失败降级 null + error
   * （坏文件不阻塞会话，同 mcp.json 域空转口径）。返回源自身便于链式刷新。
   */
  private async loadSource(source: SourceState): Promise<SourceState> {
    let stamp: string | null = null;
    try {
      const info = await stat(source.path);
      stamp = `${String(info.mtimeMs)}:${String(info.size)}`;
    } catch {
      stamp = null; // ENOENT 等：视为无配置
    }
    if (stamp === source.stamp) return source; // 未变（含双方均为 null）
    source.stamp = stamp;
    source.file = null;
    source.error = undefined;
    if (stamp === null) return source;
    try {
      const raw = await readFile(source.path, "utf8");
      const parsed = hooksFileSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        source.error = `hooks config schema mismatch: ${parsed.error.issues.map((issue) => issue.path.join(".") || "<root>").slice(0, 4).join("; ")}`;
        this.diagnostics(`${source.error} (${source.path})`);
        return source;
      }
      source.file = parsed.data;
    } catch (reason: unknown) {
      source.error = reason instanceof Error ? reason.message : String(reason);
      this.diagnostics(`hooks config load failed (${source.path})`, reason);
    }
    return source;
  }

  /** project 源授信状态（每 dispatch 现读 settings——授权决定绝不缓存；fail-closed）。 */
  private async readTrust(sessionId: string, source: SourceState): Promise<{ trusted: boolean; record: TrustRecord | null }> {
    try {
      const workspaceId = await this.workspaceHashOf(sessionId);
      const raw = await this.options.storage.settings.get(trustKey(workspaceId));
      if (raw === null) return { trusted: false, record: null };
      const record = JSON.parse(raw) as TrustRecord;
      const events = source.file?.hooks ?? {};
      const trusted = record.digest === digestOf(events) && countHooks(events) > 0;
      return { trusted, record };
    } catch (reason: unknown) {
      this.diagnostics("hooks trust read failed; treating project hooks as untrusted (fail-closed)", reason);
      return { trusted: false, record: null };
    }
  }

  /** 会话 → workspace hash（trust 键域；会话不存在即未授信）。 */
  private async workspaceHashOf(sessionId: string): Promise<string> {
    const meta = await this.options.storage.sessions.get(sessionId);
    if (meta === null) {
      throw new RpcCallError("SESSION_NOT_FOUND", `session not found: ${sessionId}`);
    }
    return meta.workspaceId;
  }

  private async sourceInfo(source: SourceState): Promise<HookSourceInfo> {
    await this.loadSource(source);
    const events = Object.keys(source.file?.hooks ?? {});
    return {
      source: source.source,
      path: source.path,
      loaded: source.file !== null,
      ...(source.error !== undefined && { error: source.error }),
      events,
      hookCount: countHooks(source.file?.hooks ?? {}),
    };
  }
}

// ---------------------------------------------------------------------------

function trustKey(workspaceHash: string): string {
  return `hooks.trust.${workspaceHash}`;
}

/** 配置 digest（规范化 JSON：格式化差异不失效授信，内容差异立即失效）。 */
function digestOf(events: HooksEvents): string {
  return createHash("sha256").update(JSON.stringify(events)).digest("hex").slice(0, 16);
}

function countHooks(events: HooksEvents): number {
  let total = 0;
  for (const groups of Object.values(events)) {
    total += countGroups(groups);
  }
  return total;
}

function countGroups(groups: readonly HookMatcherGroup[] | undefined): number {
  let total = 0;
  for (const group of groups ?? []) total += group.hooks.length;
  return total;
}

/** matcher 语义：缺省全匹配；Pre/PostToolUse 对 toolName、UserPromptSubmit 对 prompt、Stop 恒匹配（subject 空串）。 */
function matcherApplies(matcher: string | undefined, subject: string): boolean {
  if (matcher === undefined || matcher.length === 0) return true;
  try {
    return new RegExp(matcher).test(subject);
  } catch {
    return false; // 非法正则：该组永不匹配（fail-closed，诊断由装载侧 schema 兜底不覆盖运行期）
  }
}
