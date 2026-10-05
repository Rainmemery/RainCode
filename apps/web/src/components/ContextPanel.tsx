/**
 * 右侧上下文面板（refine-ui-context-panel 轮；03-ui-design §6.1 右侧上下文面板，双端同构）：
 * 300px 四 Tab「记忆 | MCP | 子代理 | 后台」，激活 Tab 底部 2px 模块色指示条（记忆=ok / MCP=info /
 * 子代理=violet / 后台=cyan，§6.5 Tab 规范：不加底色填充）。沙箱无协议域（06 全文无 sandbox.*），
 * 不做假 Tab（真实数据原则）。低频管理面：所有 RPC 拉取 try/catch 静默，主流程不因此报错。
 */
import { memo, useEffect, useState } from "react";
import type { McpServerStatusEntry, McpToolDescriptor, MemoryEntry } from "@raincode/shared";
import { nextIndexFromKey } from "../list-nav.js";
import { rpcCall, useWeb } from "../state.js";
import type { SubagentRecord } from "../subagent-view.js";
import { BackgroundTab } from "./BackgroundTab.js";

type ContextTab = "memory" | "mcp" | "subagent" | "background";

/** Tab 定义（03 §3.1 模块标识色：记忆=ok / MCP=info / 子代理=violet / 后台=cyan 工具调用）。 */
const TABS: Array<{ key: ContextTab; label: string; accent: string }> = [
  { key: "memory", label: "记忆", accent: "border-ok" },
  { key: "mcp", label: "MCP", accent: "border-info" },
  { key: "subagent", label: "子代理", accent: "border-violet" },
  { key: "background", label: "后台", accent: "border-cyan" },
];

/** MCP 状态灯映射（对照 ExtensionsPanel 同款：绿常亮 / 青脉冲 / 红常亮 / 灰常亮）。 */
function mcpDotClass(status: McpServerStatusEntry["status"]): string {
  switch (status) {
    case "Connected":
      return "dot dot-ok";
    case "Connecting":
    case "Reconnecting":
      return "dot dot-run";
    case "Failed":
      return "dot dot-err";
    default:
      return "dot dot-idle";
  }
}

const MCP_STATUS_LABELS: Record<McpServerStatusEntry["status"], string> = {
  Disconnected: "未连接",
  Connecting: "连接中",
  Connected: "已连接",
  Reconnecting: "重连中",
  Failed: "失败",
};

/** 子代理状态灯（Pending 琥珀脉冲 / Running 青脉冲 / 终态映射，与 ChatFlow 进度卡同映射）。 */
function subagentDotClass(status: SubagentRecord["status"]): string {
  switch (status) {
    case "Pending":
      return "dot dot-warn";
    case "Running":
      return "dot dot-run";
    case "Completed":
      return "dot dot-ok";
    case "Failed":
      return "dot dot-err";
    default:
      return "dot dot-idle";
  }
}

const SUBAGENT_STATUS_LABELS: Record<SubagentRecord["status"], string> = {
  Pending: "等待中",
  Running: "运行中",
  Completed: "已完成",
  Failed: "失败",
  Stopped: "已停止",
};

/** 相对时间（与 Sidebar 同款：刚刚 / N 分钟前 / N 小时前 / N 天前）。 */
function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

// ---------------------------------------------------------------------------
// 记忆 Tab（ok 绿）：MEMORY.md 摘要卡 + 检索框（300ms 防抖 memory.search）+ 最近条目列表
// ---------------------------------------------------------------------------

const KIND_LABELS: Record<MemoryEntry["kind"], string> = {
  decision: "决策",
  convention: "约定",
  pitfall: "坑点",
  preference: "偏好",
  todo: "待办",
};

const SOURCE_LABELS: Record<MemoryEntry["source"], string> = {
  "session-end": "会话提取",
  compact: "压缩提取",
  manual: "手动",
  "memory-agent": "记忆代理",
};

