/**
 * 会话流（UI-5；UI 重构轮消息渲染抽出至 MessageBubble/Markdown 并 memo 化）：消息气泡、
 * ToolCard 五状态、hook 执行行、空态 ASCII 引导、审批中琥珀横条、自动滚动。
 */
import { useEffect, useRef } from "react";
import { useWeb } from "../state.js";
import { MessageBubble } from "./MessageBubble.js";
import { ToolCard } from "./ToolCard.js";
import type { HookItem } from "../session-view.js";

const ASCII_BOX_WIDTH = 29;
const EMPTY_ASCII = [
  "┌" + "─".repeat(ASCII_BOX_WIDTH) + "┐",
  "│" + " ".repeat(ASCII_BOX_WIDTH) + "│",
  "│" + "       RAINCODE  WEB        " + "│",
  "│" + "       › _" + " ".repeat(ASCII_BOX_WIDTH - 10) + "│",
  "│" + " ".repeat(ASCII_BOX_WIDTH) + "│",
  "└" + "─".repeat(ASCII_BOX_WIDTH) + "┘",
].join("\n");

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

export function ChatFlow(): JSX.Element {
  const activeId = useWeb((s) => s.activeId);
  const view = useWeb((s) => (activeId !== null ? s.views[activeId] : undefined));
  const turnPhase = useWeb((s) => s.turnPhase);
  const streaming = useWeb((s) => s.streaming);
  const error = useWeb((s) => s.error);
  const dismissError = useWeb((s) => s.dismissError);
  const bottomRef = useRef<HTMLDivElement | null>(null);

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
          {view.items.map((item) =>
            item.kind === "message" ? (
              <MessageBubble key={item.id} item={item} />
            ) : item.kind === "hook" ? (
              <HookRow key={item.id} item={item} />
            ) : (
              <ToolCard key={item.toolCallId} item={item} />
            ),
          )}
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
