/**
 * 右侧上下文面板（refine-ui-context-panel 轮；03-ui-design §6.0/§6.1）：
 * 300px 四 Tab「记忆 | MCP | 子代理 | 后台」，激活 Tab 底部 2px 模块色指示条（记忆=ok 绿 /
 * MCP=info 蓝 / 子代理=violet 紫 / 后台=cyan 青，§6.5 Tab 规范：不加底色填充）。
 * 沙箱 Tab 不做（06-api-spec 无 sandbox 域，真实数据原则：禁止有 Tab 无数据）。
 * 低频管理面与记忆管理器同口径：rpcCall 直连拉取 + extensionsTick 事件驱动重拉；
 * 所有 RPC try/catch 静默（面板为附加信息，失败不影响主流程）。行组件 React.memo。
 * polish-ui-states-and-runtime：MCP Tab 拆至 ContextMcpTab.tsx（护 500 行门禁）并接入列表键盘导航；
 * 后台 Tab 拆至 BackgroundTab.tsx（第 4 Tab，cyan 工具调用模块色）。
 */
import { memo, useCallback, useEffect, useState } from "react";
import type { MemoryEntry } from "@raincode/shared";
import { rpcCall, useDesktop } from "../store.js";
import type { SubagentRecord } from "../subagent-view.js";
import { McpTab } from "./ContextMcpTab.js";
import { BackgroundTab } from "./BackgroundTab.js";

type PanelTab = "memory" | "mcp" | "subagents" | "background";

/** Tab 槽位（§6.5）：指示条 border-b-2 模块色；沙箱域登记协议缺口，待补域后在此扩展。 */
const TABS: Array<{ key: PanelTab; label: string; indicator: string }> = [
  { key: "memory", label: "记忆", indicator: "border-ok" },
  { key: "mcp", label: "MCP", indicator: "border-info" },
  { key: "subagents", label: "子代理", indicator: "border-violet" },
  { key: "background", label: "后台", indicator: "border-cyan" },
];

/** 子代理状态灯（与 ChatFlow 进度卡同映射：Pending/Stopped 灰、Running 青脉冲、Completed 绿、Failed 红）。 */
function subagentDotClass(status: SubagentRecord["status"]): string {
  switch (status) {
    case "Running":
      return "dot dot-run";
    case "Completed":
      return "dot dot-ok";
    case "Failed":
      return "dot dot-err";
    default:
      return "dot dot-idle"; // Pending 排队 / Stopped 已停止
  }
}

/** 历史组行尾状态文案（Completed/Failed/Stopped → 已完成/失败/已停止）。 */
const SUBAGENT_SETTLED_LABELS: Record<"Completed" | "Failed" | "Stopped", string> = {
  Completed: "已完成",
  Failed: "失败",
  Stopped: "已停止",
};

const MEMORY_KIND_LABELS: Record<MemoryEntry["kind"], string> = {
  decision: "决策",
  convention: "约定",
  pitfall: "坑点",
  preference: "偏好",
  todo: "待办",
};

const MEMORY_SOURCE_LABELS: Record<MemoryEntry["source"], string> = {
  "session-end": "会话提取",
  compact: "压缩提取",
  manual: "手动",
  "memory-agent": "记忆代理",
};

interface MemoryReadResult {
  content: string;
  exists: boolean;
}

