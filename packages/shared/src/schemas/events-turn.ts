import { z } from "zod";
import type { EventBase } from "./common.js";
import { eventBaseSchema, tokenUsageSchema, turnPhaseSchema } from "./common.js";

/**
 * 数据面 turn 事件 payload（06-api-spec §3.2 A 组：消息与 turn 生命周期）。
 * 出参宽松（z.object strip），端层对枚举未知值保留兜底渲染分支（06 §5）。
 */

// ---------------------------------------------------------------------------
// message.delta（llm 流式块到达；text/reasoning 合并，以 delta.type 区分）
// ---------------------------------------------------------------------------

export const messageDeltaEventPayloadSchema = eventBaseSchema.extend({
  turnId: z.string(),
  round: z.number().int(),
  delta: z.union([
    z.object({ type: z.enum(["text", "reasoning"]), text: z.string() }),
    z.object({
      type: z.literal("tool_call"),
      index: z.number().int(),
      toolCallId: z.string().optional(),
      toolName: z.string().optional(),
      argsPartial: z.string().optional(),
    }),
  ]),
});
export type MessageDeltaEventPayload = z.infer<typeof messageDeltaEventPayloadSchema>;

// ---------------------------------------------------------------------------
// message.completed（单轮模型响应完成，T6/T7）
// ---------------------------------------------------------------------------

export const messageCompletedEventPayloadSchema = eventBaseSchema.extend({
  turnId: z.string(),
  round: z.number().int(),
  message: z.object({
    role: z.literal("assistant"),
    content: z.string(),
    toolCalls: z
      .array(
        z.object({
          toolCallId: z.string(),
          toolName: z.string(),
          args: z.unknown(),
        }),
      )
      .optional(),
    stopReason: z.enum(["stop", "tool_calls"]),
    usage: tokenUsageSchema.optional(),
  }),
});
export type MessageCompletedEventPayload = z.infer<typeof messageCompletedEventPayloadSchema>;

// ---------------------------------------------------------------------------
// turn.phase_changed（状态机每次合法迁移，02 §1.2.1 T1–T15）
// ---------------------------------------------------------------------------

export const turnPhaseChangedEventPayloadSchema = eventBaseSchema.extend({
  turnId: z.string(),
  from: turnPhaseSchema.nullable(),
  to: turnPhaseSchema,
});
export type TurnPhaseChangedEventPayload = z.infer<typeof turnPhaseChangedEventPayloadSchema>;

// ---------------------------------------------------------------------------
// done（TurnComplete settle 完成前的 turn 终止标记）
// ---------------------------------------------------------------------------

export const doneEventPayloadSchema = eventBaseSchema.extend({
  turnId: z.string(),
  outcome: z.enum(["completed", "cancelled", "failed"]),
  at: turnPhaseSchema.optional(),
  usage: tokenUsageSchema.optional(),
  rounds: z.number().int().optional(),
});
export type DoneEventPayload = z.infer<typeof doneEventPayloadSchema>;

// ---------------------------------------------------------------------------
// error（turn_failed T5、会话级异常、传输层异常上抛）
// ---------------------------------------------------------------------------

export const errorEventPayloadSchema = eventBaseSchema.extend({
  scope: z.enum(["turn", "session", "system"]),
  code: z.string(),
  message: z.string(),
  recoverable: z.boolean(),
  turnId: z.string().optional(),
});
export type ErrorEventPayload = z.infer<typeof errorEventPayloadSchema>;

// ---------------------------------------------------------------------------
// 事件构造函数（06 §5：出口即合法；seq 由会话事件流分配，ts 缺省取当前时刻）
// ---------------------------------------------------------------------------

type EventInput<P> = Omit<P, keyof EventBase> & {
  seq: number;
  sessionId?: string;
  ts?: number;
};

function buildEvent<P>(schema: z.ZodType<P>, input: EventInput<P>): P {
  return schema.parse({ ...input, ts: input.ts ?? Date.now() });
}

export function buildMessageDeltaEvent(
  input: EventInput<MessageDeltaEventPayload>,
): MessageDeltaEventPayload {
  return buildEvent(messageDeltaEventPayloadSchema, input);
}

export function buildMessageCompletedEvent(
  input: EventInput<MessageCompletedEventPayload>,
): MessageCompletedEventPayload {
  return buildEvent(messageCompletedEventPayloadSchema, input);
}

export function buildTurnPhaseChangedEvent(
  input: EventInput<TurnPhaseChangedEventPayload>,
): TurnPhaseChangedEventPayload {
  return buildEvent(turnPhaseChangedEventPayloadSchema, input);
}

export function buildDoneEvent(input: EventInput<DoneEventPayload>): DoneEventPayload {
  return buildEvent(doneEventPayloadSchema, input);
}

export function buildErrorEvent(input: EventInput<ErrorEventPayload>): ErrorEventPayload {
  return buildEvent(errorEventPayloadSchema, input);
}