function MemoryTab(): JSX.Element {
  const workspace = useWeb((s) => s.workspace);
  const setView = useWeb((s) => s.setView);
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [memoryExists, setMemoryExists] = useState<boolean | null>(null);
  const [searchResults, setSearchResults] = useState<MemoryEntry[] | null>(null);
  const [query, setQuery] = useState("");

  // workspace 变化时并行拉取 MEMORY.md 与条目列表（低频管理面，失败静默）
  useEffect(() => {
    if (workspace === null) return;
    let cancelled = false;
    void Promise.all([
      rpcCall<{ exists: boolean }>("memory.read", { workspaceRoot: workspace }),
      rpcCall<{ items: MemoryEntry[] }>("memory.entries.list", { page: { limit: 50 } }),
    ])
      .then(([md, list]) => {
        if (cancelled) return;
        setMemoryExists(md.exists);
        setEntries(list.items);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [workspace]);

  // 检索防抖（300ms）：有结果替换列表、清空恢复默认条目；search 失败静默
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setSearchResults(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void rpcCall<{ entries: MemoryEntry[] }>("memory.search", { query: trimmed })
        .then((result) => {
          if (!cancelled) setSearchResults(result.entries);
        })
        .catch(() => undefined);
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  if (workspace === null) {
    return <div className="px-1 py-2 text-2xs text-faint">先在侧栏设定工作区目录</div>;
  }

  const visible = searchResults ?? entries;
  return (
    <div className="flex flex-col gap-3">
      {/* 摘要卡：MEMORY.md + 条目数 + 打开管理器链接 */}
      <div className="rounded-md border border-border-faint bg-card p-2.5">
        <div className="flex items-center gap-2">
          <span className="text-2xs font-medium text-hi">项目记忆 MEMORY.md</span>
          <span className="min-w-0 flex-1" />
          <button
            type="button"
            className="text-2xs text-ok transition-colors duration-fast hover:underline"
            onClick={() => setView("memory")}
          >
            打开管理器
          </button>
        </div>
        <div className="mt-1 text-2xs text-faint">
          {entries.length} 条记忆条目{memoryExists === false ? "（MEMORY.md 未创建）" : ""}
        </div>
      </div>
      {/* 检索框（样式同侧栏输入） */}
      <input
        className="h-7 min-w-0 rounded-md border border-border-base bg-raised px-2 text-2xs text-hi outline-none placeholder:text-faint focus:border-accent-dim"
        placeholder="检索记忆条目"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {/* 条目列表：类型徽章 + 两行截断摘要 + 来源/时间 */}
      {visible.length === 0 ? (
        <div className="px-2 py-1 text-2xs text-faint">{searchResults !== null ? "无匹配条目" : "暂无记忆条目"}</div>
      ) : (
        <div className="flex flex-col">
          {visible.map((entry) => (
            <div key={entry.id} className="rounded-md px-2 py-1.5 hover:bg-hover">
              <span className="rounded-sm border border-border-base bg-raised px-1 text-[10px] text-mid">
                {KIND_LABELS[entry.kind]}
              </span>
              <p className="mt-1 line-clamp-2 text-2xs text-mid" title={entry.content}>
                {entry.content}
              </p>
              <p className="mt-0.5 text-2xs text-faint">
                {SOURCE_LABELS[entry.source]} · {relativeTime(entry.lastSeenAt)}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MCP Tab（info 蓝）：服务器行（状态灯 + 名称 + 传输 + 工具数）+ 行展开工具清单 + 重试 + 启停开关
// ---------------------------------------------------------------------------

const ROW_BUTTON_CLASS =
  "h-5 rounded-sm border border-border-strong px-1.5 text-2xs text-mid transition-colors duration-fast hover:bg-hover";

/** MCP 服务器行（memo：列表刷新时未变更行不重渲染，ToolCard 先例）；键盘高亮时以 bg-hover + accent 指示条呈现。 */
function McpServerRowView({
  server,
  highlighted,
  index,
}: {
  server: McpServerStatusEntry;
  highlighted: boolean;
  index: number;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [tools, setTools] = useState<McpToolDescriptor[] | null>(null);

  function toggle(): void {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (tools === null) {
      void rpcCall<{ tools: McpToolDescriptor[] }>("mcp.tools.list", { serverKey: server.serverKey })
        .then((result) => setTools(result.tools))
        .catch(() => setTools([])); // 失败静默：展开区空投影
    }
  }

  return (
    <div
      data-server-index={index}
      className={`relative rounded-md border bg-card ${highlighted ? "border-border-strong bg-hover" : "border-border-faint"}`}
    >
      {highlighted && <span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-accent" />}
      <div className="flex items-center gap-2 px-2 py-1.5">
        <button type="button" data-row-activate className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={toggle}>
          <span className={mcpDotClass(server.status)} title={MCP_STATUS_LABELS[server.status]} />
          <span className="mono truncate text-2xs text-hi">{server.serverKey}</span>
          <span className="shrink-0 rounded-sm border border-border-base bg-raised px-1 text-[10px] text-low">
            {server.transport}
          </span>
        </button>
        {typeof server.toolCount === "number" && (
          <span className="shrink-0 text-2xs text-faint" title="命名空间工具数">
            {server.toolCount} 工具
          </span>
        )}
        {server.status === "Failed" && (
          <button
            type="button"
            className={ROW_BUTTON_CLASS}
            onClick={() => {
              void rpcCall("mcp.servers.retry", { serverKey: server.serverKey }).catch(() => undefined);
            }}
          >
            重试
          </button>
        )}
        {/* 启停开关（模块色 info）：受理即返，最终状态经 mcp.server_status_changed 事件 → extTick 重拉 */}
        <button
          type="button"
          aria-pressed={server.enabled}
          title={server.enabled ? "停用：断连 + 工具注销 + 配置保留" : "启用：受理即返重连，最终状态经事件"}
          onClick={() => {
            void rpcCall("mcp.servers.setEnabled", { serverKey: server.serverKey, enabled: !server.enabled }).catch(
              () => undefined,
            );
          }}
          className={`relative h-3.5 w-7 shrink-0 rounded-full border transition-colors duration-fast ${
            server.enabled ? "border-info bg-info/30" : "border-border-strong bg-raised"
          }`}
        >
          <span
            className={`absolute top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-full transition-all duration-fast ${
              server.enabled ? "left-[15px] bg-info" : "left-[2px] bg-border-strong"
            }`}
          />
        </button>
      </div>
      {typeof server.lastError === "string" && (
        <div className="truncate px-2 pb-1.5 text-2xs text-danger" title={server.lastError}>
          {server.lastError}
        </div>
      )}
      {expanded && (
        <div className="border-t border-border-faint px-2 py-1.5">
          {tools === null ? (
            <div className="flex flex-col gap-1" role="status" aria-label="加载中">
              {[0, 1, 2].map((index) => (
                <div key={index} className="skeleton h-4 w-full" aria-hidden="true" />
              ))}
            </div>
          ) : tools.length === 0 ? (
            <div className="text-2xs text-faint">无工具</div>
          ) : (
            tools.map((tool) => (
              <div key={tool.name} className="mono truncate py-0.5 text-2xs text-faint" title={tool.description}>
                {tool.name}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

const McpServerRow = memo(McpServerRowView);

function McpTab(): JSX.Element {
  const extTick = useWeb((s) => s.extTick);
  const [servers, setServers] = useState<McpServerStatusEntry[]>([]);
  /** 键盘高亮序号（§8.1；-1 = 尚无高亮，落到首行）。 */
  const [highlight, setHighlight] = useState(-1);

  // extTick 变化即重拉全量投影（mcp.server_status_changed → store tick，最终收敛）
  useEffect(() => {
    let cancelled = false;
    void rpcCall<{ servers: McpServerStatusEntry[] }>("mcp.servers.list", {})
      .then((result) => {
        if (!cancelled) setServers(result.servers);
      })
      .catch(() => undefined); // 域未装配（METHOD_NOT_FOUND）等失败静默
    return () => {
      cancelled = true;
    };
  }, [extTick]);

  /** 服务器行键位（§8.1）：容器获焦时 ↑↓/Home/End 移动高亮并滚动入视；Enter 触发行展开（既有 toggle）。 */
  function onRowsKeyDown(event: React.KeyboardEvent<HTMLElement>): void {
    const target = event.target as HTMLElement;
    if (target !== event.currentTarget || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    if (servers.length === 0) return;
    const next = nextIndexFromKey(event.key, highlight, servers.length);
    if (next !== null) {
      event.preventDefault();
      setHighlight(next);
      event.currentTarget.querySelector<HTMLElement>(`[data-server-index="${next}"]`)?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (event.key !== "Enter" || highlight < 0) return;
    event.preventDefault();
    // 复用行内既有展开行为（点击行主按钮），McpServerRow 保持自包含
    event.currentTarget.querySelector<HTMLElement>(`[data-server-index="${highlight}"] [data-row-activate]`)?.click();
  }

  if (servers.length === 0) {
    return (
      <div className="px-1 py-2 text-2xs text-faint">未配置 MCP 服务器：编辑 mcp.json 或经设置页「MCP 服务器」添加</div>
    );
  }
  return (
    <div
      tabIndex={0}
      onKeyDown={onRowsKeyDown}
      aria-label="MCP 服务器（↑↓ 移动，Enter 展开）"
      className="flex flex-col gap-1.5"
    >
      {servers.map((server, index) => (
        <McpServerRow key={server.serverKey} server={server} highlighted={highlight === index} index={index} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 子代理 Tab（violet 紫）：运行中组（Pending/Running）在上，历史组（终态）在下
// ---------------------------------------------------------------------------

/** 子代理行（memo：progress 事件流仅更新命中行）。 */
function SubagentRowView({ record }: { record: SubagentRecord }): JSX.Element {
  const running = record.status === "Pending" || record.status === "Running";
  const live = record.summary ?? record.stage;
  return (
    <div className="rounded-md px-2 py-1.5 hover:bg-hover">
      <div className="flex items-center gap-2">
        <span className={subagentDotClass(record.status)} title={SUBAGENT_STATUS_LABELS[record.status]} />
        <span className="mono min-w-0 flex-1 truncate text-2xs text-hi">{record.profileName}</span>
        {!running && <span className="shrink-0 text-2xs text-faint">{SUBAGENT_STATUS_LABELS[record.status]}</span>}
      </div>
      {running ? (
        <>
          <p className="mt-0.5 truncate pl-4 text-2xs text-mid" title={record.taskPreview}>
            {record.taskPreview}
          </p>
          {live !== null && <p className="truncate pl-4 text-2xs text-faint">{live}</p>}
        </>
      ) : (
        <>
          {record.summary !== null && (
            <p className="mt-0.5 truncate pl-4 text-2xs text-mid" title={record.summary}>
              {record.summary}
            </p>
          )}
          {record.turnsUsed !== null && <p className="pl-4 text-2xs text-faint">{record.turnsUsed} 轮</p>}
        </>
      )}
    </div>
  );
}

const SubagentRow = memo(SubagentRowView);

function SubagentTab(): JSX.Element {
  const subagents = useWeb((s) => s.subagents);
  if (subagents.length === 0) {
    return <div className="px-1 py-2 text-2xs text-faint">暂无子代理派发记录</div>;
  }
  const running = subagents.filter((r) => r.status === "Pending" || r.status === "Running");
  const history = subagents.filter((r) => r.status !== "Pending" && r.status !== "Running");
  return (
    <div className="flex flex-col">
      {running.map((record) => (
        <SubagentRow key={record.subagentId} record={record} />
      ))}
      {history.map((record) => (
        <SubagentRow key={record.subagentId} record={record} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 面板骨架：头部（标题 + 折叠）+ Tab 行（2px 模块色指示条）+ 内容区
// ---------------------------------------------------------------------------

export function ContextPanel(): JSX.Element {
  const toggleContextPanel = useWeb((s) => s.toggleContextPanel);
  const [tab, setTab] = useState<ContextTab>("memory");

  return (
    <aside className="flex w-[300px] shrink-0 flex-col border-l border-border-faint bg-panel">
      <div className="flex h-10 shrink-0 items-center border-b border-border-faint px-3">
        <span className="text-2xs text-low">上下文</span>
        <span className="min-w-0 flex-1" />
        <button
          type="button"
          className="rounded-sm px-1.5 py-0.5 text-2xs text-low transition-colors duration-fast hover:bg-hover hover:text-hi"
          onClick={toggleContextPanel}
          title="折叠面板"
        >
          »
        </button>
      </div>
      {/* Tab 行（§6.5：激活态底部 2px 模块色指示条，不加底色填充） */}
      <div className="flex shrink-0 border-b border-border-faint">
        {TABS.map((item) => {
          const active = item.key === tab;
          return (
            <button
              key={item.key}
              type="button"
              className={`h-9 min-w-0 flex-1 border-b-2 text-2xs transition-colors duration-fast ${
                active ? `text-hi ${item.accent}` : "border-transparent text-low hover:text-hi"
              }`}
              onClick={() => setTab(item.key)}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 text-2xs">
        {tab === "memory" ? (
          <MemoryTab />
        ) : tab === "mcp" ? (
          <McpTab />
        ) : tab === "subagent" ? (
          <SubagentTab />
        ) : (
          <BackgroundTab />
        )}
      </div>
    </aside>
  );
}
