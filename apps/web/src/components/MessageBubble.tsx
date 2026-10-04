/**
 * 消息气泡（03 §6.1；UI 重构轮新增，与桌面端 MessageBubble 同构并 memo 化）：用户右对齐
 * 浅橙底气泡 / 助手左对齐卡片（✦ RainCode 署名 + model 标签 + ReasoningBlock 思考块 +
 * 流式尾部光标）；markdown 经 Markdown 组件渲染。
 */
import { memo, useEffect, useState } from "react";
import { Markdown } from "./Markdown.js";
import type { ChatItem } from "../session-view.js";

/**
 * 思考块（03 §6.1 v1.2；MiMo Thought / dsh ReasoningRow 范式）：流式中展开实时呈现
 * （尾部 48px 渐隐），完成后自动折叠为单行开关，可再展开；violet 标识 + 2px 左边线。
 */
function ReasoningBlock({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(streaming);
  useEffect(() => {
    if (!streaming) setOpen(false);
  }, [streaming]);
  const live = streaming && open;
  return (
    <div className="mb-2 border-l-2 border-violet/40 pl-2.5">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-left text-2xs text-violet transition-colors duration-fast hover:text-hi"
      >
        <span>✻</span>
        <span>{live ? "思考中" : `思考过程 · ${text.length} 字`}</span>
        {live && text.length === 0 ? <span className="shimmer-text">…</span> : null}
        <span className={`text-faint transition-transform duration-med ${open ? "rotate-90" : ""}`}>▸</span>
      </button>
      {open && text.length > 0 && (
        <pre
          className={`mt-1 whitespace-pre-wrap break-words font-sans text-2xs italic leading-4 text-low ${
            streaming ? "stream-fade" : ""
          }`}
        >
          {text}
        </pre>
      )}
    </div>
  );
}

function MessageBubbleView({ item }: { item: ChatItem }) {
  if (item.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[76%] whitespace-pre-wrap break-words rounded-lg bg-accent-bg px-4 py-2 text-hi">
          <Markdown text={item.text} />
        </div>
      </div>
    );
  }
  return (
    <div className="max-w-[76%] whitespace-pre-wrap break-words rounded-lg border border-border-faint bg-card px-4 py-2.5">
      <div className="mb-1 flex items-baseline gap-2">
        <span className="text-2xs text-accent">✦ RainCode</span>
        {item.model !== undefined && <span className="text-2xs text-low">{item.model}</span>}
      </div>
      {item.reasoning !== undefined && item.reasoning.length > 0 && (
        <ReasoningBlock text={item.reasoning} streaming={item.streaming} />
      )}
      <div>
        <Markdown text={item.text} />
        {item.streaming ? <span className="stream-cursor" /> : null}
      </div>
    </div>
  );
}

/** memo：流式期间仅活动气泡重渲染，历史消息与工具卡不随转渲染。 */
export const MessageBubble = memo(MessageBubbleView);
