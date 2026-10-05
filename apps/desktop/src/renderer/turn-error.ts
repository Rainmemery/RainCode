/**
 * 回合错误结构化投影与纯解析（polish-ui-states-and-runtime 轮；仿 subagent-view / compact-view
 * 自 session-view 拆分的既有纪律）：`error` 事件 payload = `{ scope, code, message, recoverable,
 * turnId? }`（events-turn.ts errorEventPayloadSchema / 06 §3.2）。
 *
 * 端层此前仅保留 message 字符串；本模块把结构化字段解析为 `TurnError`，供会话流失败卡
 * （含 code / recoverable → 「重试」入口）消费。字段缺省/类型不符 → null（回落既有字符串横条，
 * 兼容旧端与异常路径）。与 Web 端 turn-error 同构镜像（同形状、同回落语义）。
 * `TurnErrorState` / `applyErrorEvent` 为桌面端 reducer 接线（保 session-view ≤500 行治理），
 * 语义与 Web 端 session-view 的 error 分支逐条一致。
 */
export type TurnErrorScope = "turn" | "session" | "system";

export interface TurnError {
  scope: TurnErrorScope;
  code: string;
  message: string;
  /** 可重试标记（06 §3.2）；仅显式 true 才呈现「重试」，缺省视为不可重试。 */
  recoverable: boolean;
  turnId?: string;
}

/** 端层结构化错误切片（DesktopState 组合；切会话 / 新回合清空）。 */
export interface TurnErrorState {
  turnError: TurnError | null;
}

const TURN_ERROR_SCOPES: readonly TurnErrorScope[] = ["turn", "session", "system"];

/**
 * 解析 error 事件的结构化投影（入参可为整个 payload 或包裹的 error 对象）。
 * 非结构化/字段缺省一律返回 null（不抛错）：缺 message、缺非空 code、scope 非法 —— 均由
 * 会话流回落既有字符串横条（兼容旧端与异常路径）。与 Web 端 parseTurnError 同语义。
 */
export function parseTurnError(value: unknown): TurnError | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const message = record["message"];
  const code = record["code"];
  if (typeof message !== "string" || typeof code !== "string" || code.length === 0) return null;
  const scopeRaw = record["scope"];
  if (typeof scopeRaw !== "string" || !(TURN_ERROR_SCOPES as readonly string[]).includes(scopeRaw)) {
    return null; // 未知 scope 视为非结构化（保守回落，不臆造回合归属）
  }
  const turnId = record["turnId"];
  return {
    scope: scopeRaw as TurnErrorScope,
    code,
    message,
    recoverable: record["recoverable"] === true,
    ...(typeof turnId === "string" && turnId.length > 0 && { turnId }),
  };
}

/**
 * error 事件 → 端层错误切片：字符串通道保持既有消费路径（App 横条零回归），并行产出结构化
 * turnError（缺字段 → null 回落字符串横条）。逐条等价 Web 端 session-view 的 error 分支。
 */
export function applyErrorEvent(payload: Record<string, unknown>): { error: string; turnError: TurnError | null } {
  const wrapped = payload["error"] as { message?: string } | undefined;
  const message =
    typeof wrapped?.message === "string" ? wrapped.message : typeof payload["message"] === "string" ? payload["message"] : undefined;
  return { error: message ?? "turn error", turnError: parseTurnError(wrapped !== undefined ? wrapped : payload) };
}
