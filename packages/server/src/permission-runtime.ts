/**
 * PermissionRuntime：server 侧权限域装配与 5 方法实现（06-api-spec §2.2）。
 *
 * - normal 策略（默认）的装配体：PermissionService 五级判定链 + ApprovalBroker 审批闭环 +
 *   RulesManager + AuditLogger，并向 agent-core 暴露 PermissionPort 窄端口；
 *   default-allow（仅开发）由 AgentService 直连测试端口（createMetadataPermissionPort）；
 * - 依赖方向：server → permission/shared/storage（agent-core 只消费 PermissionPort 窄端口）；
 * - PermissionError → RpcCallError 转换（06 §4.3 业务码 PC_*）。
 */
import { RpcCallError } from "@novacode/rpc";
import type {
  PermissionDecisionsListParams,
  PermissionDecisionsListResult,
  PermissionDecisionRecord,
  PermissionRespondParams,
  PermissionRespondResult,
  PermissionRulesAddParams,
  PermissionRulesAddResult,
  PermissionRulesListParams,
  PermissionRulesListResult,
  PermissionRulesRemoveParams,
  PermissionRulesRemoveResult,
} from "@novacode/shared";
import { Storage } from "@novacode/storage";
import {
  ApprovalBroker,
  AuditLogger,
  BashRuleEvaluator,
  PermissionError,
  PermissionService,
  RulesManager,
} from "@novacode/permission";
import type { PermissionPort } from "@novacode/agent-core";
import type { ToolPermissionRequest } from "@novacode/agent-core";

export type PermissionPolicy = "default-allow" | "normal";

export interface PermissionRuntimeOptions {
  approvalTimeoutMs?: number;
}

const DIAG_PREFIX = "[novacode/permission]";

function diag(message: string, err?: unknown): void {
  console.error(`${DIAG_PREFIX} ${message}`, err ?? "");
}

export class PermissionRuntime {
  /** agent-core ToolPhaseDeps.permission 消费的窄端口。 */
  readonly port: PermissionPort;
  readonly service: PermissionService;
  readonly broker: ApprovalBroker;

  private readonly rulesManager: RulesManager;
  private readonly audit: AuditLogger;
  private defaultWorkspaceHash: string | null = null;

  constructor(private readonly storage: Storage, options: PermissionRuntimeOptions) {
    this.audit = new AuditLogger(storage.permissionDecisions, diag);
    this.rulesManager = new RulesManager({
      repo: storage.permissionRules,
      defaultWorkspaceId: () => this.defaultWorkspaceHash,
      onDiagnostic: diag,
    });
    this.broker = new ApprovalBroker({
      ...(options.approvalTimeoutMs !== undefined && { timeoutMs: options.approvalTimeoutMs }),
      persistApproval: async (input) => {
        await storage.approvals.create(input);
      },
      persistResolution: async (grantId, patch) => {
        await storage.approvals.resolve(grantId, patch);
      },
      onSettled: (grant, resolution) => {
        // 终判审计：ask 态收敛（respond/timeout）后统一落 permission_decisions
        void this.audit.record({
          sessionId: grant.sessionId,
          workspaceId: grant.workspaceId,
          toolName: grant.toolName,
          mode: grant.mode,
          decision: resolution.decision,
          matchedBy: grant.matchedBy,
          ruleId: grant.ruleId ?? null,
          grantId: grant.grantId,
          reason: grant.reason,
          input: grant.input,
          respondLatencyMs: resolution.respondLatencyMs,
        });
      },
      onDiagnostic: diag,
    });
    this.service = new PermissionService({
      rules: this.rulesManager,
      bash: new BashRuleEvaluator(),
      broker: this.broker,
      audit: this.audit,
      onDiagnostic: diag,
    });
    const service = this.service;
    this.port = {
      evaluate: (request: ToolPermissionRequest) => service.evaluate(toServiceRequest(request)),
      awaitApproval: (grantId: string) => service.awaitApproval(grantId),
    };
  }

  /** 首个会话建立时登记 project 规则判定域（rules.add scope=project 的缺省 workspace）。 */
  setDefaultWorkspace(workspaceId: string): void {
    if (this.defaultWorkspaceHash === null) {
      this.defaultWorkspaceHash = workspaceId;
    }
  }

  // ---------------------------------------------------------------------------
  // permission 域 5 方法（06 §2.2）
  // ---------------------------------------------------------------------------

  async respond(params: PermissionRespondParams): Promise<PermissionRespondResult> {
    try {
      return await this.service.respond(params.grantId, {
        decision: params.decision,
        ...(params.always !== undefined && { always: params.always }),
        ...(params.scope !== undefined && { scope: params.scope }),
      });
    } catch (err: unknown) {
      throw toRpcError(err);
    }
  }

