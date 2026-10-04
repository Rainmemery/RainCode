/**
 * 工具调用卡（03 §6.4，与桌面端同构；UI 重设计轮自 ChatFlow 内联卡迁出）：
 * 折叠头 32px（状态灯 + mono 工具名 + 模块徽标 + 参数摘要 + 耗时/状态 + ▸），展开区含
 * 参数 / 结果预览（超 30 行截断）/ 错误全文；五状态映射状态灯与 2px 左边框语义。
 * 模块徽标：`mcp__<server>__<tool>` → info「MCP·server」；`agent` → violet「子代理」（03 §3.1 模块标识色）。
 */
import { useState } from "react";
import type { ToolItem } from "../session-view.js";

interface ToolCardProps {
  item: ToolItem;
}

interface StateMeta {
  dot: string;
  border: string;
  text: string;
  textClass: string;
}

function stateMeta(item: ToolItem): StateMeta {
  switch (item.state) {
    case "pending":
      return { dot: "dot dot-warn", border: "border-l-warn", text: "等待审批", textClass: "text-warn" };
    case "running":
      return { dot: "dot dot-run", border: "border-l-cyan", text: "运行中", textClass: "text-cyan" };
    case "ok":
      return {
        dot: "dot dot-ok",
        border: "border-l-ok",
        text: item.durationMs !== undefined ? `${item.durationMs} ms` : "完成",
        textClass: "text-low",
      };
    case "error":
      return { dot: "dot dot-err", border: "border-l-danger", text: "执行失败", textClass: "text-danger" };
    case "denied":
      return { dot: "dot dot-idle", border: "border-l-faint", text: "已作废", textClass: "text-faint" };
  }
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

/** 结果预览：超 30 行截断，「显示全部 / 收起」受控切换（03 §6.4 结果渲染 · 文本）。 */
function ContentPreview({ content }: { content: string }) {
  const [showAll, setShowAll] = useState(false);
  const lines = content.split("\n");
  const capped = !showAll && lines.length > 30;
  const visible = capped ? lines.slice(0, 30).join("\n") : content;
  return (
    <div>
      <div className="mb-1 text-2xs text-low">结果</div>
      <pre className="mono max-h-72 overflow-auto whitespace-pre rounded-md bg-raised px-2 py-1.5 text-2xs leading-relaxed text-mid">
        {visible}
      </pre>
      {lines.length > 30 && (
        <button type="button" onClick={() => setShowAll(!showAll)} className="mt-1 text-2xs text-info hover:underline">
          {capped ? `显示全部（${lines.length} 行）` : "收起"}
        </button>
      )}
    </div>
  );
}

export function ToolCard({ item }: ToolCardProps) {
  const [expanded, setExpanded] = useState(false);
  const meta = stateMeta(item);
  const badge = moduleBadge(item.toolName);
  return (
    <div className={`rounded-lg border border-border-faint bg-card border-l-2 ${meta.border}`}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex h-8 w-full items-center gap-2 px-3 text-left transition-colors duration-fast hover:bg-hover/60"
        title={item.state === "error" && item.errorText !== undefined ? item.errorText : undefined}
      >
        <span className={meta.dot} />
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
            <ContentPreview content={item.contentPreview} />
          ) : null}
        </div>
      )}
    </div>
  );
}