interface EntriesListResult {
  items: MemoryEntry[];
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

// ---------------------------------------------------------------------------
// 记忆 Tab
// ---------------------------------------------------------------------------

/** 记忆条目行（memo）：中性类型徽章 + 两行截断摘要 + 来源中文与相对时间。 */
const MemoryEntryRow = memo(function MemoryEntryRow({ entry }: { entry: MemoryEntry }) {
  return (
    <div className="mb-2">
      <span className="rounded-sm border border-border-base bg-raised px-1 text-[10px] text-mid">
        {MEMORY_KIND_LABELS[entry.kind]}
      </span>
      <div className="mt-0.5 line-clamp-2 text-2xs text-mid" title={entry.content}>
        {entry.content}
      </div>
      <div className="mt-0.5 text-2xs text-faint">
        {MEMORY_SOURCE_LABELS[entry.source]} · {relativeTime(entry.lastSeenAt)}
      </div>
    </div>
  );
});

/** 记忆 Tab：MEMORY.md 摘要卡 + 检索框（300ms 防抖）+ 最近条目列表。 */
function MemoryTab() {
  const workspace = useDesktop((s) => s.workspace);
  const setView = useDesktop((s) => s.setView);
  const [memoryMd, setMemoryMd] = useState<MemoryReadResult | null>(null);
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [searchResults, setSearchResults] = useState<MemoryEntry[] | null>(null);
  const [query, setQuery] = useState("");

  const refresh = useCallback(async (): Promise<void> => {
    if (workspace === null) return;
    try {
      const [md, entryRows] = await Promise.all([
        rpcCall<MemoryReadResult>("memory.read", { workspaceRoot: workspace }),
        rpcCall<EntriesListResult>("memory.entries.list", { page: { limit: 50 } }),
      ]);
      setMemoryMd(md);
      setEntries(entryRows.items);
    } catch {
      // 静默：面板为附加信息
    }
  }, [workspace]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 检索 300ms 防抖：命中结果替换列表；清空回退默认条目；失败静默保留现有列表
  useEffect(() => {
    if (workspace === null) return;
    const trimmed = query.trim();
    if (trimmed === "") {
      setSearchResults(null);
      return;
    }
    const timer = setTimeout(() => {
      void rpcCall<{ entries: MemoryEntry[] }>("memory.search", { query: trimmed })
        .then((result) => setSearchResults(result.entries))
        .catch(() => undefined);
    }, 300);
    return () => clearTimeout(timer);
  }, [query, workspace]);

  if (workspace === null) {
    return <div className="text-2xs text-faint">先在侧栏设定工作区目录</div>;
  }

  const visibleEntries = searchResults ?? entries;
  return (
    <div className="flex flex-col gap-2">
      <div className="rounded-md border border-border-faint bg-card p-2.5">
        <div className="flex items-center gap-2">
          <span className="dot dot-ok" />
          <span className="text-2xs text-hi">项目记忆 MEMORY.md</span>
          <span className="ml-auto text-2xs text-faint">
            {entries.length} 条{memoryMd !== null ? ` · ${memoryMd.exists ? "已建" : "未建"}` : ""}
          </span>
        </div>
        <button type="button" onClick={() => setView("memory")} className="mt-1.5 text-2xs text-ok hover:underline">
          打开管理器
        </button>
      </div>
      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="检索记忆条目…"
        className="h-7 w-full rounded-md border border-border-base bg-raised px-2 text-2xs text-hi outline-none placeholder:text-faint focus:border-accent-dim"
      />
      {visibleEntries.length === 0 && (
        <div className="text-2xs text-faint">{searchResults !== null ? "无匹配条目" : "暂无记忆条目"}</div>
      )}
      {visibleEntries.map((entry) => (
        <MemoryEntryRow key={entry.id} entry={entry} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 子代理 Tab
// ---------------------------------------------------------------------------

/** 子代理行（memo）：状态灯 + profile 名 + 任务摘要/进度截断 + 回合数；历史行带终态文案。 */
const SubagentRow = memo(function SubagentRow({ record }: { record: SubagentRecord }) {
  const text = record.summary ?? record.stage ?? record.taskPreview;
  const settledLabel =
    record.status === "Completed" || record.status === "Failed" || record.status === "Stopped"
      ? SUBAGENT_SETTLED_LABELS[record.status]
      : null;
  return (
    <div className="flex items-center gap-2 py-1">
      <span className={subagentDotClass(record.status)} />
      <span className="mono shrink-0 text-2xs text-hi">{record.profileName}</span>
      {settledLabel !== null && <span className="shrink-0 text-2xs text-faint">{settledLabel}</span>}
      <span className="min-w-0 flex-1 truncate text-2xs text-mid" title={text}>
        {text}
      </span>
      {record.turnsUsed !== null && <span className="shrink-0 text-2xs text-faint">{record.turnsUsed} 轮</span>}
    </div>
  );
});

/** 子代理 Tab：运行中组在上 + 历史组在下（subagent.* 事件经 reducer 落 store，此处只读渲染）。 */
function SubagentsTab() {
  const subagents = useDesktop((s) => s.subagents);
  const running = subagents.filter((record) => record.status === "Pending" || record.status === "Running");
  const settled = subagents.filter(
    (record) => record.status === "Completed" || record.status === "Failed" || record.status === "Stopped",
  );

  if (subagents.length === 0) {
    return <div className="text-2xs text-faint">暂无子代理派发记录</div>;
  }
  return (
    <div>
      {running.length > 0 && (
        <section>
          <div className="px-1 pb-1 pt-1 text-2xs text-faint">运行中（{running.length}）</div>
          {running.map((record) => (
            <SubagentRow key={record.subagentId} record={record} />
          ))}
        </section>
      )}
      {settled.length > 0 && (
        <section className={running.length > 0 ? "mt-2 border-t border-border-faint pt-1" : ""}>
          <div className="px-1 pb-1 pt-1 text-2xs text-faint">历史（{settled.length}）</div>
          {settled.map((record) => (
            <SubagentRow key={record.subagentId} record={record} />
          ))}
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 面板本体 + 折叠态唤起竖条
// ---------------------------------------------------------------------------

export default function ContextPanel() {
  const toggleContextPanel = useDesktop((s) => s.toggleContextPanel);
  const [tab, setTab] = useState<PanelTab>("memory");

  return (
    <aside className="flex w-[300px] shrink-0 flex-col border-l border-border-faint bg-panel">
      <div className="flex h-10 shrink-0 items-center border-b border-border-faint px-3">
        <span className="text-2xs text-hi">上下文</span>
        <button
          type="button"
          onClick={toggleContextPanel}
          className="ml-auto rounded-sm px-1.5 text-2xs text-low transition-colors duration-fast hover:bg-hover hover:text-hi"
          title="折叠面板"
        >
          »
        </button>
      </div>
      <div className="flex shrink-0 border-b border-border-faint px-3">
        {TABS.map((entry) => {
          const active = entry.key === tab;
          return (
            <button
              key={entry.key}
              type="button"
              onClick={() => setTab(entry.key)}
              className={`h-9 flex-1 border-b-2 text-2xs transition-colors duration-fast ${
                active ? `text-hi ${entry.indicator}` : "border-transparent text-low hover:text-hi"
              }`}
            >
              {entry.label}
            </button>
          );
        })}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 text-2xs">
        <div className="anim-fade" key={tab}>
          {tab === "memory" && <MemoryTab />}
          {tab === "mcp" && <McpTab />}
          {tab === "subagents" && <SubagentsTab />}
          {tab === "background" && <BackgroundTab />}
        </div>
      </div>
    </aside>
  );
}

/** 折叠态右缘唤起竖条（§6.0）：展开按钮 + 四模块标识点（记忆=ok / MCP=info / 子代理=violet / 后台=cyan）。 */
export function ContextPanelRail() {
  const toggleContextPanel = useDesktop((s) => s.toggleContextPanel);
  return (
    <div className="flex w-8 shrink-0 flex-col items-center gap-3 border-l border-border-faint bg-panel py-3">
      <button
        type="button"
        onClick={toggleContextPanel}
        className="rounded-sm px-1 text-2xs text-low transition-colors duration-fast hover:bg-hover hover:text-hi"
        title="展开上下文面板"
      >
        «
      </button>
      <div className="h-1.5 w-1.5 rounded-full bg-ok" title="记忆" />
      <div className="h-1.5 w-1.5 rounded-full bg-info" title="MCP" />
      <div className="h-1.5 w-1.5 rounded-full bg-violet" title="子代理" />
      <div className="h-1.5 w-1.5 rounded-full bg-cyan" title="后台" />
    </div>
  );
}