  async listRules(params: PermissionRulesListParams): Promise<PermissionRulesListResult> {
    const rules = await this.rulesManager.listRules({
      ...(params.scope !== undefined && { scope: params.scope }),
      ...(params.tool !== undefined && { tool: params.tool }),
    });
    return { rules };
  }

  async addRule(params: PermissionRulesAddParams): Promise<PermissionRulesAddResult> {
    try {
      const rule = await this.rulesManager.addRule({
        scope: params.scope,
        tool: params.tool,
        pattern: params.pattern ?? null,
        ...(params.matchType !== undefined && { matchType: params.matchType }),
        behavior: params.behavior,
        source: "user",
      });
      return { rule };
    } catch (err: unknown) {
      throw toRpcError(err);
    }
  }

  async removeRule(params: PermissionRulesRemoveParams): Promise<PermissionRulesRemoveResult> {
    try {
      await this.rulesManager.removeRule(params.id);
      return { removed: true };
    } catch (err: unknown) {
      throw toRpcError(err);
    }
  }

  async listDecisions(params: PermissionDecisionsListParams): Promise<PermissionDecisionsListResult> {
    const limit = params.page?.limit ?? 50;
    const offset = parseCursor(params.page?.cursor);
    const rows = await this.storage.permissionDecisions.list({
      ...(params.sessionId !== undefined && { sessionId: params.sessionId }),
      ...(params.toolName !== undefined && { toolName: params.toolName }),
      ...(params.decision !== undefined && { decision: params.decision }),
      ...(params.since !== undefined && { since: params.since }),
      limit,
      offset,
    });
    const items: PermissionDecisionRecord[] = rows.map((row) => ({
      id: row.id,
      ts: row.ts,
      sessionId: row.sessionId,
      workspaceId: row.workspaceId,
      toolName: row.toolName,
      mode: row.mode,
      decision: row.decision,
      matchedBy: row.matchedBy,
      ruleId: row.ruleId,
      grantId: row.grantId,
      reason: row.reason,
      inputDigest: row.inputDigest,
      respondLatencyMs: row.respondLatencyMs,
    }));
    return {
      items,
      ...(rows.length === limit && { nextCursor: `o${String(offset + limit)}` }),
    };
  }

  close(): void {
    this.broker.close();
  }

  /** 方法表接线（agent-service buildMethods 展开；schema 校验由 METHOD_SCHEMAS 单点承担）。 */
  methods(register: (method: string, handler: (params: unknown) => Promise<unknown>) => unknown): Record<string, unknown> {
    return {
      "permission.respond": register("permission.respond", async (params) =>
        this.respond(params as PermissionRespondParams)),
      "permission.rules.list": register("permission.rules.list", async (params) =>
        this.listRules(params as PermissionRulesListParams)),
      "permission.rules.add": register("permission.rules.add", async (params) =>
        this.addRule(params as PermissionRulesAddParams)),
      "permission.rules.remove": register("permission.rules.remove", async (params) =>
        this.removeRule(params as PermissionRulesRemoveParams)),
      "permission.decisions.list": register("permission.decisions.list", async (params) =>
        this.listDecisions(params as PermissionDecisionsListParams)),
    };
  }

  // ---------------------------------------------------------------------------
}

// ---------------------------------------------------------------------------

/** agent-core 端口请求 → permission 服务请求（字段结构化对齐，直传）。 */
function toServiceRequest(request: ToolPermissionRequest): Parameters<PermissionService["evaluate"]>[0] {
  return {
    toolName: request.toolName,
    input: request.input,
    metadata: request.metadata,
    mode: request.mode,
    sessionId: request.sessionId,
    ...(request.turnId !== undefined && { turnId: request.turnId }),
    ...(request.toolCallId !== undefined && { toolCallId: request.toolCallId }),
    workspaceRoot: request.workspaceRoot,
    workspaceId: request.workspaceId,
    ...(request.events !== undefined && { events: request.events }),
  };
}

/** PermissionError → RpcCallError（06 §4.3 业务码；其余异常原样上抛维持 INTERNAL）。 */
function toRpcError(err: unknown): unknown {
  if (err instanceof PermissionError) {
    return new RpcCallError(err.code, err.message.replace(/^\[PC_[A-Z_]+\]\s*/, ""), err.details);
  }
  return err;
}

/** 简单偏移游标（与 AgentService.session.list 同约定）。 */
function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined || !cursor.startsWith("o")) return 0;
  const parsed = Number.parseInt(cursor.slice(1), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}
