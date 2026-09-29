/**
 * 中部会话流（03 §6.1）：ChatItem → 消息气泡、ToolItem → 工具卡；流式尾部光标、
 * 空态引导（03 §6.5 页面级空态）、审批中琥珀横条、自动滚动，底部输入区。
 */
import { useEffect, useRef } from "react";
import { useDesktop } from "../store.js";
import MessageBubble from "./MessageBubble.js";
import ToolCard from "./ToolCard.js";
import InputArea from "./InputArea.js";

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
    <div className="flex h-full flex-col items-center justify-center gap-5 px-6">
      <pre className="mono whitespace-pre text-2xs leading-relaxed text-faint">{EMPTY_ASCII}</pre>
      <div className="text-mid">这里还没有内容，从一次对话开始</div>
      <button
        type="button"
        onClick={() => void createSession()}
        className="h-8 rounded-md bg-accent px-4 text-2xs text-void hover:bg-accent-hover"
      >
        新建第一个会话
      </button>
    </div>
  );
}

function PendingBanner() {
  return (
    <div className="flex items-center gap-2 border-b border-warn bg-[color-mix(in_srgb,var(--warn)_8%,transparent)] px-6 py-1.5 text-2xs text-warn">
      <span className="dot dot-warn" />
      等待你的确认
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
          <div className="mx-auto flex w-full max-w-[760px] flex-col gap-3 px-6 py-4">
            {items.map((item) =>
              item.kind === "message" ? (
                <MessageBubble key={item.id} item={item} />
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
