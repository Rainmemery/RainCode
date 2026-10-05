/**
 * 会话流（UI-5；UI 重构轮消息渲染抽出至 MessageBubble/Markdown 并 memo 化；refine-ui-context-panel
 * 轮增子代理进度卡；ui-panel-deepening 轮增压缩提示条）：消息气泡、ToolCard 五状态、hook 执行行、
 * 子代理 violet 进度卡、压缩生命周期单行提示条、空态 ASCII 引导、审批中琥珀横条、自动滚动。
 */
import { memo, useEffect, useRef, useState } from "react";
import { useWeb } from "../state.js";
import { MessageBubble } from "./MessageBubble.js";
import { ToolCard } from "./ToolCard.js";
import type { HookItem } from "../session-view.js";
import type { SubagentRecord } from "../subagent-view.js";
import type { CompactionBanner } from "../compact-view.js";

const ASCII_BOX_WIDTH = 29;
const EMPTY_ASCII = [
  "┌" + "─".repeat(ASCII_BOX_WIDTH) + "┐",
  "│" + " ".repeat(ASCII_BOX_WIDTH) + "│",
  "│" + "       RAINCODE  WEB        " + "│",
  "│" + "       › _" + " ".repeat(ASCII_BOX_WIDTH - 10) + "│",
  "│" + " ".repeat(ASCII_BOX_WIDTH) + "│",
  "└" + "─".repeat(ASCII_BOX_WIDTH) + "┘",
].join("\n");

/** token 数 k 缩写（与侧栏用量行口径一致：1234 → 1.2k）。 */
function fmtK(count: number): string {
  return count < 1000 ? String(count) : `${(count / 1000).toFixed(1)}k`;
}

/** 压缩提示条容器色（running=info / ok=绿左边线 / failed=红左边线）。 */
function compactionBannerClass(phase: CompactionBanner["phase"]): string {
  switch (phase) {
    case "running":
      return "border border-info/40 bg-info/5";
    case "ok":
      return "border border-ok/40 border-l-2 border-l-ok bg-ok/5";
    default:
      return "border border-danger/40 border-l-2 border-l-danger bg-danger/5";
  }
}

const HOOK_OUTCOME_LABEL: Record<HookItem["outcome"], string> = {
  running: "执行中",
  success: "完成",
  blocked: "已拦截",
  failed: "失败（不阻塞）",
  timed_out: "超时（不阻塞）",
  skipped_untrusted: "未授信跳过",
};

