/**
 * 中部会话流（03 §6.1）：ChatItem → 消息气泡、ToolItem → 工具卡；流式尾部光标、
 * 空态引导（03 §6.5 页面级空态）、审批中琥珀横条、自动滚动，底部输入区。
 */
import { useEffect, useRef } from "react";
import { useDesktop } from "../store.js";
import MessageBubble from "./MessageBubble.js";
import ToolCard from "./ToolCard.js";
import InputArea from "./InputArea.js";
import type { HookItem } from "../session-view.js";

const HOOK_OUTCOME_LABEL: Record<HookItem["outcome"], string> = {
  running: "执行中",
  success: "完成",
  blocked: "已拦截",
  failed: "失败（不阻塞）",
  timed_out: "超时（不阻塞）",
  skipped_untrusted: "未授信跳过",
};

const ASCII_BOX_WIDTH = 29;
const EMPTY_ASCII = [
  "┌" + "─".repeat(ASCII_BOX_WIDTH) + "┐",
  "│" + " ".repeat(ASCII_BOX_WIDTH) + "│",
  "│" + "      RAINCODE  DESKTOP      " + "│",
  "│" + "      › _" + " ".repeat(ASCII_BOX_WIDTH - 9) + "│",
  "│" + " ".repeat(ASCII_BOX_WIDTH) + "│",
  "└" + "─".repeat(ASCII_BOX_WIDTH) + "┘",
].join("\n");

function EmptyState() {
  const createSession = useDesktop((s) => s.createSession);
  return (
    <div className="anim-fade flex h-full flex-col items-center justify-center gap-5 px-6">
      <pre className="mono whitespace-pre text-2xs leading-relaxed text-faint">{EMPTY_ASCII}</pre>
      <div className="text-mid">这里还没有内容，从一次对话开始</div>
      <button
        type="button"
        onClick={() => void createSession()}
        className="h-8 rounded-md bg-accent px-4 text-2xs text-on-accent transition-colors duration-fast hover:bg-accent-hover"
      >
        新建第一个会话
      </button>
    </div>
  );
}

function PendingBanner() {
  return (
    <div className="flex items-center gap-2 border-b border-warn bg-warn/10 px-6 py-1.5 text-2xs text-warn">
      <span className="dot dot-warn" />
      等待你的确认
    </div>
  );
}

/** hook 执行行（T5.1）：单行紧凑投影，拦截/失败态用警示色强调。 */
function HookRow({ item }: { item: HookItem }) {
  const emphasized = item.outcome === "blocked" || item.outcome === "failed" || item.outcome === "timed_out";
  return (
    <div
      className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-2xs ${
        emphasized ? "border-warn text-warn" : "border-line text-mid"
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

export default function ChatFlow() {
  const view = useDesktop((s) => (s.activeId === null ? undefined : s.views[s.activeId]));
  const hasApprovals = useDesktop((s) => s.approvals.length > 0);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [view]);

  const items = view?.items ?? [];

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-base">
      {hasApprovals && <PendingBanner />}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="corner-ticks mx-auto flex w-full max-w-[760px] flex-col gap-3 px-6 py-5">
            {items.map((item) =>
              item.kind === "message" ? (
                <MessageBubble key={item.id} item={item} />
              ) : item.kind === "hook" ? (
                <HookRow key={item.id} item={item} />
              ) : (
                <ToolCard key={item.toolCallId} item={item} />
              ),
            )}
          </div>
        )}
      </div>
      <InputArea />
    </main>
  );
}
