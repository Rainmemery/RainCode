/**
 * @novacode/agent-core —— Agent 内核（04-architecture §2.1）。
 *
 * 本包唯一 publicEntrypoint（architecture/policy.yaml）。
 * 职责（02-module-design §1）：Turn 循环、TurnPhase 状态机（8 态）、CommandInbox 串行接纳、
 * 流式桥接、工具阶段调度（ToolSchedule/ToolExecution/AggregatingResults）；
 * compact / sub-agent 随后续波次补充。依赖 shared / llm / storage / tools（端口与类型）；
 * 对传输不可知（禁止 import rpc）。
 */

export { IllegalPhaseTransitionError, transitionPhase } from "./turn/phase.js";
export type { TurnPhase, TurnTrigger } from "./turn/phase.js";

export { CommandInbox } from "./inbox/command-inbox.js";
export type { InboxAdmission } from "./inbox/command-inbox.js";

export { SessionTurnLoop } from "./turn/turn-loop.js";
export type {
  SessionTurnLoopOptions,
  TurnAdmission,
  TurnInput,
  TurnOutcome,
} from "./turn/turn-loop.js";

export { ToolPhaseRunner } from "./turn/tool-phase.js";
export type {
  PlannedToolCall,
  ToolPhaseContext,
  ToolPhaseOptions,
  ToolPhaseResult,
  ToolPhaseTrigger,
} from "./turn/tool-phase.js";

export { LoopEvents } from "./turn/loop-events.js";
export type { PersistedEventName, TransientEventName } from "./turn/loop-events.js";

export { CompactionService, estimateContextTokens, createCompactionService } from "./compact/service.js";
export type {
  CompactionDeps,
  CompactionHost,
  CompactionOptions,
  CompactionReport,
  CompactionTicket,
} from "./compact/service.js";

export { TurnSettler } from "./turn/settle.js";
export type { SettleHost } from "./turn/settle.js";

export type {
  LlmPort,
  ApprovePort,
  PermissionEventSink,
  PermissionPort,
  PermissionVerdict,
  SessionEventPublisher,
  StoragePort,
  ToolPermissionRequest,
  ToolPhaseDeps,
} from "./ports.js";
export {
  alwaysAllowApprover,
  alwaysDenyApprover,
  createMetadataPermissionPort,
} from "./ports.js";