/** hook 执行行（T5.1）：单行紧凑投影，拦截/失败态用警示色强调。 */
function HookRow({ item }: { item: HookItem }) {
  const emphasized = item.outcome === "blocked" || item.outcome === "failed" || item.outcome === "timed_out";
  return (
    <div
      className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-2xs ${
        emphasized ? "border-warn text-warn" : "border-border-faint text-mid"
      }`}
    >
      <span className={item.outcome === "running" ? "dot dot-run" : emphasized ? "dot dot-warn" : "dot dot-ok"} />
      <span className="mono">hooks</span>
      <span>{item.phase}</span>
      <span>{HOOK_OUTCOME_LABEL[item.outcome]}</span>
      <span className="text-faint">×{String(item.hookCount)}</span>
      {item.durationMs !== undefined && <span className="text-faint">{String(item.durationMs)}ms</span>}
      {item.reason !== undefined && <span className="truncate text-faint">— {item.reason}</span>}
    </div>
  );
}

/** 子代理状态灯（refine-ui-context-panel 轮，与右栏子代理 Tab 同映射）。 */
function subagentDotClass(status: SubagentRecord["status"]): string {
  switch (status) {
    case "Pending":
      return "dot dot-warn";
    case "Running":
      return "dot dot-run";
    case "Completed":
      return "dot dot-ok";
    case "Failed":
      return "dot dot-err";
    default:
      return "dot dot-idle";
  }
}

const SUBAGENT_STATUS_LABELS: Record<SubagentRecord["status"], string> = {
  Pending: "等待中",
  Running: "运行中",
  Completed: "已完成",
  Failed: "失败",
  Stopped: "已停止",
};

/**
 * 子代理进度卡（03 §6.1 第 4 条）：violet 标识 + 每行「子代理名 + 当前动作 + 状态灯」；
 * 存在 Pending/Running 全展开，全部终态默认折叠单行「N 个子代理已完成」，可再展开。
 */
const SubagentCard = memo(function SubagentCard({ records }: { records: SubagentRecord[] }) {
  const [expanded, setExpanded] = useState(false);
  const hasRunning = records.some((r) => r.status === "Pending" || r.status === "Running");
  const showAll = hasRunning || expanded;
  return (
    <div className="rounded-md border border-violet/40 bg-violet/5 px-3 py-2">
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left"
        onClick={() => setExpanded(!expanded)}
        title={hasRunning ? undefined : expanded ? "收起" : "展开"}
      >
        <span className="mono text-2xs text-violet">◈ 子代理</span>
        <span className="text-2xs text-faint">{hasRunning ? `${records.length} 个` : `${records.length} 个子代理已完成`}</span>
        {!hasRunning && <span className="ml-auto shrink-0 text-2xs text-info hover:underline">{expanded ? "收起" : "展开"}</span>}
      </button>
      {showAll &&
        records.map((record) => {
          const action = record.summary ?? record.stage ?? record.taskPreview;
          return (
            <div key={record.subagentId} className="mt-1.5 flex items-center gap-2">
              <span className={subagentDotClass(record.status)} title={SUBAGENT_STATUS_LABELS[record.status]} />
              <span className="mono shrink-0 text-2xs text-hi">{record.profileName}</span>
              <span className="min-w-0 flex-1 truncate text-2xs text-mid" title={action}>
                {action}
              </span>
            </div>
          );
        })}
    </div>
  );
});

export function ChatFlow(): JSX.Element {
  const activeId = useWeb((s) => s.activeId);
  const view = useWeb((s) => (activeId !== null ? s.views[activeId] : undefined));
  const subagents = useWeb((s) => s.subagents);
  const turnPhase = useWeb((s) => s.turnPhase);
  const streaming = useWeb((s) => s.streaming);
  const error = useWeb((s) => s.error);
  const dismissError = useWeb((s) => s.dismissError);
  const compaction = useWeb((s) => s.compaction);
  const dismissCompaction = useWeb((s) => s.dismissCompaction);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  // 子代理进度卡（03 §6.1 第 4 条）：归属=spawned 事件到达时的活跃会话；空则不渲染
  const cards = subagents.filter((r) => r.sessionId === activeId);
  // 压缩提示条：仅活跃会话的归并投影渲染（切会话已由 selectSession 重置瞬态）
  const banner = compaction !== null && compaction.sessionId === activeId ? compaction : null;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [view?.items.length, view?.items[view.items.length - 1]]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {error !== null ? (
        <div className="mx-4 mt-3 flex items-center justify-between rounded-md border border-danger bg-danger/10 px-3 py-2 text-sm text-danger">
          <span>{error}</span>
          <button className="text-xs underline" onClick={dismissError}>关闭</button>
        </div>
      ) : null}
      {view === undefined ? (
        <div className="flex h-full flex-col items-center justify-center gap-5 px-6">
          <pre className="mono whitespace-pre text-2xs leading-relaxed text-faint">{EMPTY_ASCII}</pre>
          <div className="text-mid">选择或新建一个会话，从一次对话开始</div>
        </div>
      ) : (
        <div className="corner-ticks mx-auto flex w-full max-w-[760px] flex-col gap-3 px-6 py-5">
          {banner !== null && (
            <div className={`flex h-7 items-center gap-2 rounded-md px-3 text-2xs ${compactionBannerClass(banner.phase)}`}>
              {banner.phase === "running" ? (
                <>
                  <span className="dot dot-run" />
                  <span className="shimmer-text">⌃ 上下文压缩中…</span>
                </>
              ) : banner.phase === "ok" ? (
                <span className="text-mid">
                  <span className="mr-1.5 text-ok">⌃</span>
                  上下文已压缩 · 第 {banner.epoch} 代 · {banner.trigger === "manual" ? "手动" : "自动"}
                  {banner.tokensBefore !== undefined && banner.tokensAfter !== undefined && (
                    <span className="mono ml-2 text-ok">
                      tokens {fmtK(banner.tokensBefore)}→{fmtK(banner.tokensAfter)}
                    </span>
                  )}
                </span>
              ) : (
                <span className="text-mid">
                  <span className="mr-1.5 text-danger">⌃</span>
                  <span className="text-danger">压缩失败{banner.reason !== undefined ? `：${banner.reason}` : ""}</span>
                </span>
              )}
              <span className="min-w-0 flex-1" />
              <button
                type="button"
                className="shrink-0 text-2xs text-low transition-colors duration-fast hover:text-hi"
                onClick={dismissCompaction}
                title="关闭提示"
              >
                ✕
              </button>
            </div>
          )}
          {view.items.map((item) =>
            item.kind === "message" ? (
              <MessageBubble key={item.id} item={item} />
            ) : item.kind === "hook" ? (
              <HookRow key={item.id} item={item} />
            ) : (
              <ToolCard key={item.toolCallId} item={item} />
            ),
          )}
          {cards.length > 0 ? <SubagentCard records={cards} /> : null}
          {streaming && turnPhase !== null ? (
            <div className="mt-1 text-2xs">
              <span className="dot dot-run mr-2 inline-block align-middle" />
              <span className="shimmer-text">turn 进行中：{turnPhase}</span>
            </div>
          ) : null}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}
