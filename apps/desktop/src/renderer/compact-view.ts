/**
 * 上下文压缩呈现（UI 管理面板深化轮，仿 subagent-view.ts 纯函数模式）：
 * compact.started / compact.completed 事件 → 单行提示条状态（ChatFlow 消费）。
 * 与 Web 端同构镜像（同一状态形状、同一事件语义）；纯函数便于单测驱动，node 单测无 DOM 依赖。
 */

/**
 * 压缩提示条状态（06 §3.5 C 组压缩生命周期投影）：
 * running 由 started 置位；ok/failed 由 completed 收束（tokens/reason 类型守卫）；
 * trigger 为 started 的触发口径（completed 事件不带，沿用 running 态）。
 */
export interface CompactionBanner {
  sessionId: string;
  phase: "running" | "ok" | "failed";
  epoch: number;
  trigger: "auto" | "manual";
  tokensBefore?: number;
  tokensAfter?: number;
  reason?: string;
}

/**
 * 压缩事件归并：仅 payload.sessionId === state.activeId 时应用（他会话事件原样返回）；
 * started → running；completed → ok?"ok":"failed"（附 tokens/reason，字段类型守卫）；
 * 其余事件名或 sessionId 非字符串原样返回。
 */
export function applyCompactEvent(
  state: { activeId: string | null; compaction: CompactionBanner | null },
  name: string,
  payload: Record<string, unknown>,
): { activeId: string | null; compaction: CompactionBanner | null } {
  const sessionId = payload["sessionId"];
  if (typeof sessionId !== "string" || sessionId !== state.activeId) return state;
  const epoch = typeof payload["epoch"] === "number" ? payload["epoch"] : 0;

  if (name === "compact.started") {
    return {
      activeId: state.activeId,
      compaction: {
        sessionId,
        phase: "running",
        epoch,
        trigger: payload["trigger"] === "auto" ? "auto" : "manual",
      },
    };
  }

  if (name === "compact.completed") {
    const tokensBefore = typeof payload["tokensBefore"] === "number" ? payload["tokensBefore"] : undefined;
    const tokensAfter = typeof payload["tokensAfter"] === "number" ? payload["tokensAfter"] : undefined;
    const failure = payload["failure"];
    const reason =
      typeof failure === "object" && failure !== null && typeof (failure as { reason?: unknown }).reason === "string"
        ? (failure as { reason: string }).reason
        : undefined;
    return {
      activeId: state.activeId,
      compaction: {
        sessionId,
        phase: payload["ok"] === true ? "ok" : "failed",
        epoch,
        trigger: state.compaction?.trigger ?? "manual",
        ...(tokensBefore !== undefined && { tokensBefore }),
        ...(tokensAfter !== undefined && { tokensAfter }),
        ...(reason !== undefined && { reason }),
      },
    };
  }

  return state;
}
