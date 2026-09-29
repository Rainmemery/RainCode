/**
 * llm 包协议类型：OpenAI Chat Completions 请求/流式 chunk 的最小线格式，
 * 以及归一化后的统一流事件（02-module-design §1.2.4 映射表左列）。
 *
 * 会话/工具语义不进本包：消息数组由调用方（agent-core）组装传入；
 * usage 复用 @raincode/shared 的 TokenUsage（跨包契约真源）。
 */
import type { ProviderInput, TokenUsage } from "@raincode/shared";

// ---------------------------------------------------------------------------
// 请求侧消息（OpenAI Chat Completions 线格式，walking skeleton 最小子集）
// ---------------------------------------------------------------------------

export interface ChatFunctionToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatRequestMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ChatFunctionToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

/** 请求侧 function 工具描述（OpenAI tools 线格式；parameters 由调用方投影为 JSON Schema）。 */
export interface LlmFunctionTool {
  type: "function";
  function: { name: string; description?: string; parameters: unknown };
}

// ---------------------------------------------------------------------------
// 流式 chunk 线格式（仅声明本包消费的字段，未知字段忽略）
// ---------------------------------------------------------------------------

export interface ChatCompletionChunkChoiceDelta {
  role?: string;
  content?: string | null;
  /** DeepSeek 等兼容端在 delta 上携带的思考过程字段（02 §1.2.4 delta.reasoning）。 */
  reasoning_content?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

export interface ChatCompletionChunkChoice {
  index?: number;
  delta?: ChatCompletionChunkChoiceDelta;
  finish_reason?: string | null;
}

export interface ChatCompletionUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
}

export interface ChatCompletionChunk {
  choices?: ChatCompletionChunkChoice[];
  usage?: ChatCompletionUsage | null;
}

// ---------------------------------------------------------------------------
// 归一化流事件（02 §1.2.4 左列；纯转换、不缓冲全文、不做业务判断）
// ---------------------------------------------------------------------------

export type LlmStreamEvent =
  | { type: "stream.opened" }
  | { type: "role"; role: string }
  | { type: "delta.text"; text: string }
  | { type: "delta.reasoning"; text: string }
  | {
      type: "delta.tool_call";
      index: number;
      toolCallId?: string;
      toolName?: string;
      argsPartial?: string;
    }
  | {
      /** 流式 tool_call delta 累积完成（index 分组、name/arguments 增量拼接，finish tool_calls 时发出）。 */
      type: "tool_calls.completed";
      calls: Array<{ toolCallId: string; toolName: string; argumentsJSON: string }>;
    }
  | { type: "finish"; finishReason: string | null }
  | { type: "usage"; usage: TokenUsage }
  | { type: "done" };

// ---------------------------------------------------------------------------
// 客户端配置与请求
// ---------------------------------------------------------------------------

/** 可注入 fetch（测试用 mock 服务器）；缺省用 Node 22 全局 fetch。 */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface LlmClientOptions {
  /**
   * Provider 配置：类型与运行时校验均复用 @raincode/shared 的
   * ProviderInput / providerInputSchema（含 name 与 maxContextTokens，zod 单一事实源）。
   * 只消费 baseURL / model；apiKeyRef 的解析由调用方完成——llm 不读文件、不读环境。
   */
  provider: ProviderInput;
  /** 调用方解析 apiKeyRef 后注入的明文 key；null/undefined 表示本地 Provider 无凭据。 */
  apiKey?: string | null;
  /** 测试注入；缺省 Node 全局 fetch。 */
  fetchImpl?: FetchLike;
  /** 附加请求头（如 organization）。凭据类头仍应由调用方通过 apiKey 传递。 */
  defaultHeaders?: Record<string, string>;
}

export interface ChatCompletionStreamRequest {
  /** 缺省取 provider.model。 */
  model?: string;
  messages: ChatRequestMessage[];
  /** 可用 function 工具（OpenAI tools 线格式；缺省不携带）。 */
  tools?: LlmFunctionTool[];
  maxTokens?: number;
  temperature?: number;
  /** true 时请求 stream_options.include_usage，末尾 chunk 携带 usage。 */
  includeUsage?: boolean;
  /** 贯穿取消：请求前、请求中、流读取中全程生效。 */
  signal?: AbortSignal;
  onEvent: (event: LlmStreamEvent) => void | Promise<void>;
}

/** 流正常结束的汇总结果（finish/usage 事件的最终值；正文不在此缓冲，增量经回调交付）。 */
export interface LlmStreamResult {
  finishReason: string | null;
  usage?: TokenUsage;
}
