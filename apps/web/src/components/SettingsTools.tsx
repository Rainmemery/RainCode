/**
 * 设置页 · 工具组（polish-ui-states-and-runtime 轮 B2；03 §6.2 第 7 组；双端同构）：
 * `tool.tools.list` 三源（builtin | mcp | plugin）过滤 chips + 行（glyph + 等宽工具名 + source 徽章 +
 * 描述截断）+ 行展开参数 schema（JSON Schema 投影，等宽代码块）。只读，不提供调用入口。
 * 键盘可达（§8.1）：↑↓ 高亮 + Enter 展开/收起 + 高亮行滚动入视。
 */
import { useEffect, useState } from "react";
import { RpcCallError } from "@raincode/rpc/web";
import type { ToolDescriptorInfo, ToolToolsListResult } from "@raincode/shared";
import { nextIndexFromKey } from "../list-nav.js";
import { rpcCall } from "../state.js";
import { glyphFor } from "./ToolCard.js";

type SourceFilter = "all" | ToolDescriptorInfo["source"];

const FILTERS: Array<{ key: SourceFilter; label: string }> = [
  { key: "all", label: "全部" },
  { key: "builtin", label: "内置" },
  { key: "mcp", label: "MCP" },
  { key: "plugin", label: "插件" },
];

/** source → 徽章类（模块标识色：MCP=info / 插件=violet / 内置=中性描边）。 */
const SOURCE_BADGE: Record<ToolDescriptorInfo["source"], string> = {
  builtin: "border-border-strong text-low",
  mcp: "border-info text-info",
  plugin: "border-violet text-violet",
};

const SOURCE_LABEL: Record<ToolDescriptorInfo["source"], string> = {
  builtin: "内置",
  mcp: "MCP",
  plugin: "插件",
};

function errText(err: unknown): string {
  return err instanceof RpcCallError ? `${err.code}: ${err.message}` : String(err);
}

export function SettingsTools(): JSX.Element {
  const [filter, setFilter] = useState<SourceFilter>("all");
  const [tools, setTools] = useState<ToolDescriptorInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [expandedName, setExpandedName] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(-1);

  // 过滤切换即经服务端 source 参数重拉（无本地旁路过滤）；首拉前为骨架态
  useEffect(() => {
    let cancelled = false;
    void rpcCall<ToolToolsListResult>("tool.tools.list", filter === "all" ? {} : { source: filter })
      .then((result) => {
        if (cancelled) return;
        setUnavailable(false);
        setError(null);
        setTools(result.tools);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof RpcCallError && err.code === "METHOD_NOT_FOUND") setUnavailable(true);
        else setError(errText(err));
        setTools([]);
      });
    return () => {
      cancelled = true;
    };
  }, [filter]);

  function selectFilter(next: SourceFilter): void {
    if (next === filter) return;
    setFilter(next);
    setHighlight(-1);
    setExpandedName(null);
  }

  /** 工具目录键位（§8.1）：容器获焦时 ↑↓/Home/End 移动高亮并滚动入视；Enter 触发行展开。 */
  function onListKeyDown(event: React.KeyboardEvent<HTMLElement>): void {
    const target = event.target as HTMLElement;
    if (target !== event.currentTarget || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    const list = tools ?? [];
    if (list.length === 0) return;
    const next = nextIndexFromKey(event.key, highlight, list.length);
    if (next !== null) {
      event.preventDefault();
      setHighlight(next);
      event.currentTarget.querySelector<HTMLElement>(`[data-tool-index="${next}"]`)?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (event.key !== "Enter" || highlight < 0) return;
    event.preventDefault();
    event.currentTarget.querySelector<HTMLElement>(`[data-tool-index="${highlight}"] [data-row-activate]`)?.click();
  }

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-3 px-6 py-5">
      <section>
        <h3 className="pb-2 text-xs text-mid">工具</h3>
        {/* 三源过滤 chips */}
        <div className="flex w-fit gap-1 rounded-md border border-border-faint bg-card p-1">
          {FILTERS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`h-7 rounded-sm px-3 text-2xs transition-colors duration-fast ${
                item.key === filter ? "bg-accent text-on-accent" : "text-mid hover:bg-hover hover:text-hi"
              }`}
              onClick={() => selectFilter(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
        {error !== null && <div className="mt-2 text-2xs text-danger">{error}</div>}
        {unavailable ? (
          <div className="mt-2 rounded-md border border-border-faint bg-card px-3 py-2 text-2xs text-faint">
            工具域未装配（当前宿主未启用）
          </div>
        ) : tools === null ? (
          <div className="mt-2 flex flex-col gap-1.5">
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton h-8 rounded-md" />
            ))}
          </div>
        ) : tools.length === 0 ? (
          <div className="mt-2 rounded-md border border-border-faint bg-card px-3 py-2 text-2xs text-faint">
            {filter === "all" ? "暂无工具（工具注册表为空）" : "该来源暂无工具"}
          </div>
        ) : (
          <div
            tabIndex={0}
            onKeyDown={onListKeyDown}
            aria-label="工具目录（↑↓ 移动，Enter 展开参数 schema）"
            className="mt-2 overflow-hidden rounded-md border border-border-faint bg-card"
          >
            {tools.map((tool, index) => {
              const expanded = expandedName === tool.name;
              return (
                <div
                  key={tool.name}
                  data-tool-index={index}
                  className={`relative border-b border-border-faint last:border-b-0 ${highlight === index ? "bg-hover" : ""}`}
                >
                  {highlight === index && <span className="absolute inset-y-0 left-0 w-0.5 bg-accent" />}
                  <button
                    type="button"
                    data-row-activate
                    className="flex h-8 w-full items-center gap-2 px-3 text-left"
                    onClick={() => setExpandedName(expanded ? null : tool.name)}
                    title={tool.description}
                  >
                    <span className="shrink-0 text-2xs text-cyan">{glyphFor(tool.name)}</span>
                    <span className="mono shrink-0 text-2xs text-hi">{tool.name}</span>
                    <span className={`shrink-0 rounded-sm border px-1 text-[10px] leading-tight ${SOURCE_BADGE[tool.source]}`}>
                      {SOURCE_LABEL[tool.source]}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-2xs text-faint">{tool.description}</span>
                    <span
                      className={`shrink-0 text-2xs text-faint transition-transform duration-med ${expanded ? "rotate-90" : ""}`}
                    >
                      ▸
                    </span>
                  </button>
                  {expanded && (
                    <div className="border-t border-border-faint px-3 py-1.5">
                      <div className="mb-1 text-2xs text-low">参数 schema（JSON Schema 投影）</div>
                      <pre className="mono max-h-64 overflow-auto whitespace-pre rounded-md bg-raised px-2 py-1.5 text-2xs leading-relaxed text-mid">
                        {JSON.stringify(tool.parametersSchema ?? null, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <p className="mt-2 text-2xs text-faint">只读目录：仅供查看工具与入参结构，不提供调用入口。</p>
      </section>
    </div>
  );
}
