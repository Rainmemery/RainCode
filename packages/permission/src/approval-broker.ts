/**
 * ApprovalBroker：ask 态审批闭环（02 §6.2 审批闭环时序 / 05 §3.7 approvals 未决态真源）。
 *
 * - ask → 生成 grantId → approvals 落 pending 行 → 经会话事件出口持久化 permission.requested
 *   → 挂起等待 respond（grantId 单消费：首个 respond 生效，重复 respond 报 PC_GRANT_CONSUMED）；
 * - 超时（默认 120s，可配）→ 按 deny 收敛（02 §6.4），状态置 expired；
 * - 收敛统一发 permission.resolved（by: user/timeout）并回调 onSettled（审计终判落库）。
 */
import { ulid } from "@raincode/storage";
import {
  buildPermissionRequestedEvent,
  buildPermissionResolvedEvent,
} from "@raincode/shared";
import type { ToolMetadataSummary } from "@raincode/shared";
import { PC_ERROR_CODES, PermissionError } from "./errors.js";
import { AuditLogger } from "./audit-logger.js";
import type {
  ApprovalGrantRecord,
  ApprovalResolution,
  ApprovalRespondInput,
  PermissionEventSink,
} from "./types.js";
import type { MatchedBy, CollaborationMode } from "@raincode/shared";

export const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000; // 02 §6.4：审批单超时默认 120s

export interface BrokerRequestInput {
  sessionId: string;
  workspaceId: string;
  toolName: string;
  /** 归一化输入（与最终执行同字节；事件与快照各自脱敏）。 */
  input: unknown;
  mode: CollaborationMode;
  matchedBy: MatchedBy;
  ruleId?: string;
  reason: string;
  turnId?: string;
  toolCallId?: string;
  metadata: ToolMetadataSummary;
  ruleCandidates?: unknown[];
  /** 会话持久事件出口（permission.requested / permission.resolved 落 JSONL + 发布）。 */
  sink?: PermissionEventSink;
}

export interface BrokerDeps {
  timeoutMs?: number;
  /** approvals pending 行落库（05 §3.7）。 */
  persistApproval(input: {
    grantId: string;
    sessionId: string;
    workspaceId: string;
    toolName: string;
    inputSnapshot: string;
    timeoutAt: number;
  }): Promise<void>;
  /** 终态收敛（approved/denied/expired）。 */
  persistResolution(grantId: string, patch: { status: "approved" | "denied" | "expired" | "cancelled"; response: "allow" | "deny" | "always" | null; respondedAt: number }): Promise<void>;
  /** 收敛回调（终判审计落库；同步触发、内部自行容错）。 */
  onSettled(grant: ApprovalGrantRecord, resolution: ApprovalResolution): void;
  onDiagnostic?: (message: string, err?: unknown) => void;
}

interface InternalGrant extends ApprovalGrantRecord {
  settled: boolean;
  sink?: PermissionEventSink;
  ruleCandidates?: unknown[];
  timer: NodeJS.Timeout;
  resolve: (resolution: ApprovalResolution) => void;
  waiter: Promise<ApprovalResolution>;
}

export class ApprovalBroker {
  private readonly grants = new Map<string, InternalGrant>();

  constructor(private readonly deps: BrokerDeps) {}

