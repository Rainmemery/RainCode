/**
 * LlmClient：OpenAI Chat Completions 流式客户端（stream: true）。
 *
 * 边界（02-module-design §0.2 / 04-architecture §2.1）：
 * - 只做协议适配：SSE 归一化为统一流事件（§1.2.4 左列），不感知会话/工具语义；
 * - 消息历史由调用方组装传入；apiKeyRef 解析由调用方完成后经 apiKey 注入——
 *   本包不读文件、不读环境（04 §5.3 运行时生命周期约束）；
 * - 多 Provider 原生适配不做：OpenAI 兼容协议已覆盖 walking skeleton（ADR-10）。
 *
 * baseURL 兼容规则：尾斜杠归一；仅原点（无路径）时补 /v1（OpenAI 兼容端惯例），
 * 已带路径（含 /v1 或自定义前缀）则尊重原值，最终请求 {base}/chat/completions。
 */
import { providerInputSchema } from "@novacode/shared";
import type { TokenUsage } from "@novacode/shared";

import { LlmAbortedError, LlmError, LlmHttpError, LlmNetworkError, LlmParseError, isAbortReason } from "./errors.js";
import { SseParser } from "./sse.js";
import type {
  ChatCompletionChunk,
  ChatCompletionStreamRequest,
  FetchLike,
  LlmClientOptions,
  LlmStreamResult,
} from "./types.js";
import type { ChatCompletionUsage } from "./types.js";

const DONE_SENTINEL = "[DONE]";

