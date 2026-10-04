/**
 * 工具调用卡（03 §6.4 v1.2；UI 重设计二轮）：折叠头 32px（状态灯 + glyph + mono 工具名 +
 * 模块徽标 + 参数摘要 + 耗时/状态 + ▸），展开区含参数 / 结果预览（超 30 行截断 + diff 行
 * 着色 + 输出截断提示）/ 错误全文；五状态映射状态灯、2px 左边框与底色 tint。
 * glyph 与 CLI theme.glyphFor 同源（◇ MCP / ◈ 子代理 / ✓ todo / ✱ 检索 / ← 写入 / $ bash / ⚙ 兜底）。
 * 模块徽标：`mcp__<server>__<tool>` → info「MCP·server」、`agent` → violet「子代理」（03 §3.1 模块标识色）。
 */
import { memo, useState } from "react";
import type { ToolItem } from "../session-view.js";

interface ToolCardProps {
  item: ToolItem;
}

interface StateMeta {
  dot: string;
  border: string;
  bg: string;
  text: string;
  textClass: string;
}

function stateMeta(item: ToolItem): StateMeta {
  switch (item.state) {
    case "pending":
      return { dot: "dot dot-warn", border: "border-l-warn", bg: "bg-warn/5", text: "等待审批", textClass: "text-warn" };
    case "running":
      return { dot: "dot dot-run", border: "border-l-cyan", bg: "bg-cyan/5", text: "运行中", textClass: "text-cyan" };
    case "ok":
      return {
        dot: "dot dot-ok",
        border: "border-l-ok",
        bg: "bg-card",
        text: item.durationMs !== undefined ? `${item.durationMs} ms` : "完成",
        textClass: "text-low",
      };
    case "error":
      return { dot: "dot dot-err", border: "border-l-danger", bg: "bg-danger/5", text: "执行失败", textClass: "text-danger" };
    case "denied":
      return { dot: "dot dot-idle", border: "border-l-faint", bg: "bg-card", text: "已作废", textClass: "text-faint" };
  }
}

/** glyph 与 CLI theme.glyphFor 同源（apps/cli/src/ui/theme.ts；三端同一视觉语言）。 */
export function glyphFor(toolName: string): string {
  if (toolName.startsWith("mcp__")) return "◇";
  const name = toolName.toLowerCase();
  if (name.startsWith("agent")) return "◈";
  if (name.startsWith("todo")) return "✓";
  if (name.startsWith("read") || name.startsWith("grep") || name.startsWith("glob")) return "✱";
  if (name.startsWith("write") || name.startsWith("edit")) return "←";
  if (name.startsWith("bash")) return "$";
  return "⚙";
}

/** 模块徽标（03 §6.4 徽标系统）：等宽小字 + 模块标识色描边。 */
function moduleBadge(toolName: string): { label: string; className: string } | null {
  if (toolName.startsWith("mcp__")) {
    const server = toolName.slice(5).split("__")[0] ?? "";
    return { label: `MCP·${server}`, className: "border-info text-info" };
  }
  if (toolName === "agent") {
    return { label: "子代理", className: "border-violet text-violet" };
  }
  return null;
}

/** diff 行着色（dsh DiffBlock 范式）：结构化 diff 标记或 +/- 成对出现才按 diff 渲染，
 * 避免普通文本的 markdown 列表（- item / + item）误判。 */
function isDiffText(content: string): boolean {
  const lines = content.split("\n");
  let plus = false;
  let minus = false;
  for (const line of lines) {
    if (line.startsWith("diff ") || line.startsWith("@@ ") || line.startsWith("--- ") || line.startsWith("+++ ")) {
      return true;
    }
    if (line.startsWith("+") && !line.startsWith("++")) plus = true;
    else if (line.startsWith("-") && !line.startsWith("--")) minus = true;
    if (plus && minus) return true;
  }
  return false;
}

