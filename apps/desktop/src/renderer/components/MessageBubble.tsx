/**
 * 消息气泡（03 §6.1 第 1 条；UI 重设计二轮增思考块与围栏复制）：用户右对齐浅橙底气泡
 * （最大宽 76%）；助手左对齐卡片（✦ RainCode 署名 + model 标签 + ReasoningBlock 思考块）。
 * 轻量 markdown：`行内code`、**粗体**、*斜体*、```围栏代码块```；块级（B6）：#/##/### 标题、
 * | 表格、- / * 无序列表。
 */
import { useEffect, useState, type ReactNode } from "react";
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

/** 表格行 → 单元格（剥离首尾 | 后按 | 切分）。 */
function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

const HEADING_CLASS: Record<number, string> = {
  1: "mt-1 text-base font-semibold text-hi",
  2: "mt-1 text-sm font-semibold text-hi",
  3: "mt-1 text-sm font-semibold text-hi",
  4: "mt-1 text-sm font-medium text-hi",
  5: "mt-1 text-2xs font-medium text-hi",
  6: "mt-1 text-2xs font-medium text-mid",
};

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

/** 代码围栏（dsh CodeBlock 范式）：右上角复制按钮（clipboard 优先，file:// 等非安全上下文回退 execCommand）。 */
function CodeFence({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = code;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <div className="relative my-1">
      <pre className="mono overflow-x-auto whitespace-pre rounded-md border border-border-faint bg-raised px-3 py-2 pr-12 text-left text-2xs leading-relaxed text-hi">
        {code}
      </pre>
      <button
        type="button"
        onClick={() => void copy()}
        className="absolute right-1.5 top-1.5 rounded-sm border border-border-strong bg-panel px-1.5 text-2xs text-low transition-colors duration-fast hover:text-hi"
      >
        {copied ? "已复制" : "复制"}
      </button>
    </div>
  );
}

const LINE_IS_TABLE_ROW = /^\s*\|.*\|\s*$/;
const LINE_IS_TABLE_SEP = /^\s*\|[\s:|-]+\|\s*$/;
const LINE_IS_LIST_ITEM = /^\s*[-*]\s+/;
const LINE_IS_HEADING = /^(#{1,6})\s+(.*)$/;

/** 块级解析：``` 围栏 / 标题 / 表格 / 列表 / 段落（B6：标题与表格此前以原文显示）。 */
function renderBlocks(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const segments = text.split("```");
  segments.forEach((segment, segIndex) => {
    if (segIndex % 2 === 1) {
      let code = segment;
      const nl = code.indexOf("\n");
      if (nl >= 0 && /^[\w.+-]{1,24}$/.test(code.slice(0, nl))) code = code.slice(nl + 1);
      nodes.push(<CodeFence key={`fence-${segIndex}`} code={code.replace(/\n$/, "")} />);
      return;
    }
    const lines = segment.split("\n");
    let i = 0;
    let block = 0;
    while (i < lines.length) {
      const key = `blk-${segIndex}-${block++}`;
      const line = lines[i]!;
      if (line.trim().length === 0) {
        i += 1;
        continue;
      }
      const heading = LINE_IS_HEADING.exec(line);
      if (heading !== null) {
        nodes.push(
          <div key={key} className={HEADING_CLASS[heading[1]!.length] ?? HEADING_CLASS[3]}>
            {renderInline(heading[2] ?? "")}
          </div>,
        );
        i += 1;
        continue;
      }
      if (LINE_IS_TABLE_ROW.test(line) && i + 1 < lines.length && LINE_IS_TABLE_SEP.test(lines[i + 1]!)) {
        const header = splitTableRow(line);
        i += 2;
        const rows: string[][] = [];
        while (i < lines.length && LINE_IS_TABLE_ROW.test(lines[i]!)) {
          rows.push(splitTableRow(lines[i]!));
          i += 1;
        }
        nodes.push(
          <table key={key} className="my-1 w-full border-collapse text-left text-2xs">
            <thead>
              <tr>
                {header.map((cell, col) => (
                  <th key={col} className="border border-border-base bg-raised px-2 py-1 font-semibold text-hi">
                    {renderInline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, col) => (
                    <td key={col} className="border border-border-base px-2 py-1 align-top text-mid">
                      {renderInline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>,
        );
        continue;
      }
      if (LINE_IS_LIST_ITEM.test(line)) {
        const items: string[] = [];
        while (i < lines.length && LINE_IS_LIST_ITEM.test(lines[i]!)) {
          items.push(lines[i]!.replace(LINE_IS_LIST_ITEM, ""));
          i += 1;
        }
        nodes.push(
          <ul key={key} className="my-1 list-disc space-y-0.5 pl-5">
            {items.map((item, itemIndex) => (
              <li key={itemIndex}>{renderInline(item)}</li>
            ))}
          </ul>,
        );
        continue;
      }
      const paragraph: string[] = [];
      while (
        i < lines.length &&
        lines[i]!.trim().length > 0 &&
        !LINE_IS_HEADING.test(lines[i]!) &&
        !LINE_IS_TABLE_ROW.test(lines[i]!) &&
        !LINE_IS_LIST_ITEM.test(lines[i]!)
      ) {
        paragraph.push(lines[i]!);
        i += 1;
      }
      nodes.push(
        <span key={key} className="whitespace-pre-wrap">
          {renderInline(paragraph.join("\n"))}
        </span>,
      );
    }
  });
  return nodes;
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
      {item.reasoning !== undefined && item.reasoning.length > 0 && (
        <ReasoningBlock text={item.reasoning} streaming={item.streaming} />
      )}
      <div>
        {renderBlocks(item.text)}
        {item.streaming && <span className="stream-cursor" />}
      </div>
    </div>
  );
}
