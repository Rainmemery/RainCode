/**
 * 消息气泡（03 §6.1 第 1 条）：用户右对齐浅橙底气泡（最大宽 76%）；助手左对齐卡片
 * （✦ RainCode 署名 + model 标签）。轻量 markdown：`行内code`、**粗体**、*斜体*、```围栏代码块```。
 */
import type { ReactNode } from "react";
import type { ChatItem } from "../session-view.js";

const INLINE_PATTERN = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*/g;

/** 行内解析：正则切段映射为 code/strong/em 元素（无第三方依赖）。 */
function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    const [full, code, bold, italic] = match;
    if (full === undefined || match.index === undefined) break;
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    if (code !== undefined) {
      nodes.push(
        <code key={key} className="mono rounded-sm bg-raised px-1 text-2xs text-cyan">
          {code}
        </code>,
      );
    } else if (bold !== undefined) {
      nodes.push(
        <strong key={key} className="font-semibold text-hi">
          {bold}
        </strong>,
      );
    } else if (italic !== undefined) {
      nodes.push(<em key={key}>{italic}</em>);
    }
    cursor = match.index + full.length;
    key += 1;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

/** 块级解析：``` 围栏代码块（剥离首行语言标记）与文本段交替。 */
function renderBlocks(text: string): ReactNode[] {
  return text.split("```").map((part, index) => {
    if (index % 2 === 1) {
      let code = part;
      const nl = code.indexOf("\n");
      if (nl >= 0 && /^[\w.+-]{1,24}$/.test(code.slice(0, nl))) code = code.slice(nl + 1);
      return (
        <pre
          key={index}
          className="mono my-1 overflow-x-auto whitespace-pre rounded-md bg-raised px-3 py-2 text-left text-2xs leading-relaxed text-hi"
        >
          {code.replace(/\n$/, "")}
        </pre>
      );
    }
    if (part.length === 0) return null;
    return <span key={index}>{renderInline(part)}</span>;
  });
}

interface MessageBubbleProps {
  item: ChatItem;
}

export default function MessageBubble({ item }: MessageBubbleProps) {
  if (item.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[76%] whitespace-pre-wrap break-words rounded-lg bg-accent-bg px-4 py-2 text-hi">
          {renderBlocks(item.text)}
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
      <div>
        {renderBlocks(item.text)}
        {item.streaming && <span className="stream-cursor" />}
      </div>
    </div>
  );
}
