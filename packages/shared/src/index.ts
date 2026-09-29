/**
 * @raincode/shared —— zod schema 单一事实源（06-api-spec §5 / 04-architecture §4.3 / ADR-07）。
 *
 * 本包唯一 publicEntrypoint（architecture/policy.yaml）：跨包只允许从这里导入，禁止深导入。
 * 只放 schema、纯类型、常量与事件构造函数，禁止业务行为（04 §2.4 铁律 2）。
 */

export * from "./schemas/common.js";
export * from "./schemas/config.js";
export * from "./schemas/events-turn.js";
export * from "./schemas/mcp.js";
export * from "./schemas/memory.js";
export * from "./schemas/permission.js";
export * from "./schemas/session.js";
export * from "./schemas/subagent.js";
export * from "./schemas/system.js";
export * from "./schemas/tool.js";

import type { ZodTypeAny } from "zod";
import {
  systemPingParamsSchema,
  systemPingResultSchema,
  systemShutdownParamsSchema,
  systemShutdownResultSchema,
  systemVersionParamsSchema,
  systemVersionResultSchema,
} from "./schemas/system.js";
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
  sessionSetModeParamsSchema,
  sessionSetModeResultSchema,
  sessionSnapshotEventPayloadSchema,
  sessionSteerParamsSchema,
  sessionSteerResultSchema,
  sessionArchiveParamsSchema,
  sessionArchiveResultSchema,
  sessionCreatedEventPayloadSchema,
  sessionCompactParamsSchema,
  sessionCompactResultSchema,
  compactStartedEventPayloadSchema,
  compactCompletedEventPayloadSchema,
  buildCompactStartedEvent,
  buildCompactCompletedEvent,
} from "./schemas/session.js";
import {
  configGetParamsSchema,
  configGetResultSchema,
  configProvidersAddParamsSchema,
  configProvidersAddResultSchema,
  configProvidersListParamsSchema,
  configProvidersListResultSchema,
  configProvidersRemoveParamsSchema,
  configProvidersRemoveResultSchema,
  configSetParamsSchema,
  configSetResultSchema,
} from "./schemas/config.js";
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
import {
  buildPermissionRequestedEvent,
  buildPermissionResolvedEvent,
  permissionDecisionsListParamsSchema,
  permissionDecisionsListResultSchema,
  permissionRequestedEventPayloadSchema,
  permissionResolvedEventPayloadSchema,
  permissionRespondParamsSchema,
  permissionRespondResultSchema,
  permissionRulesAddParamsSchema,
  permissionRulesAddResultSchema,
  permissionRulesListParamsSchema,
  permissionRulesListResultSchema,
  permissionRulesRemoveParamsSchema,
  permissionRulesRemoveResultSchema,
} from "./schemas/permission.js";
import {
  buildMcpServerStatusChangedEvent,
  mcpServersAddParamsSchema,
  mcpServersAddResultSchema,
  mcpServersListParamsSchema,
  mcpServersListResultSchema,
  mcpServersRemoveParamsSchema,
  mcpServersRemoveResultSchema,
  mcpServersRetryParamsSchema,
  mcpServersRetryResultSchema,
  mcpToolsCallParamsSchema,
  mcpToolsCallResultSchema,
  mcpToolsListParamsSchema,
  mcpToolsListResultSchema,
  mcpServerStatusChangedEventPayloadSchema,
} from "./schemas/mcp.js";
import {
  buildSubagentCompletedEvent,
  buildSubagentProgressEvent,
  buildSubagentSpawnedEvent,
  subagentCompletedEventPayloadSchema,
  subagentListParamsSchema,
  subagentListResultSchema,
  subagentProfilesListParamsSchema,
  subagentProfilesListResultSchema,
  subagentProgressEventPayloadSchema,
  subagentSpawnedEventPayloadSchema,
  subagentSpawnParamsSchema,
  subagentSpawnResultSchema,
  subagentStopParamsSchema,
  subagentStopResultSchema,
} from "./schemas/subagent.js";
import {
  memoryEntriesListParamsSchema,
  memoryEntriesListResultSchema,
  memoryPromoteParamsSchema,
  memoryPromoteResultSchema,
  memoryReadParamsSchema,
  memoryReadResultSchema,
  memorySearchParamsSchema,
  memorySearchResultSchema,
  memoryWriteParamsSchema,
  memoryWriteResultSchema,
} from "./schemas/memory.js";

/** 方法表条目：入参 / 出参 schema 对（server 方法表的数据源，04 §4.1）。 */
export interface MethodSchemas {
  request: ZodTypeAny;
  response: ZodTypeAny;
}

/**
 * 方法 schema 注册表（06 §5 index.ts）：方法未登记 schema 即无法在 server 暴露（04 ADR-07 强制机制）。
 * 当前覆盖（07 §2.1 M1 P0 22 方法全集 + P1 permission.rules.* 3 方法 + T2.3 subagent 4 方法
 * + T2.4 memory 域 5 方法）：
 * system.ping/version/shutdown；session.create/send/steer/cancel/list/resume/archive/setMode；
 * config.get/set/providers.list/add/remove；tool.tools.list + 后台任务三方法；permission 5 方法；
 * subagent.spawn/stop/list/profiles.list；memory.read/write/search/entries.list/promote。
 */
