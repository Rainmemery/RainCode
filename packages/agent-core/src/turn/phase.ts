/**
 * TurnPhase 状态机（02-module-design §1.2.1）——walking skeleton 子集。
 *
 * 本波实现 Idle → ProcessingInput → ModelRequest → Streaming → TurnComplete 五态；
 * ToolSchedule / ToolExecution / AggregatingResults 三态与 T6/T9–T14 随工具系统波次补齐
 * （偏差已在交付报告申报）。未列出的 (状态, 触发) 组合一律非法：transitionPhase 抛
 * IllegalPhaseTransitionError（fail-fast，02 §1.4：不尝试自动纠偏）。
 *
 * 迁移表对照（02 §1.2.1）：
 *   T1 Idle --command.submitted--> ProcessingInput
 *   T2 ProcessingInput --context.assembled--> ModelRequest
 *   T3 ProcessingInput --turn.cancelled--> TurnComplete
 *   T4 ModelRequest --stream.opened--> Streaming
 *   T5 ModelRequest --request.failed--> TurnComplete
 *   T7 Streaming --message.completed(stop)--> TurnComplete（本波无工具，T6 的 ToolSchedule 分支不存在）
 *   T8 Streaming --turn.cancelled--> TurnComplete
 *   T5' Streaming --request.failed--> TurnComplete（02 §1.4「流式中途断连按 T5 收束」的表格补全）
 *   T15 TurnComplete --settle.done--> Idle
 *
 * 说明：ModelRequest 阶段的取消经 abort 使请求以 request.failed 失败，走 T5（02 表格未列
 * ModelRequest --turn.cancelled-->，语义上取消即请求失败，不新增迁移）。
 */
import type { TurnPhase as ProtocolTurnPhase } from "@novacode/shared";

/** 本波实现的状态子集（协议全集见 @novacode/shared turnPhaseSchema，8 态）。 */
export type TurnPhase =
  | "Idle"
  | "ProcessingInput"
  | "ModelRequest"
  | "Streaming"
  | "TurnComplete";

/** 编译期锚点：核心子集必须落在协议 TurnPhase 全集内（事件 payload 直接使用协议类型）。 */
const PROTOCOL_PHASES: readonly ProtocolTurnPhase[] = [
  "Idle",
  "ProcessingInput",
  "ModelRequest",
  "Streaming",
  "TurnComplete",
];
void PROTOCOL_PHASES;

/** 状态迁移触发事件（命名对齐 02 §1.2.1 迁移表的触发列）。 */
export type TurnTrigger =
  | "command.submitted" // T1
  | "context.assembled" // T2
  | "turn.cancelled" // T3 / T8
  | "stream.opened" // T4
  | "request.failed" // T5 / T5'
  | "message.completed" // T7（stop 收尾；tool_calls 分支本波按失败收束）
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
    "message.completed": "TurnComplete",
    "turn.cancelled": "TurnComplete",
    "request.failed": "TurnComplete",
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
