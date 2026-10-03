/**
 * @raincode/agent-core —— Agent 内核（04-architecture §2.1）。
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

// 子代理（02-module-design §4；子会话宿主经 SubagentLoopHost 由 server 装配注入）
export { SubagentManager } from "./subagent/manager.js";
export type {
  SubagentHandle,
  SubagentLoopHost,
  SubagentManagerOptions,
  SubagentResult,
  SubagentStatus,
  Unsubscribe,
} from "./subagent/manager.js";

export { SubagentMirror, previewText, SUBAGENT_PROGRESS_MERGE_MS } from "./subagent/mirror.js";
export type { SubagentEvent, SubagentEventListener } from "./subagent/mirror.js";

export {
  DEFAULT_SUBAGENT_MAX_TURNS,
  MAX_SUBAGENT_TURNS,
  SUBAGENT_NAME_PATTERN,
  SubagentProfileError,
  parseProfileMarkdown,
  resolveProfileFile,
} from "./subagent/profile.js";
export type {
  SubagentProfile,
  SubagentProfileDir,
  SubagentProfileErrorCode,
} from "./subagent/profile.js";

export { createAgentTool } from "./subagent/agent-tool.js";
export type { CreateAgentToolOptions } from "./subagent/agent-tool.js";

export { projectRegistry } from "./subagent/registry-projection.js";

// 内置角色模板（T3.6 / M3）：workspace → global → builtin 三级解析的最后一级（用户同名遮蔽内置）
export { BUILTIN_ROLE_TEMPLATES, builtinRoleOf } from "./subagent/role-templates.js";

// 技能与斜杠命令（T3.4 / M3）：解析与展开在 agent-core，装配（skills 域方法表）在 server
export {
  SKILL_NAME_PATTERN,
  SkillError,
  expandSkillTemplate,
  parseSkillMarkdown,
  resolveSkillFile,
} from "./skills/skill.js";
export type { Skill, SkillDir, SkillErrorCode, SkillWithSource } from "./skills/skill.js";

export type {
  LlmPort,
  ApprovePort,
  AskUserAnswer,
  AskUserChannel,
  AskUserChannelRequest,
  PermissionEventSink,
  SkillExpansionChannel,
  SkillExpansionRequest,
  SkillExpansionResult,
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
