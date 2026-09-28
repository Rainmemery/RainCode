/**
 * llm 包类型化错误（02-module-design §1.2.4 stream.error 归一化来源）。
 *
 * 错误码即walking skeleton 契约：LLM_HTTP_ERROR / LLM_NETWORK_ERROR / LLM_ABORTED / LLM_PARSE_ERROR。
 * 安全约束（04-architecture §5.3）：错误信息只含响应状态与响应体摘要，
 * 不携带请求头与 URL——避免 apiKey 等凭据片段经 turn_failed 事件进入会话流。
 */

export type LlmErrorCode =
  | "LLM_HTTP_ERROR"
  | "LLM_NETWORK_ERROR"
  | "LLM_ABORTED"
  | "LLM_PARSE_ERROR";

/** HTTP 响应体摘要截断长度：足够定位 4xx/5xx 报错，又不至于把大响应灌进错误对象。 */
const BODY_SUMMARY_MAX_CHARS = 2048;

export class LlmError extends Error {
  readonly code: LlmErrorCode;

  constructor(code: LlmErrorCode, message: string) {
    super(message);
    this.name = "LlmError";
    this.code = code;
  }
}

/** Provider 返回非 2xx（含 401/403/429/5xx）。bodySummary 为响应体原文前缀摘要。 */
export class LlmHttpError extends LlmError {
  readonly status: number;
  readonly bodySummary: string;

  constructor(status: number, bodySummary: string) {
    super(
      "LLM_HTTP_ERROR",
      `provider responded ${status}: ${truncate(bodySummary, BODY_SUMMARY_MAX_CHARS)}`,
    );
    this.name = "LlmHttpError";
    this.status = status;
    this.bodySummary = bodySummary.slice(0, BODY_SUMMARY_MAX_CHARS);
  }
}

/** 连接建立失败或流读取中断（非主动取消）。cause 保留原始错误供诊断。 */
export class LlmNetworkError extends LlmError {
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super("LLM_NETWORK_ERROR", `LLM_NETWORK_ERROR: ${message}`);
    this.name = "LlmNetworkError";
    this.cause = cause;
  }
}

/** AbortSignal 触发的取消（请求前已中止 / 请求中 / 流读取中）。 */
export class LlmAbortedError extends LlmError {
  constructor(message = "LLM_ABORTED: stream aborted by caller") {
    super("LLM_ABORTED", message);
    this.name = "LlmAbortedError";
  }
}

/** SSE data 帧不是合法 JSON（或响应缺流式 body）。rawSummary 保留原始片段帮助定位。 */
export class LlmParseError extends LlmError {
  readonly rawSummary: string;

  constructor(message: string, rawSummary: string) {
    super("LLM_PARSE_ERROR", `LLM_PARSE_ERROR: ${message}`);
    this.name = "LlmParseError";
    this.rawSummary = rawSummary.slice(0, 512);
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…(truncated)`;
}

/** 归一 fetch 抛出的中止类错误：Node 全局 fetch 中止时 reject AbortError/DOMException。 */
export function isAbortReason(reason: unknown): boolean {
  return (
    reason instanceof Error &&
    (reason.name === "AbortError" || reason.name === "TimeoutError")
  );
}
