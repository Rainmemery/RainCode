/**
 * 设置页 · 「工具」组（polish-ui-states-and-runtime Task 4.3；03-ui-design §6.2 第 7 组）：
 * `tool.tools.list` 三源（builtin | mcp | plugin）过滤 chips + 行（glyph + 等宽工具名 + source 徽章 +
 * description 截断）+ 行展开参数 schema（zod→JSON Schema 投影，等宽代码块）。只读，不提供调用入口。
 * A4：首载/换源时 `.skeleton` 占位。A5（§8.1）：行 ↑↓ 移动高亮 + Enter 触发行展开，高亮行滚动入视。
 */
import { memo, useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { ToolDescriptorInfo } from "@raincode/shared";
import { nextIndexFromKey } from "../list-nav.js";
import { rpcCall } from "../store.js";
import { SettingsCard, rpcErrorText } from "./SettingsCard.js";
import { glyphFor } from "./ToolCard.js";

type SourceFilter = "all" | "builtin" | "mcp" | "plugin";

const FILTERS: Array<{ key: SourceFilter; label: string }> = [
  { key: "all", label: "全部" },
  { key: "builtin", label: "内置" },
  { key: "mcp", label: "MCP" },
  { key: "plugin", label: "插件" },
];

/** source 徽章（03 §6.4 徽标系统：色即模块标识色）。 */
const SOURCE_BADGE: Record<ToolDescriptorInfo["source"], { label: string; className: string }> = {
  builtin: { label: "内置", className: "border-border-strong text-mid" },
  mcp: { label: "MCP", className: "border-info text-info" },
  plugin: { label: "插件", className: "border-violet text-violet" },
};

/** 工具行（memo）：glyph + 等宽工具名 + source 徽章 + 描述截断；行点击展开参数 schema（只读）。 */
const ToolRow = memo(function ToolRow({ tool, highlighted }: { tool: ToolDescriptorInfo; highlighted: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const badge = SOURCE_BADGE[tool.source];
  const schema = JSON.stringify(tool.parametersSchema, null, 2) ?? "（无参数 schema）";
  return (
    <div
      data-nav-row
      className={`border-b border-border-faint last:border-b-0 ${highlighted ? "bg-selected" : ""}`}
    >
      <button
        type="button"
        data-nav-primary
        onClick={() => setExpanded(!expanded)}
        className="flex h-8 w-full items-center gap-2 px-1 text-left"
        title={expanded ? "收起参数 schema" : "展开参数 schema"}
      >
        <span className="shrink-0 text-2xs text-cyan">{glyphFor(tool.name)}</span>
        <span className="mono shrink-0 text-2xs text-hi">{tool.name}</span>
        <span className={`shrink-0 rounded border px-1 text-2xs ${badge.className}`}>{badge.label}</span>
        <span className="min-w-0 flex-1 truncate text-2xs text-low" title={tool.description}>
          {tool.description}
        </span>
        <span className={`shrink-0 text-2xs text-faint transition-transform duration-med ${expanded ? "rotate-90" : ""}`}>
          ▸
        </span>
      </button>
      {expanded && (
        <div className="px-1 pb-2">
          <div className="mb-1 text-2xs text-low">参数 schema（JSON Schema 投影，只读）</div>
          <pre className="mono max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-md bg-raised px-2 py-1.5 text-2xs leading-relaxed text-mid">
            {schema}
          </pre>
        </div>
      )}
    </div>
  );
});

export default function SettingsTools() {
  const [filter, setFilter] = useState<SourceFilter>("all");
  const [tools, setTools] = useState<ToolDescriptorInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [navIndex, setNavIndex] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // 换源即重拉：source 缺省 = 三源全量（strict schema 拒 undefined，故按需拼入参）
  useEffect(() => {
    let cancelled = false;
    setTools(null);
    setNavIndex(null);
    void rpcCall<{ tools: ToolDescriptorInfo[] }>(
      "tool.tools.list",
      filter === "all" ? {} : { source: filter },
    )
      .then((result) => {
        if (cancelled) return;
        setTools(result.tools);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setTools([]);
        setError(rpcErrorText(err));
      });
    return () => {
      cancelled = true;
    };
  }, [filter]);

  /** 键盘导航：高亮行滚动入视（block:nearest，最小滚动）。 */
  function scrollRowIntoView(index: number): void {
    listRef.current?.querySelectorAll<HTMLElement>("[data-nav-row]")[index]?.scrollIntoView({ block: "nearest" });
  }

  /** 工具行键盘：↑↓/Home/End 移动高亮；Enter 触发行展开（复用既有切换行为）。 */
  function handleListKey(event: KeyboardEvent<HTMLElement>): void {
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;
    const next = nextIndexFromKey(event.key, navIndex ?? -1, tools?.length ?? 0);
    if (next !== null) {
      event.preventDefault();
      setNavIndex(next);
      scrollRowIntoView(next);
      return;
    }
    if (event.key === "Enter" && navIndex !== null) {
      const row = listRef.current?.querySelectorAll<HTMLElement>("[data-nav-row]")[navIndex];
      const primary = row?.querySelector<HTMLButtonElement>("[data-nav-primary]");
      if (primary === undefined || primary === null) return;
      event.preventDefault();
      primary.click();
    }
  }

  return (
    <SettingsCard title="工具目录">
      <div className="mb-3 flex items-center gap-1">
        {FILTERS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            onClick={() => setFilter(entry.key)}
            className={`h-6 rounded-sm px-2 text-2xs transition-colors duration-fast ${
              filter === entry.key ? "bg-accent text-on-accent" : "text-mid hover:text-hi"
            }`}
          >
            {entry.label}
          </button>
        ))}
        <span className="ml-auto text-2xs text-faint">只读目录（不提供调用入口）</span>
      </div>
      {error !== null && <div className="mb-2 text-2xs text-danger">{error}</div>}
      {tools === null ? (
        <div className="flex flex-col gap-1.5">
          {[0, 1, 2].map((row) => (
            <div key={row} className="skeleton h-7 w-full" />
          ))}
        </div>
      ) : tools.length === 0 ? (
        <div className="py-2 text-2xs text-faint">该来源下暂无工具</div>
      ) : (
        <div ref={listRef} tabIndex={0} onKeyDown={handleListKey} aria-label="工具目录" className="flex flex-col">
          {tools.map((tool, index) => (
            <ToolRow key={tool.name} tool={tool} highlighted={navIndex === index} />
          ))}
        </div>
      )}
    </SettingsCard>
  );
}