function ContentLines({ content }: { content: string }) {
  if (!isDiffText(content)) return <>{content}</>;
  return (
    <>
      {content.split("\n").map((line, index) => (
        <span
          key={index}
          className={
            line.startsWith("+")
              ? "text-diff-add"
              : line.startsWith("-")
                ? "text-diff-del"
                : line.startsWith("@@")
                  ? "text-info"
                  : undefined
          }
        >
          {line}
          {"\n"}
        </span>
      ))}
    </>
  );
}

interface ContentPreviewProps {
  content: string;
  truncated?: boolean;
}

/** 结果预览：超 30 行截断，「显示全部 / 收起」受控切换（03 §6.4 结果渲染 · 文本）。 */
function ContentPreview({ content, truncated }: ContentPreviewProps) {
  const [showAll, setShowAll] = useState(false);
  const lines = content.split("\n");
  const capped = !showAll && lines.length > 30;
  const visible = capped ? lines.slice(0, 30).join("\n") : content;
  return (
    <div>
      <div className="mb-1 flex items-center gap-2 text-2xs text-low">
        <span>结果</span>
        {truncated === true && <span className="text-warn">输出已截断（完整内容落会话事件流）</span>}
      </div>
      <pre className="mono max-h-72 overflow-auto whitespace-pre rounded-md bg-raised px-2 py-1.5 text-2xs leading-relaxed text-mid">
        <ContentLines content={visible} />
      </pre>
      {lines.length > 30 && (
        <button type="button" onClick={() => setShowAll(!showAll)} className="mt-1 text-2xs text-info hover:underline">
          {capped ? `显示全部（${lines.length} 行）` : "收起"}
        </button>
      )}
    </div>
  );
}

function ToolCardView({ item }: ToolCardProps) {
  const [expanded, setExpanded] = useState(false);
  const meta = stateMeta(item);
  const badge = moduleBadge(item.toolName);
  return (
    <div className={`rounded-lg border border-border-faint border-l-2 ${meta.bg} ${meta.border}`}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex h-8 w-full items-center gap-2 px-3 text-left transition-colors duration-fast hover:bg-hover/60"
        title={item.state === "error" && item.errorText !== undefined ? item.errorText : undefined}
      >
        <span className={meta.dot} />
        <span className="shrink-0 text-2xs text-cyan">{glyphFor(item.toolName)}</span>
        <span className={`mono shrink-0 text-2xs ${item.state === "denied" ? "text-faint line-through" : "text-hi"}`}>
          {item.toolName}
        </span>
        {badge !== null && (
          <span className={`shrink-0 rounded-sm border px-1 text-2xs leading-tight ${badge.className}`}>{badge.label}</span>
        )}
        {item.argsPreview !== undefined && (
          <span className="mono min-w-0 flex-1 truncate text-2xs text-low">{item.argsPreview}</span>
        )}
        <span className={`shrink-0 text-2xs ${meta.textClass}`}>{meta.text}</span>
        <span className={`shrink-0 text-2xs text-faint transition-transform duration-med ${expanded ? "rotate-90" : ""}`}>▸</span>
      </button>
      {expanded && (
        <div className="border-t border-border-faint px-3 py-2">
          {item.argsPreview !== undefined && (
            <div className="mb-2">
              <div className="mb-1 text-2xs text-low">参数</div>
              <pre className="mono max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-raised px-2 py-1.5 text-2xs leading-relaxed text-mid">
                {item.argsPreview}
              </pre>
            </div>
          )}
          {item.state === "error" && item.errorText !== undefined ? (
            <div>
              <div className="mb-1 text-2xs text-low">错误</div>
              <pre className="mono max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-raised px-2 py-1.5 text-2xs leading-relaxed text-danger">
                {item.errorText}
              </pre>
            </div>
          ) : item.contentPreview !== undefined ? (
            <ContentPreview content={item.contentPreview} truncated={item.truncated} />
          ) : null}
        </div>
      )}
    </div>
  );
}

/** memo：流式期间历史工具卡不随转渲染（03 §6.4 性能注记）。 */
export default memo(ToolCardView);
