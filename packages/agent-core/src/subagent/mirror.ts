/**
 * 子会话事件镜像（02-module-design §4.2 映射表 + §4.4 节流策略）：
 *
 * - 子会话事件经 SessionEventPublisher 形态（{ name, payload }）进入本模块；
 * - `tool_call.started` → progress{stage:"tool", toolName, summary}（500ms 窗口合并去重）；
 * - 子会话首个事件（或 submit 已知 started）→ progress{stage:"started"}（幂等补发）；
 * - done/failed 终局性 progress 由 manager 在子 turn 收束时经本模块发出，永不合并；
 * - message.delta 等其余子事件不镜像（主会话只关心子代理在做什么，不消费逐字流）。
 */
import type { SubagentId, TokenUsage } from "@novacode/shared";

/** 主会话通知事件（06-api-spec §3.2 C 组 subagent.* 的内核层投影，02 §4.3 SubagentEvent）。 */
export type SubagentEvent =
  | {
      kind: "spawned";
      subagentId: SubagentId;
      profileName: string;
      taskPreview: string;
      status: "Pending" | "Running";
      queuePosition?: number;
    }
  | {
      kind: "progress";
      subagentId: SubagentId;
      stage: "started" | "tool" | "done" | "failed";
      toolName?: string;
      summary?: string;
    }
  | {
      kind: "completed";
      subagentId: SubagentId;
      status: "Completed" | "Failed" | "Stopped";
      summary: string;
      usage: TokenUsage;
      turnsUsed: number;
    };

export type SubagentEventListener = (event: SubagentEvent) => void;

/** progress{stage:"tool"} 的合并窗口（02 §4.4 / 06 §3.4：500ms）。 */
export const SUBAGENT_PROGRESS_MERGE_MS = 500;

/** 预览/摘要截断上限（taskPreview、工具输入摘要；防镜像事件膨胀）。 */
export const PREVIEW_MAX_CHARS = 120;

/** 单行预览：压缩空白后截断（超限附省略号）。 */
export function previewText(text: string, max = PREVIEW_MAX_CHARS): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max)}…`;
}

/**
 * 单个子代理的镜像器（每 spawn 一个实例；合并状态随实例走，终态后由 manager 停用入口）。
 */
export class SubagentMirror {
  private startedEmitted = false;
  private lastToolEmitAt = 0;

  constructor(
    private readonly subagentId: SubagentId,
    private readonly emit: (event: SubagentEvent) => void,
    private readonly mergeWindowMs = SUBAGENT_PROGRESS_MERGE_MS,
  ) {}

  /** 子会话事件入口（host.spawnLoop 的 onChildEvent 直通）。 */
  onChildEvent(event: { name: string; payload: unknown }): void {
    // 首个子事件补发 started（submit 排队场景由此收敛，02 §4.2）
    this.markStarted();
    if (event.name !== "tool_call.started") return;
    const payload = event.payload as { toolName?: unknown; input?: unknown } | null;
    const toolName = typeof payload?.toolName === "string" ? payload.toolName : "unknown";
    // 500ms 窗口合并（惰性时间戳法：首条立即发、窗口内后续丢弃；无定时器，02 §4.4）
    const now = Date.now();
    if (now - this.lastToolEmitAt < this.mergeWindowMs) return;
    this.lastToolEmitAt = now;
    const summary = previewText(summarizeInput(payload?.input));
    this.emit({
      kind: "progress",
      subagentId: this.subagentId,
      stage: "tool",
      toolName,
      ...(summary.length > 0 && { summary }),
    });
  }

  /** started 通知（幂等）：submit 已知 started 或首个子事件到达时补发。 */
  markStarted(): void {
    if (this.startedEmitted) return;
    this.startedEmitted = true;
    this.emit({ kind: "progress", subagentId: this.subagentId, stage: "started" });
  }

  /** done 通知（子 turn 正常收束，永不合并，02 §4.4）。 */
  emitDone(): void {
    this.emit({ kind: "progress", subagentId: this.subagentId, stage: "done" });
  }

  /** failed 通知（子 turn 失败/取消，永不合并；summary 为错误消息或取消说明）。 */
  emitFailed(summary?: string): void {
    this.emit({
      kind: "progress",
      subagentId: this.subagentId,
      stage: "failed",
      ...(summary !== undefined && { summary }),
    });
  }
}

/** 工具输入摘要：字符串直用，其余 JSON 序列化（失败降级 String，阻断不了镜像路径）。 */
function summarizeInput(input: unknown): string {
  if (input === undefined || input === null) return "";
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input) ?? "";
  } catch {
    return String(input);
  }
}
