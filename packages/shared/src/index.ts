/**
 * @novacode/shared —— zod schema 单一事实源（06-api-spec §5 / 04-architecture §4.3 / ADR-07）。
 *
 * 本包唯一 publicEntrypoint（architecture/policy.yaml）：跨包只允许从这里导入，禁止深导入。
 * 只放 schema、纯类型、常量与事件构造函数，禁止业务行为（04 §2.4 铁律 2）。
 */

export * from "./schemas/common.js";
export * from "./schemas/config.js";
export * from "./schemas/events-turn.js";
export * from "./schemas/session.js";
export * from "./schemas/system.js";
export * from "./schemas/tool.js";

import type { ZodTypeAny } from "zod";
import { systemPingParamsSchema, systemPingResultSchema } from "./schemas/system.js";
import {
  sessionCancelParamsSchema,
  sessionCancelResultSchema,
  sessionCreateParamsSchema,
  sessionCreateResultSchema,
  sessionListParamsSchema,
  sessionListResultSchema,
  sessionResumeParamsSchema,
  sessionResumeResultSchema,
  sessionSendParamsSchema,
  sessionSendResultSchema,
  sessionSnapshotEventPayloadSchema,
} from "./schemas/session.js";
import {
  doneEventPayloadSchema,
  errorEventPayloadSchema,
  messageCompletedEventPayloadSchema,
  messageDeltaEventPayloadSchema,
  toolCallCompletedEventPayloadSchema,
  toolCallProgressEventPayloadSchema,
  toolCallStartedEventPayloadSchema,
  turnPhaseChangedEventPayloadSchema,
} from "./schemas/events-turn.js";
import {
  toolBackgroundKillParamsSchema,
  toolBackgroundKillResultSchema,
  toolBackgroundListParamsSchema,
  toolBackgroundListResultSchema,
  toolBackgroundOutputParamsSchema,
  toolBackgroundOutputResultSchema,
  toolToolsListParamsSchema,
  toolToolsListResultSchema,
} from "./schemas/tool.js";

/** 方法表条目：入参 / 出参 schema 对（server 方法表的数据源，04 §4.1）。 */
export interface MethodSchemas {
  request: ZodTypeAny;
  response: ZodTypeAny;
}

/**
 * 方法 schema 注册表（06 §5 index.ts）：方法未登记 schema 即无法在 server 暴露（04 ADR-07 强制机制）。
 * 当前覆盖：system.ping；session.create/send/cancel/list/resume；tool.tools.list + 后台任务三方法。
 */
export const METHOD_SCHEMAS: Readonly<Record<string, MethodSchemas>> = {
  "system.ping": { request: systemPingParamsSchema, response: systemPingResultSchema },
  "session.create": { request: sessionCreateParamsSchema, response: sessionCreateResultSchema },
  "session.send": { request: sessionSendParamsSchema, response: sessionSendResultSchema },
  "session.cancel": { request: sessionCancelParamsSchema, response: sessionCancelResultSchema },
  "session.list": { request: sessionListParamsSchema, response: sessionListResultSchema },
  "session.resume": { request: sessionResumeParamsSchema, response: sessionResumeResultSchema },
  "tool.tools.list": { request: toolToolsListParamsSchema, response: toolToolsListResultSchema },
  "tool.background.list": {
    request: toolBackgroundListParamsSchema,
    response: toolBackgroundListResultSchema,
  },
  "tool.background.kill": {
    request: toolBackgroundKillParamsSchema,
    response: toolBackgroundKillResultSchema,
  },
  "tool.background.output": {
    request: toolBackgroundOutputParamsSchema,
    response: toolBackgroundOutputResultSchema,
  },
};

/**
 * 事件 payload 注册表（06 §3）：事件出口经构造函数生成、出口即合法；
 * 客户端校验仅为开发模式断言（04 §4.3）。
 */
export const EVENT_SCHEMAS: Readonly<Record<string, ZodTypeAny>> = {
  "message.delta": messageDeltaEventPayloadSchema,
  "message.completed": messageCompletedEventPayloadSchema,
  "turn.phase_changed": turnPhaseChangedEventPayloadSchema,
  "tool_call.started": toolCallStartedEventPayloadSchema,
  "tool_call.progress": toolCallProgressEventPayloadSchema,
  "tool_call.completed": toolCallCompletedEventPayloadSchema,
  done: doneEventPayloadSchema,
  error: errorEventPayloadSchema,
  "session.snapshot": sessionSnapshotEventPayloadSchema,
};
