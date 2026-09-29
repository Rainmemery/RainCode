/**
 * TurnPhase 状态机（02-module-design §1.2.1）——本波补齐工具三态，8 态全集。
 *
 * 迁移表对照（02 §1.2.1）：
 *   T1 Idle --command.submitted--> ProcessingInput
 *   T2 ProcessingInput --context.assembled--> ModelRequest
 *   T3 ProcessingInput --turn.cancelled--> TurnComplete
 *   T4 ModelRequest --stream.opened--> Streaming
 *   T5 ModelRequest --request.failed--> TurnComplete
 *   T6 Streaming --message.completed(tool_calls)--> ToolSchedule
 *   T7 Streaming --message.completed(stop)--> TurnComplete
 *   T8 Streaming --turn.cancelled--> TurnComplete
 *   T9 ToolSchedule --schedule.ready--> ToolExecution
 *   T10 ToolSchedule --schedule.all_blocked--> AggregatingResults
 *   T11 ToolExecution --batch.settled--> AggregatingResults
 *   T12 ToolExecution --turn.cancelled--> AggregatingResults
 *   T13 AggregatingResults --followup.required--> ModelRequest
 *   T14 AggregatingResults --followup.not_required--> TurnComplete
 *   T15 TurnComplete --settle.done--> Idle
 *
 * 说明：ModelRequest 阶段的取消经 abort 使请求以 request.failed 失败，走 T5（02 表格未列
 * ModelRequest --turn.cancelled-->，语义上取消即请求失败，不新增迁移）。
 * 未列出的 (状态, 触发) 组合一律非法：transitionPhase 抛 IllegalPhaseTransitionError
 * （fail-fast，02 §1.4：不尝试自动纠偏）。
 */
import type { TurnPhase as ProtocolTurnPhase } from "@raincode/shared";

export type TurnPhase =
  | "Idle"
  | "ProcessingInput"
  | "ModelRequest"
  | "Streaming"
  | "ToolSchedule"
  | "ToolExecution"
  | "AggregatingResults"
  | "TurnComplete";

/** 编译期锚点：内核相位必须落在协议 TurnPhase 全集内（事件 payload 直接使用协议类型）。 */
const PROTOCOL_PHASES: readonly ProtocolTurnPhase[] = [
  "Idle",
  "ProcessingInput",
  "ModelRequest",
  "Streaming",
  "ToolSchedule",
  "ToolExecution",
  "AggregatingResults",
  "TurnComplete",
];
void PROTOCOL_PHASES;

/** 状态迁移触发事件（命名对齐 02 §1.2.1 迁移表的触发列）。 */
export type TurnTrigger =
  | "command.submitted" // T1
  | "context.assembled" // T2
  | "turn.cancelled" // T3 / T8 / T12
  | "stream.opened" // T4
  | "request.failed" // T5 / T5'
  | "message.completed.stop" // T7（纯文本 stop 收尾）
  | "message.completed.tool_calls" // T6（模型发出工具调用）
  | "schedule.ready" // T9
  | "schedule.all_blocked" // T10
  | "batch.settled" // T11
  | "followup.required" // T13
  | "followup.not_required" // T14
  | "settle.done"; // T15

const TRANSITIONS: Readonly<Record<TurnPhase, Partial<Record<TurnTrigger, TurnPhase>>>> = {
  Idle: { "command.submitted": "ProcessingInput" },
  ProcessingInput: {
    "context.assembled": "ModelRequest",
    "turn.cancelled": "TurnComplete",
  },
  ModelRequest: {
    "stream.opened": "Streaming",
    "request.failed": "TurnComplete",
  },
  Streaming: {
    "message.completed.stop": "TurnComplete",
    "message.completed.tool_calls": "ToolSchedule",
    "turn.cancelled": "TurnComplete",
    "request.failed": "TurnComplete",
  },
  ToolSchedule: {
    "schedule.ready": "ToolExecution",
    "schedule.all_blocked": "AggregatingResults",
  },
  ToolExecution: {
    "batch.settled": "AggregatingResults",
    "turn.cancelled": "AggregatingResults",
  },
  AggregatingResults: {
    "followup.required": "ModelRequest",
    "followup.not_required": "TurnComplete",
  },
  TurnComplete: { "settle.done": "Idle" },
};

/** 非法状态迁移（02 §1.3：fail-fast；to 未知时为 null）。 */
export class IllegalPhaseTransitionError extends Error {
  constructor(
    public readonly from: TurnPhase,
    public readonly to: TurnPhase | null,
    public readonly event: string,
  ) {
    super(
      `illegal phase transition: ${from} --${event}--> ${to ?? "<none>"}（02 §1.2.1 迁移表未定义）`,
    );
    this.name = "IllegalPhaseTransitionError";
  }
}

/** 执行一次状态迁移；非法组合抛 IllegalPhaseTransitionError。 */
export function transitionPhase(from: TurnPhase, event: TurnTrigger): TurnPhase {
  const to = TRANSITIONS[from][event];
  if (to === undefined) {
    throw new IllegalPhaseTransitionError(from, null, event);
  }
  return to;
}
