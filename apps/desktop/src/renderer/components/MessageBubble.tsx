/**
 * 消息气泡（03 §6.1 第 1 条）：用户右对齐浅橙底气泡（最大宽 76%）；助手左对齐卡片
 * （✦ RainCode 署名 + model 标签）。轻量 markdown：`行内code`、**粗体**、*斜体*、```围栏代码块```；
 * 块级（B6 可视化测试缺陷修复）：#/##/### 标题、| 表格、- / * 无序列表。
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

/** 块级解析：``` 围栏 / 标题 / 表格 / 列表 / 段落（B6：标题与表格此前以原文显示）。 */
function renderBlocks(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const segments = text.split("```");
  segments.forEach((segment, segIndex) => {
    if (segIndex % 2 === 1) {
      let code = segment;
      const nl = code.indexOf("\n");
      if (nl >= 0 && /^[\w.+-]{1,24}$/.test(code.slice(0, nl))) code = code.slice(nl + 1);
      nodes.push(
        <pre
          key={`fence-${segIndex}`}
          className="mono my-1 overflow-x-auto whitespace-pre rounded-md bg-raised px-3 py-2 text-left text-2xs leading-relaxed text-hi"
        >
          {code.replace(/\n$/, "")}
        </pre>,
      );
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
      <div>
        {renderBlocks(item.text)}
        {item.streaming && <span className="stream-cursor" />}
      </div>
    </div>
  );
}
