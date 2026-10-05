/**
 * 结构化回合错误（polish-ui-states-and-runtime §A2 回合失败重试）：
 * `error` 事件 payload（06 §3.2 A 组）= `{ scope, code, message, recoverable, turnId? }`
 * → 端层错误切片（ChatFlow 失败卡 + 重试）。与桌面端同构镜像（同一状态形状、同一解析语义）；
 * 纯函数便于单测驱动（node:test 无 DOM 依赖），沿用 subagent-view / compact-view 拆分纪律。
 */

/** 错误作用域（06 §3.2：turn 回合失败 / session 会话级 / system 传输层上抛）。 */
export type TurnErrorScope = "turn" | "session" | "system";

/** 结构化错误投影（recoverable === true 时呈现「重试」）。 */
export interface TurnError {
  scope: TurnErrorScope;
  code: string;
  message: string;
  recoverable: boolean;
  turnId?: string;
}

/** 端层结构化错误切片（WebState 组合；无结构化字段时为 null，回落既有字符串横条）。 */
export interface TurnErrorState {
  turnError: TurnError | null;
}

/**
 * `error` 事件 payload → TurnError（纯函数，任何畸形输入均不抛异常）。
 * 缺 `code` / `recoverable`（旧端或异常路径）→ null（回落既有横条，05 §7.4 兼容口径）；
 * `scope` 非法（协议外）→ 保底 `system`（仍可判读，不吞错误）；
 * 兼容历史嵌套形态 `{ error: { ... } }`（扁平字段优先）。
 */
export function parseTurnError(payload: Record<string, unknown>): TurnError | null {
  const nested = payload["error"];
  const source: Record<string, unknown> =
    typeof payload["code"] === "string" && typeof payload["recoverable"] === "boolean"
      ? payload
      : typeof nested === "object" && nested !== null
        ? (nested as Record<string, unknown>)
        : payload;
  const code = source["code"];
  const recoverable = source["recoverable"];
  if (typeof code !== "string" || code.length === 0 || typeof recoverable !== "boolean") return null;
  const scopeRaw = source["scope"];
  const scope: TurnErrorScope =
    scopeRaw === "turn" || scopeRaw === "session" || scopeRaw === "system" ? scopeRaw : "system";
  const message = typeof source["message"] === "string" ? source["message"] : "";
  const turnId = typeof source["turnId"] === "string" ? source["turnId"] : undefined;
  return { scope, code, message, recoverable, ...(turnId !== undefined && { turnId }) };
}

/** 既有字符串横条文案（扁平 message 优先，兼容历史嵌套形态）。 */
function extractErrorMessage(payload: Record<string, unknown>): string | undefined {
  if (typeof payload["message"] === "string") return payload["message"];
  const nested = payload["error"];
  if (typeof nested === "object" && nested !== null) {
    const message = (nested as Record<string, unknown>)["message"];
    if (typeof message === "string") return message;
  }
  return undefined;
}

/**
 * `error` 事件 → 端层错误切片：`error` 字符串保留既有消费路径（横幅零回归）；
 * `turnError` 为结构化增量（ChatFlow 失败卡；缺结构化字段时为 null）。
 */
export function applyErrorEvent(payload: Record<string, unknown>): { error: string; turnError: TurnError | null } {
  return { error: extractErrorMessage(payload) ?? "turn error", turnError: parseTurnError(payload) };
}
