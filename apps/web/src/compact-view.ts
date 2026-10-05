/**
 * 压缩可视化与事件归并纯函数（ui-panel-deepening 轮，仿 subagent-view.ts 模式）：
 * compact.started / compact.completed（06 §3.5 C 组压缩生命周期）→ 单行提示条投影
 * （ChatFlow 消息流顶部渲染）。与桌面端 compact-view 同构镜像（同一状态形状、同一事件语义）。
 */

/** 压缩提示条（瞬态投影；selectSession 切会话重置，ok / failed 由用户 dismiss）。 */
export interface CompactionBanner {
  sessionId: string;
  phase: "running" | "ok" | "failed";
  /** 压缩代际（06 §3.5 epoch；「第 N 代」展示口径）。 */
  epoch: number;
  trigger: "auto" | "manual";
  tokensBefore?: number;
  tokensAfter?: number;
  /** failed 且 failure.reason 为字符串时携带。 */
  reason?: string;
}

/**
 * 压缩生命周期事件归并：仅当 payload.sessionId 为字符串且 === state.activeId 时应用。
 * - compact.started → { phase: "running", epoch, trigger }（epoch/trigger 类型不符取缺省 0/manual）；
 * - compact.completed → phase = ok === true ? "ok" : "failed"，tokensBefore/tokensAfter 仅在
 *   number 时附加，reason 仅在 failed 且 failure.reason 为字符串时附加；epoch/trigger 沿用
 *   started 阶段值（completed 不携带 trigger），无 started 前文时回退 payload.epoch / manual；
 * - 其余事件名原样返回（同引用），payload 字段类型不符一律忽略该字段。
 */
export function applyCompactEvent(
  state: { activeId: string | null; compaction: CompactionBanner | null },
  name: string,
  payload: Record<string, unknown>,
): { activeId: string | null; compaction: CompactionBanner | null } {
  if (name !== "compact.started" && name !== "compact.completed") return state;
  const sessionId = payload["sessionId"];
  if (typeof sessionId !== "string" || sessionId !== state.activeId) return state;
  const epoch = typeof payload["epoch"] === "number" ? payload["epoch"] : state.compaction?.epoch ?? 0;

  if (name === "compact.started") {
    return {
      ...state,
      compaction: {
        sessionId,
        phase: "running",
        epoch: typeof payload["epoch"] === "number" ? payload["epoch"] : 0,
        trigger: payload["trigger"] === "auto" ? "auto" : "manual",
      },
    };
  }

  // compact.completed：epoch 取 payload（缺省沿用 started）；trigger 沿用 started（事件不携带）
  const ok = payload["ok"] === true;
  const failure = payload["failure"] as { reason?: unknown } | undefined;
  return {
    ...state,
    compaction: {
      sessionId,
      phase: ok ? "ok" : "failed",
      epoch,
      trigger: state.compaction?.trigger ?? "manual",
      ...(typeof payload["tokensBefore"] === "number" && { tokensBefore: payload["tokensBefore"] as number }),
      ...(typeof payload["tokensAfter"] === "number" && { tokensAfter: payload["tokensAfter"] as number }),
      ...(!ok && failure !== undefined && typeof failure["reason"] === "string" && { reason: failure["reason"] as string }),
    },
  };
}
