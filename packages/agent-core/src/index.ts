/**
 * @novacode/agent-core —— Agent 内核（04-architecture §2.1）。
 *
 * 本包唯一 publicEntrypoint（architecture/policy.yaml）。
 * 职责（02-module-design §1）：Turn 循环、TurnPhase 状态机、CommandInbox 串行接纳、
 * 流式桥接（会话事件映射）；compact / sub-agent 随后续波次补充。
 * 依赖 shared / llm / storage（类型与端口，见 ports.ts）；对传输不可知（禁止 import rpc）。
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

export type { LlmPort, SessionEventPublisher, StoragePort } from "./ports.js";
