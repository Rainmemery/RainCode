/** 会话流：当前会话 items 渲染 + 阶段横条（03 §6.3）。
 * 助手消息轻量 markdown 渲染（B6 缺陷修复，与桌面端同解析语义、web ink-* 令牌按端实现 04 §2.3）：
 * `行内code`、**粗体**、*斜体*、```围栏```、#/##/### 标题、| 表格、- 列表。 */
import { useEffect, useRef, type ReactNode } from "react";
import { useWeb } from "../state.js";

const INLINE_PATTERN = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*/g;

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
        <code key={key} className="rounded bg-ink-950 px-1 font-mono text-xs text-cyan-300">
          {code}
        </code>,
      );
    } else if (bold !== undefined) {
      nodes.push(
        <strong key={key} className="font-semibold text-white">
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

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

const LINE_IS_TABLE_ROW = /^\s*\|.*\|\s*$/;
const LINE_IS_TABLE_SEP = /^\s*\|[\s:|-]+\|\s*$/;
const LINE_IS_LIST_ITEM = /^\s*[-*]\s+/;
const LINE_IS_HEADING = /^(#{1,6})\s+(.*)$/;

const HEADING_CLASS: Record<number, string> = {
  1: "mt-1 text-base font-semibold text-white",
  2: "mt-1 text-sm font-semibold text-white",
  3: "mt-1 text-sm font-semibold text-white",
  4: "mt-1 text-sm font-medium text-white",
  5: "mt-1 text-xs font-medium text-white",
  6: "mt-1 text-xs font-medium text-gray-300",
};

/** 块级解析（与桌面端 MessageBubble 同语义，按端最小实现 04 §2.3）。 */
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
          className="my-1 overflow-x-auto whitespace-pre rounded bg-ink-950 p-2 text-left font-mono text-xs text-gray-200"
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
          <table key={key} className="my-1 w-full border-collapse text-left text-xs">
            <thead>
              <tr>
                {header.map((cell, col) => (
                  <th key={col} className="border border-ink-700 bg-ink-950 px-2 py-1 font-semibold text-white">
                    {renderInline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, col) => (
                    <td key={col} className="border border-ink-700 px-2 py-1 align-top text-gray-300">
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
    <div className="flex-1 overflow-y-auto p-4">
      {error !== null ? (
        <div className="mb-3 flex items-center justify-between rounded border border-danger bg-danger/10 px-3 py-2 text-sm text-danger">
          <span>{error}</span>
          <button className="text-xs underline" onClick={dismissError}>关闭</button>
        </div>
      ) : null}
      {view === undefined ? (
        <p className="mt-10 text-center text-sm text-gray-500">选择或新建一个会话</p>
      ) : (
        <>
          {view.items.map((item) =>
            item.kind === "message" ? (
              <div
                key={item.id}
                className={`mb-3 flex ${item.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-2xl rounded-lg px-3 py-2 text-sm ${
                    item.role === "user" ? "bg-accent-dim text-white" : "bg-ink-800"
                  }`}
                >
                  {item.role === "assistant" ? (
                    renderBlocks(item.text)
                  ) : (
                    <span className="whitespace-pre-wrap">{item.text}</span>
                  )}
                  {item.streaming ? <span className="ml-1 animate-pulse">▊</span> : null}
                </div>
              </div>
            ) : (
              <div key={item.toolCallId} className="mb-3">
                <div className="rounded border border-ink-700 bg-ink-900 px-3 py-2 text-xs">
                  <span
                    className={
                      item.state === "ok"
                        ? "text-ok"
                        : item.state === "error" || item.state === "denied"
                          ? "text-danger"
                          : "text-accent"
                    }
                  >
                    ● {item.state}
                  </span>{" "}
                  <span className="font-mono">{item.toolName}</span>
                  {item.argsPreview !== undefined ? (
                    <span className="ml-2 text-gray-500">{item.argsPreview}</span>
                  ) : null}
                  {item.contentPreview !== undefined ? (
                    <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-gray-400">{item.contentPreview}</pre>
                  ) : null}
                  {item.errorText !== undefined ? <p className="mt-1 text-danger">{item.errorText}</p> : null}
                </div>
              </div>
            ),
          )}
          {streaming && turnPhase !== null ? (
            <div className="mt-2 text-xs text-gray-500">turn 进行中：{turnPhase}</div>
          ) : null}
          <div ref={bottomRef} />
        </>
      )}
    </div>
  );
}
