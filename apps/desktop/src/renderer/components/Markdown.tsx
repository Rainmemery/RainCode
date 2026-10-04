/**
 * 轻量 markdown 渲染（03 §6.1；UI 重构轮自 MessageBubble 抽出，memo 化流式重渲染）：
 * `行内code`、**粗体**、*斜体*、```围栏```（v1.3 头行语言芯片 + 常驻复制按钮）、#/##/### 标题、
 * | 表格、- / * 无序列表。无第三方依赖（B6 口径），与 Web 端同解析语义（04 §2.3 各端独立实现）。
 */
import { memo, useState, type ReactNode } from "react";

const INLINE_PATTERN = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*/g;

/** 行内解析：正则切段映射为 code/strong/em 元素。 */
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

const LINE_IS_TABLE_ROW = /^\s*\|.*\|\s*$/;
const LINE_IS_TABLE_SEP = /^\s*\|[\s:|-]+\|\s*$/;
const LINE_IS_LIST_ITEM = /^\s*[-*]\s+/;
const LINE_IS_HEADING = /^(#{1,6})\s+(.*)$/;

/**
 * 代码围栏 v1.3（03 §6.5 修订）：头行 = 语言芯片（mono faint）+ 常驻复制按钮（1.5s「已复制」；
 * clipboard 优先，file:// 非安全上下文回退 execCommand），主体 1px 描边容器整体圆角。
 */
function CodeFence({ code, lang }: { code: string; lang?: string }) {
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
    <div className="my-1.5 overflow-hidden rounded-md border border-border-faint bg-raised">
      <div className="flex items-center justify-between border-b border-border-faint bg-panel py-0.5 pl-2.5 pr-1.5">
        <span className="mono text-2xs text-faint">{lang ?? "text"}</span>
        <button
          type="button"
          onClick={() => void copy()}
          className="rounded-sm border border-border-strong bg-raised px-1.5 text-2xs text-low transition-colors duration-fast hover:text-hi"
        >
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre className="mono overflow-x-auto whitespace-pre px-3 py-2 text-left text-2xs leading-relaxed text-hi">
        {code}
      </pre>
    </div>
  );
}

/** 块级解析：``` 围栏（首行语言标签入芯片）/ 标题 / 表格 / 列表 / 段落。 */
function renderBlocks(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const segments = text.split("```");
  segments.forEach((segment, segIndex) => {
    if (segIndex % 2 === 1) {
      let code = segment;
      let lang: string | undefined;
      const nl = code.indexOf("\n");
      const first = nl >= 0 ? code.slice(0, nl) : code;
      if (/^[\w.+-]{1,24}$/.test(first)) {
        lang = first;
        code = nl >= 0 ? code.slice(nl + 1) : "";
      }
      nodes.push(<CodeFence key={`fence-${segIndex}`} code={code.replace(/\n$/, "")} lang={lang} />);
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

/** memo：流式期间仅文本变化的气泡重解析，兄弟节点（工具卡/历史消息）不随转渲染。 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return <>{renderBlocks(text)}</>;
});
