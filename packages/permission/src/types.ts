/**
 * permission 包领域类型（02-module-design §6）。
 * 只依赖 @raincode/shared 类型（不 import agent-core/tools 实现，任务依赖约束）；
 * PermissionEventSink 是 agent-core 持久事件通道的结构投影（server 装配时结构化满足）。
 */
import type {
  CollaborationMode,
  MatchedBy,
  PermissionDecision,
  PermissionRule,
  RuleScope,
  ToolMetadata,
  ToolMetadataSummary,
} from "@raincode/shared";

/** 会话持久事件出口（permission.requested / permission.resolved 先落 JSONL 再发布）。 */
export interface PermissionEventSink {
  emit(
    name: "permission.requested" | "permission.resolved",
    build: (seq: number, ts: number) => unknown,
  ): void;
}

/** 权限判定入参（02 §6.3 ToolPermissionRequest）。 */
export interface PermissionRequest {
  toolName: string;
  /** 归一化后的执行输入（与最终执行同字节，approve-what-runs）。 */
  input: unknown;
  metadata: ToolMetadata;
  mode: CollaborationMode;
  sessionId: string;
  turnId?: string;
  toolCallId?: string;
  workspaceRoot: string;
  workspaceId: string;
  /**
   * 越界路径预检（02 §5.4「命令读写 workspace 外路径 → P0 标记为需审批；审批通过后放行并记录审计」）：
   * agent-core tool-phase 对显式路径工具预检注入；存在时跳过 L1 只读快速通道等静默放行，
   * 强制经 broker 逐次审批（audit/approvals 闭环照常）。
   */
  pathEscape?: { absolutePath: string };
  /** 审批事件出口（ask 态经此持久化 permission.requested/resolved）。 */
  events?: PermissionEventSink;
}

/** 判定结果（02 §6.3 PermissionVerdict）。 */
export interface PermissionVerdict {
  decision: PermissionDecision;
  matchedBy: MatchedBy;
  ruleId?: string;
  /** decision=ask 时下发的审批单 id。 */
  grantId?: string;
  reason: string;
}

/** 审批应答（02 §6.2 respond；always 按 scope 落规则）。 */
export interface ApprovalRespondInput {
  decision: "allow" | "deny";
  always?: boolean;
  scope?: RuleScope;
  /**
   * ask_user_question 通道的自由文本应答（T2.7 P1；06 §2.2 可选请求字段）。
   * 仅随 permission.resolved 事件与 askAndWait 等待侧透出（approvals 表不加列）。
   */
  answerText?: string;
}

/** 审批收敛结果（respond / 超时统一形态）。 */
export interface ApprovalResolution {
  decision: "allow" | "deny";
  always: boolean;
  scope?: RuleScope;
  by: "user" | "timeout" | "offline";
  respondLatencyMs: number;
  /** ask_user_question 通道的用户应答文本（透传；deny/timeout 收敛无此字段）。 */
  answerText?: string;
}

/** 审批单记录（broker 内部快照；审计与 always 落规则的数据源）。 */
export interface ApprovalGrantRecord {
  grantId: string;
  sessionId: string;
  workspaceId: string;
  toolName: string;
  input: unknown;
  mode: CollaborationMode;
  matchedBy: MatchedBy;
  ruleId?: string;
  reason: string;
  turnId?: string;
  toolCallId?: string;
  metadata: ToolMetadataSummary;
  requestedAt: number;
  expiresAt: number;
}

/** bash 分段（argv 解析产物；text 为 argv 规范化拼接，规则匹配对象）。 */
export interface BashSegment {
  /** 原始片段（trim 后）。 */
  raw: string;
  /** argv 以单空格拼接（引号已解包）。 */
  text: string;
  root: string;
  readonly: boolean;
  dangerous: boolean;
}

export interface BashCommandAnalysis {
  segments: BashSegment[];
  /** 变量展开/子 shell/引号不闭合等解析不确定（宁严勿松 → ask，02 §6.4）。 */
  inconclusive: boolean;
}

/** 规则命中（链内单层求值产物）。 */
export interface RuleHit {
  rule: PermissionRule;
  level: MatchedBy;
}