  /** ask → 生成审批单：pending 落库 → permission.requested 持久化 → 启动超时器。 */
  async request(input: BrokerRequestInput): Promise<{ grantId: string; expiresAt: number }> {
    const grantId = `grant_${ulid()}`;
    const requestedAt = Date.now();
    const timeoutMs = this.deps.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    const expiresAt = requestedAt + timeoutMs;

    await this.deps.persistApproval({
      grantId,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      toolName: input.toolName,
      inputSnapshot: AuditLogger.snapshot(input.input),
      timeoutAt: expiresAt,
    });

    let resolveGrant!: (resolution: ApprovalResolution) => void;
    const waiter = new Promise<ApprovalResolution>((resolvePromise) => {
      resolveGrant = resolvePromise;
    });
    const grant: InternalGrant = {
      grantId,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      toolName: input.toolName,
      input: input.input,
      mode: input.mode,
      matchedBy: input.matchedBy,
      ...(input.ruleId !== undefined && { ruleId: input.ruleId }),
      reason: input.reason,
      ...(input.turnId !== undefined && { turnId: input.turnId }),
      ...(input.toolCallId !== undefined && { toolCallId: input.toolCallId }),
      metadata: input.metadata,
      requestedAt,
      expiresAt,
      settled: false,
      sink: input.sink,
      ruleCandidates: input.ruleCandidates,
      timer: setTimeout(() => {
        void this.expire(grantId);
      }, timeoutMs),
      resolve: resolveGrant,
      waiter,
    };
    this.grants.set(grantId, grant);

    // 审批中事件照常持久化（turn 挂起期间事件流仍可用，05 §4.2 approval.requested 先例）
    grant.sink?.emit("permission.requested", (seq, ts) =>
      buildPermissionRequestedEvent({
        seq,
        ts,
        sessionId: input.sessionId,
        grantId,
        ...(input.turnId !== undefined && { turnId: input.turnId }),
        ...(input.toolCallId !== undefined && { toolCallId: input.toolCallId }),
        toolName: input.toolName,
        normalizedInput: sanitizeForEvent(input.input),
        metadata: input.metadata,
        mode: input.mode,
        matchedBy: input.matchedBy,
        reason: input.reason,
        expiresAt,
        ...(input.ruleCandidates !== undefined && { ruleCandidates: input.ruleCandidates }),
      }),
    );
    return { grantId, expiresAt };
  }

  /** 审批应答（06 §2.2 permission.respond；grantId 单消费）。 */
  async respond(grantId: string, input: ApprovalRespondInput): Promise<ApprovalResolution> {
    const grant = this.grants.get(grantId);
    if (grant === undefined) {
      throw new PermissionError(PC_ERROR_CODES.GRANT_NOT_FOUND, `grant not found: ${grantId}`);
    }
    if (grant.settled) {
      // 任务交付：重复 respond 报 PC_GRANT_CONSUMED（单消费，02 §6.4 多端同审批收敛）
      throw new PermissionError(
        PC_ERROR_CODES.GRANT_CONSUMED,
        `grant already resolved: ${grantId}`,
        { grantId },
      );
    }
    return this.settle(grant, {
      decision: input.decision,
      always: input.always ?? false,
      ...(input.scope !== undefined && { scope: input.scope }),
      // ask_user_question 通道（T2.7 P1）：应答文本随 resolution 透传到事件与 askAndWait 等待侧
      ...(input.answerText !== undefined && { answerText: input.answerText }),
      by: "user",
      respondLatencyMs: Date.now() - grant.requestedAt,
    });
  }

  /** ask 收敛等待（agent-core tool-phase 挂起点）；返回最终 allow/deny。 */
  async wait(grantId: string): Promise<"allow" | "deny"> {
    const grant = this.grants.get(grantId);
    if (grant === undefined) {
      throw new PermissionError(PC_ERROR_CODES.GRANT_NOT_FOUND, `grant not found: ${grantId}`);
    }
    const resolution = await grant.waiter;
    return resolution.decision;
  }

  /**
   * ask_user_question 专用等待（T2.7 P1 最小侵入形态：wait() 签名不动，独立方法承载应答文本）。
   * decision=allow 且 respond 带非空 answerText → { answerText }；deny/超时/空应答 → { cancelled: true }。
   */
  async askAndWait(grantId: string): Promise<{ answerText: string } | { cancelled: true }> {
    const grant = this.grants.get(grantId);
    if (grant === undefined) {
      throw new PermissionError(PC_ERROR_CODES.GRANT_NOT_FOUND, `grant not found: ${grantId}`);
    }
    const resolution = await grant.waiter;
    if (resolution.decision === "allow" && typeof resolution.answerText === "string" && resolution.answerText.length > 0) {
      return { answerText: resolution.answerText };
    }
    return { cancelled: true };
  }

  grant(grantId: string): ApprovalGrantRecord | null {
    const grant = this.grants.get(grantId);
    if (grant === undefined) return null;
    const { settled: _settled, sink: _sink, ruleCandidates: _ruleCandidates, timer: _timer, resolve: _resolve, waiter: _waiter, ...record } = grant;
    return record;
  }