/** 归一 baseURL：去尾斜杠；仅原点时补 /v1。 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  let pathname: string;
  try {
    pathname = new URL(trimmed).pathname;
  } catch {
    throw new LlmParseError(`invalid provider baseURL: ${JSON.stringify(raw)}`, raw);
  }
  return pathname === "" || pathname === "/" ? `${trimmed}/v1` : trimmed;
}

export class LlmClient {
  private readonly provider: { baseURL: string; model: string };
  private readonly apiKey: string | null;
  private readonly fetchImpl: FetchLike;
  private readonly defaultHeaders: Record<string, string>;

  constructor(options: LlmClientOptions) {
    // 单点复用 shared schema 校验（zod 运行时经 @novacode/shared 解析，本包不直接依赖 zod）
    const parsed = providerInputSchema.parse(options.provider);
    this.provider = { baseURL: parsed.baseURL, model: parsed.model };
    this.apiKey = options.apiKey ?? null;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.defaultHeaders = options.defaultHeaders ?? {};
  }

  /**
   * 发起一次流式 Chat Completions 请求。
   * delta 经 onEvent 逐个回调（text / role / tool_call / finish / usage / done）；
   * 正文不在此缓冲（02 §1.2.4：映射为纯转换层）。
   */
  async streamChat(request: ChatCompletionStreamRequest): Promise<LlmStreamResult> {
    const { signal, onEvent } = request;
    if (signal?.aborted) {
      throw new LlmAbortedError();
    }

    const url = `${normalizeBaseUrl(this.provider.baseURL)}/chat/completions`;
    const body: Record<string, unknown> = {
      model: request.model ?? this.provider.model,
      messages: request.messages,
      stream: true,
    };
    if (request.maxTokens !== undefined) {
      body.max_tokens = request.maxTokens;
    }
    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }
    if (request.includeUsage) {
      body.stream_options = { include_usage: true };
    }

    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
      ...this.defaultHeaders,
    };
    if (this.apiKey !== null && this.apiKey !== "") {
      headers.authorization = `Bearer ${this.apiKey}`;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (reason: unknown) {
      if (signal?.aborted || isAbortReason(reason)) {
        throw new LlmAbortedError();
      }
      throw new LlmNetworkError("failed to connect to provider", reason);
    }

    if (!response.ok) {
      const text = await safeReadText(response, signal);
      throw new LlmHttpError(response.status, text);
    }
    if (!response.body) {
      throw new LlmNetworkError("provider response has no streaming body");
    }

    await onEvent({ type: "stream.opened" });

    const parser = new SseParser();
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    const result: LlmStreamResult = { finishReason: null };

    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        const frames = parser.push(decoder.decode(chunk.value, { stream: true }));
        for (const frame of frames) {
          const finished = await this.handleData(frame.data, onEvent, result);
          if (finished) {
            return result; // [DONE]：标准结束点，直接收束
          }
        }
      }
      // 流未以 [DONE] 收尾（部分兼容端如此）：交付残余帧后正常返回
      for (const frame of parser.flush()) {
        await this.handleData(frame.data, onEvent, result);
      }
      return result;
    } catch (reason: unknown) {
      if (reason instanceof LlmError) {
        throw reason; // LlmParseError 等保持原错误码，不误报为网络错误
      }
      if (signal?.aborted || isAbortReason(reason)) {
        throw new LlmAbortedError();
      }
      throw new LlmNetworkError("stream read failed", reason);
    } finally {
      // 提前收束（[DONE] 早退 / 异常路径）时释放底层流，归还连接
      void reader.cancel().catch(() => {});
    }
  }

  /** 处理单个 data 帧；返回 true 表示收到 [DONE]。 */
  private async handleData(
    data: string,
    onEvent: ChatCompletionStreamRequest["onEvent"],
    result: LlmStreamResult,
  ): Promise<boolean> {
    if (data === DONE_SENTINEL) {
      await onEvent({ type: "done" });
      return true;
    }
    let parsed: ChatCompletionChunk;
    try {
      parsed = JSON.parse(data) as ChatCompletionChunk;
    } catch (reason: unknown) {
      throw new LlmParseError(`sse data frame is not valid JSON (${String(reason)})`, data);
    }

    const choice = parsed.choices?.[0];
    if (choice) {
      const delta = choice.delta;
      if (delta?.role !== undefined && delta.role !== "") {
        await onEvent({ type: "role", role: delta.role });
      }
      if (typeof delta?.content === "string" && delta.content.length > 0) {
        await onEvent({ type: "delta.text", text: delta.content });
      }
      if (typeof delta?.reasoning_content === "string" && delta.reasoning_content.length > 0) {
        await onEvent({ type: "delta.reasoning", text: delta.reasoning_content });
      }
      if (delta?.tool_calls) {
        for (const call of delta.tool_calls) {
          await onEvent({
            type: "delta.tool_call",
            index: call.index,
            ...(call.id !== undefined && { toolCallId: call.id }),
            ...(call.function?.name !== undefined && { toolName: call.function.name }),
            ...(call.function?.arguments !== undefined && { argsPartial: call.function.arguments }),
          });
        }
      }
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        result.finishReason = choice.finish_reason;
        await onEvent({ type: "finish", finishReason: choice.finish_reason });
      }
    }

    if (parsed.usage) {
      const usage = mapUsage(parsed.usage);
      if (usage) {
        result.usage = usage;
        await onEvent({ type: "usage", usage });
      }
    }
    return false;
  }
}

async function safeReadText(response: Response, signal?: AbortSignal): Promise<string> {
  try {
    return await response.text();
  } catch (reason: unknown) {
    if (signal?.aborted || isAbortReason(reason)) {
      throw new LlmAbortedError();
    }
    return `<failed to read error body: ${String(reason)}>`;
  }
}

/** OpenAI usage → shared TokenUsage（04 §5.2 四要素之外的跨包契约复用）。 */
function mapUsage(usage: ChatCompletionUsage): TokenUsage | null {
  const inputTokens = usage.prompt_tokens;
  const outputTokens = usage.completion_tokens;
  if (typeof inputTokens !== "number" || typeof outputTokens !== "number") {
    return null; // usage 形态不完整时丢弃，不让坏帧污染累计口径
  }
  const cached = usage.prompt_tokens_details?.cached_tokens;
  return {
    inputTokens,
    outputTokens,
    ...(typeof cached === "number" && cached > 0 && { cachedTokens: cached }),
  };
}
