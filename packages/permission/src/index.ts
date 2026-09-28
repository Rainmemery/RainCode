/**
 * @novacode/permission —— 命令权限控制（04-architecture §2.1 / 02-module-design §6）。
 *
 * 本包唯一 publicEntrypoint（architecture/policy.yaml）。
 * 依赖方向（任务约束）：permission → shared / storage；不 import agent-core/tools 实现
 * （ToolMetadata 等经 shared 类型结构化满足，事件出口经 PermissionEventSink 结构投影）。
 * 职责：五级判定链、bash 命令级求值、ask 态审批闭环、规则与审计持久化。
 */

export { PermissionService } from "./service.js";
export type { PermissionServiceOptions } from "./service.js";

export { ApprovalBroker, DEFAULT_APPROVAL_TIMEOUT_MS } from "./approval-broker.js";
export type { BrokerDeps, BrokerRequestInput } from "./approval-broker.js";

export { RulesManager } from "./rules-manager.js";
export type { RuleAddInput, RulesManagerOptions } from "./rules-manager.js";

export { AuditLogger, sanitizeValue } from "./audit-logger.js";
export type { AuditRecordInput } from "./audit-logger.js";

export { BashRuleEvaluator } from "./bash-evaluator.js";

export { PermissionError, PC_ERROR_CODES } from "./errors.js";

export type {
  ApprovalGrantRecord,
  ApprovalRespondInput,
  ApprovalResolution,
  BashCommandAnalysis,
  BashSegment,
  PermissionEventSink,
  PermissionRequest,
  PermissionVerdict,
  RuleHit,
} from "./types.js";