export const METHOD_SCHEMAS: Readonly<Record<string, MethodSchemas>> = {
  "system.ping": { request: systemPingParamsSchema, response: systemPingResultSchema },
  "system.version": { request: systemVersionParamsSchema, response: systemVersionResultSchema },
  "system.shutdown": { request: systemShutdownParamsSchema, response: systemShutdownResultSchema },
  "session.create": { request: sessionCreateParamsSchema, response: sessionCreateResultSchema },
  "session.send": { request: sessionSendParamsSchema, response: sessionSendResultSchema },
  "session.steer": { request: sessionSteerParamsSchema, response: sessionSteerResultSchema },
  "session.cancel": { request: sessionCancelParamsSchema, response: sessionCancelResultSchema },
  "session.list": { request: sessionListParamsSchema, response: sessionListResultSchema },
  "session.resume": { request: sessionResumeParamsSchema, response: sessionResumeResultSchema },
  "session.archive": { request: sessionArchiveParamsSchema, response: sessionArchiveResultSchema },
  "session.setMode": { request: sessionSetModeParamsSchema, response: sessionSetModeResultSchema },
  "session.compact": { request: sessionCompactParamsSchema, response: sessionCompactResultSchema },
  "config.get": { request: configGetParamsSchema, response: configGetResultSchema },
  "config.set": { request: configSetParamsSchema, response: configSetResultSchema },
  "config.providers.list": {
    request: configProvidersListParamsSchema,
    response: configProvidersListResultSchema,
  },
  "config.providers.add": {
    request: configProvidersAddParamsSchema,
    response: configProvidersAddResultSchema,
  },
  "config.providers.remove": {
    request: configProvidersRemoveParamsSchema,
    response: configProvidersRemoveResultSchema,
  },
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
  "permission.respond": {
    request: permissionRespondParamsSchema,
    response: permissionRespondResultSchema,
  },
  "permission.rules.list": {
    request: permissionRulesListParamsSchema,
    response: permissionRulesListResultSchema,
  },
  "permission.rules.add": {
    request: permissionRulesAddParamsSchema,
    response: permissionRulesAddResultSchema,
  },
  "permission.rules.remove": {
    request: permissionRulesRemoveParamsSchema,
    response: permissionRulesRemoveResultSchema,
  },
  "permission.decisions.list": {
    request: permissionDecisionsListParamsSchema,
    response: permissionDecisionsListResultSchema,
  },
  "mcp.servers.list": { request: mcpServersListParamsSchema, response: mcpServersListResultSchema },
  "mcp.servers.add": { request: mcpServersAddParamsSchema, response: mcpServersAddResultSchema },
  "mcp.servers.remove": { request: mcpServersRemoveParamsSchema, response: mcpServersRemoveResultSchema },
  "mcp.servers.retry": { request: mcpServersRetryParamsSchema, response: mcpServersRetryResultSchema },
  "mcp.tools.list": { request: mcpToolsListParamsSchema, response: mcpToolsListResultSchema },
  "mcp.tools.call": { request: mcpToolsCallParamsSchema, response: mcpToolsCallResultSchema },
  "subagent.spawn": { request: subagentSpawnParamsSchema, response: subagentSpawnResultSchema },
  "subagent.stop": { request: subagentStopParamsSchema, response: subagentStopResultSchema },
  "subagent.list": { request: subagentListParamsSchema, response: subagentListResultSchema },
  "subagent.profiles.list": {
    request: subagentProfilesListParamsSchema,
    response: subagentProfilesListResultSchema,
  },
  "memory.read": { request: memoryReadParamsSchema, response: memoryReadResultSchema },
  "memory.write": { request: memoryWriteParamsSchema, response: memoryWriteResultSchema },
  "memory.search": { request: memorySearchParamsSchema, response: memorySearchResultSchema },
  "memory.entries.list": {
    request: memoryEntriesListParamsSchema,
    response: memoryEntriesListResultSchema,
  },
  "memory.promote": { request: memoryPromoteParamsSchema, response: memoryPromoteResultSchema },
};

/**
 * 事件 payload 注册表（06 §3）：事件出口经构造函数生成、出口即合法；
 * 客户端校验仅为开发模式断言（04 §4.3）。
 */
export const EVENT_SCHEMAS: Readonly<Record<string, ZodTypeAny>> = {
  "session.created": sessionCreatedEventPayloadSchema,
  "message.delta": messageDeltaEventPayloadSchema,
  "message.completed": messageCompletedEventPayloadSchema,
  "turn.phase_changed": turnPhaseChangedEventPayloadSchema,
  "tool_call.started": toolCallStartedEventPayloadSchema,
  "tool_call.progress": toolCallProgressEventPayloadSchema,
  "tool_call.completed": toolCallCompletedEventPayloadSchema,
  done: doneEventPayloadSchema,
  error: errorEventPayloadSchema,
  "session.snapshot": sessionSnapshotEventPayloadSchema,
  "permission.requested": permissionRequestedEventPayloadSchema,
  "permission.resolved": permissionResolvedEventPayloadSchema,
  "compact.started": compactStartedEventPayloadSchema,
  "compact.completed": compactCompletedEventPayloadSchema,
  "mcp.server_status_changed": mcpServerStatusChangedEventPayloadSchema,
  "subagent.spawned": subagentSpawnedEventPayloadSchema,
  "subagent.progress": subagentProgressEventPayloadSchema,
  "subagent.completed": subagentCompletedEventPayloadSchema,
};

export { buildPermissionRequestedEvent, buildPermissionResolvedEvent };
export { buildCompactStartedEvent, buildCompactCompletedEvent };
export { buildMcpServerStatusChangedEvent };
export { buildSubagentSpawnedEvent, buildSubagentProgressEvent, buildSubagentCompletedEvent };
