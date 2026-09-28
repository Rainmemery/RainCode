/**
 * @novacode/llm —— OpenAI 兼容协议适配（04-architecture §2.1）。
 *
 * 本包唯一 publicEntrypoint（architecture/policy.yaml）；只依赖 @novacode/shared。
 * 职责：流式 Chat Completions 客户端 + SSE 归一化（02 §1.2.4 统一事件）。
 * 不感知会话/工具语义；Provider 预设与工具 schema 编码随后续波次补充。
 */

export { LlmClient, normalizeBaseUrl } from "./client.js";

export { LlmError, LlmHttpError, LlmNetworkError, LlmAbortedError, LlmParseError } from "./errors.js";
export type { LlmErrorCode } from "./errors.js";

export { SseParser } from "./sse.js";
export type { SseDataEvent } from "./sse.js";

export type {
  ChatCompletionStreamRequest,
  ChatFunctionToolCall,
  ChatRequestMessage,
  FetchLike,
  LlmClientOptions,
  LlmStreamEvent,
  LlmStreamResult,
} from "./types.js";