  pendingCount(): number {
    let count = 0;
    for (const grant of this.grants.values()) {
      if (!grant.settled) count += 1;
    }
    return count;
  }

  /** 停机清理：清超时器（不收敛状态——由持久层超时器兜底置 expired）。 */
  close(): void {
    for (const grant of this.grants.values()) {
      clearTimeout(grant.timer);
    }
    this.grants.clear();
  }

  // ---------------------------------------------------------------------------

  private async expire(grantId: string): Promise<void> {
    const grant = this.grants.get(grantId);
    if (grant === undefined || grant.settled) return;
    await this.settle(grant, {
      decision: "deny",
      always: false,
      by: "timeout",
      respondLatencyMs: Date.now() - grant.requestedAt,
    });
  }

  private async settle(grant: InternalGrant, resolution: ApprovalResolution): Promise<ApprovalResolution> {
    if (grant.settled) {
      throw new PermissionError(PC_ERROR_CODES.GRANT_CONSUMED, `grant already resolved: ${grant.grantId}`);
    }
    grant.settled = true;
    clearTimeout(grant.timer);

    const status = resolution.decision === "allow" ? "approved" : resolution.by === "timeout" ? "expired" : "denied";
    const response = resolution.by === "timeout" ? null : resolution.always ? "always" : resolution.decision;
    try {
      await this.deps.persistResolution(grant.grantId, { status, response, respondedAt: Date.now() });
    } catch (err: unknown) {
      this.deps.onDiagnostic?.(`failed to persist approval resolution ${grant.grantId}`, err);
    }

    grant.sink?.emit("permission.resolved", (seq, ts) =>
      buildPermissionResolvedEvent({
        seq,
        ts,
        sessionId: grant.sessionId,
        grantId: grant.grantId,
        decision: resolution.decision,
        ...(resolution.always && { always: true }),
        ...(resolution.scope !== undefined && { scope: resolution.scope }),
        by: resolution.by,
        respondLatencyMs: resolution.respondLatencyMs,
        // ask_user_question 通道（T2.7 P1）：应答文本透出给 UI（出参宽松，旧端忽略）
        ...(resolution.answerText !== undefined && { answerText: resolution.answerText }),
      }),
    );

    const record: ApprovalGrantRecord = {
      grantId: grant.grantId,
      sessionId: grant.sessionId,
      workspaceId: grant.workspaceId,
      toolName: grant.toolName,
      input: grant.input,
      mode: grant.mode,
      matchedBy: grant.matchedBy,
      ...(grant.ruleId !== undefined && { ruleId: grant.ruleId }),
      reason: grant.reason,
      ...(grant.turnId !== undefined && { turnId: grant.turnId }),
      ...(grant.toolCallId !== undefined && { toolCallId: grant.toolCallId }),
      metadata: grant.metadata,
      requestedAt: grant.requestedAt,
      expiresAt: grant.expiresAt,
    };
    try {
      this.deps.onSettled(record, resolution); // 终判审计（失败由 AuditLogger 自行容错）
    } catch (err: unknown) {
      this.deps.onDiagnostic?.("approval onSettled callback failed", err);
    }
    grant.resolve(resolution);
    return resolution;
  }
}

/** 事件 normalizedInput 脱敏（保持 JSON 结构可解析；审批单为 UI 展示用途，与审计同一策略）。 */
function sanitizeForEvent(input: unknown): unknown {
  try {
    const text = JSON.stringify(input);
    if (text === undefined) return String(input);
    return JSON.parse(redactForEvent(text)) as unknown;
  } catch {
    return input;
  }
}

function redactForEvent(text: string): string {
  // 与 AuditLogger 同策略的轻量版：仅抹除 sk-/Bearer 与 KEY=value 秘密形态
  return text
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{20,})/g, "[REDACTED]")
    .replace(
      /([A-Za-z0-9_-]*(?:api[_-]?key|apikey|token|secret|password|credential)[A-Za-z0-9_-]*)\s*(?:"\s*:\s*"|=)("[^"]*"|'[^']*'|[^\s,"&']+)/gi,
      '$1":"[REDACTED]"',
    );
}
