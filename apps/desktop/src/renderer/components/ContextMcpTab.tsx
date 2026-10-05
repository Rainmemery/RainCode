/**
 * 上下文面板 · MCP Tab（自 ContextPanel 拆分的既有纪律，护架构门禁单文件 ≤500 行）：
 * 服务器列表（extensionsTick 变化重拉，mcp.server_status_changed 事件驱动收敛）；行组件 React.memo，
 * 行点击展开工具清单（mcp.tools.list）；所有 RPC try/catch 静默（面板为附加信息，失败不影响主流程）。
 * polish-ui-states-and-runtime A5（§8.1）：服务器行 ↑↓ 移动高亮 / Enter 触发行展开（复用既有行为）；
 * 高亮行滚动入视。A7：空态一行说明（配置指引，替代 L-22 的 INTERNAL 横幅）。
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { McpServerStatus, McpServerStatusEntry, McpToolDescriptor } from "@raincode/shared";
import { nextIndexFromKey } from "../list-nav.js";
import { rpcCall, useDesktop } from "../store.js";

/** 状态灯五态映射（对照 ExtensionsPanel：绿常亮 / 青脉冲 / 红常亮 / 灰常亮）。 */
function statusDotClass(status: McpServerStatus): string {
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

const MCP_STATUS_LABELS: Record<McpServerStatus, string> = {
  Disconnected: "未连接",
  Connecting: "连接中",
  Connected: "已连接",
  Reconnecting: "重连中",
  Failed: "失败",
};

/** MCP 服务器行（memo）：状态灯 + serverKey + transport + 工具数；行点击展开工具清单。 */
const McpRow = memo(function McpRow({
  server,
  highlighted,
  onChanged,
}: {
  server: McpServerStatusEntry;
  highlighted: boolean;
  onChanged: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [tools, setTools] = useState<McpToolDescriptor[] | null>(null);
  const [busy, setBusy] = useState(false);

  // 展开时拉取该 server 工具清单（mcp.tools.list）；失败静默
  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    void rpcCall<{ tools: McpToolDescriptor[] }>("mcp.tools.list", { serverKey: server.serverKey })
      .then((result) => {
        if (!cancelled) setTools(result.tools);
      })
      .catch(() => {
        if (!cancelled) setTools([]);
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, server.serverKey]);

  async function toggle(): Promise<void> {
    setBusy(true);
    try {
      await rpcCall("mcp.servers.setEnabled", { serverKey: server.serverKey, enabled: !server.enabled });
      onChanged();
    } catch {
      // 静默
    } finally {
      setBusy(false);
    }
  }

  async function retry(): Promise<void> {
    setBusy(true);
    try {
      await rpcCall("mcp.servers.retry", { serverKey: server.serverKey });
      onChanged();
    } catch {
      // 静默
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      data-nav-row
      className={`rounded-md border px-2.5 py-2 ${
        highlighted ? "border-border-strong bg-selected" : "border-border-faint bg-card"
      }`}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-nav-primary
          onClick={() => setExpanded(!expanded)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          title={expanded ? "收起工具清单" : "展开工具清单"}
        >
          <span className={statusDotClass(server.status)} title={MCP_STATUS_LABELS[server.status]} />
          <span className="mono truncate text-2xs text-hi">{server.serverKey}</span>
          <span className="shrink-0 rounded border border-border-strong px-1 text-2xs text-mid">{server.transport}</span>
          {typeof server.toolCount === "number" && (
            <span className="shrink-0 text-2xs text-faint" title="命名空间工具数">
              {server.toolCount} 工具
            </span>
          )}
          <span className="min-w-0 flex-1" />
          <span className={`shrink-0 text-2xs transition-transform duration-med ${expanded ? "rotate-90" : ""}`}>▸</span>
        </button>
        {server.status === "Failed" && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void retry()}
            className="h-6 shrink-0 rounded border border-border-strong px-2 text-2xs text-mid hover:bg-hover disabled:opacity-50"
            title="重试连接"
          >
            重试
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => void toggle()}
          className="h-6 shrink-0 rounded border border-info px-2 text-2xs text-info hover:bg-hover disabled:opacity-50"
          title={server.enabled ? "停用：断连 + 工具注销 + 配置保留" : "启用：受理即返重连，最终状态经事件"}
        >
          {server.enabled ? "停用" : "启用"}
        </button>
      </div>
      {typeof server.lastError === "string" && (
        <div className="mt-1 truncate text-2xs text-danger" title={server.lastError}>
          {server.lastError}
        </div>
      )}
      {expanded && (
        <div className="mt-1.5 border-t border-border-faint pt-1.5">
          {tools === null ? (
            <div className="flex flex-col gap-1" role="status" aria-label="加载中">
              {[0, 1, 2].map((index) => (
                <div key={index} className="skeleton h-4 w-full" aria-hidden="true" />
              ))}
            </div>
          ) : tools.length === 0 ? (
            <div className="text-2xs text-faint">暂无注册工具</div>
          ) : (
            tools.map((tool) => (
              <div key={tool.name} className="flex items-center gap-2 py-0.5">
                <span className={`h-1 w-1 shrink-0 rounded-full ${tool.available ? "bg-ok" : "bg-danger"}`} />
                <span className="mono min-w-0 flex-1 truncate text-2xs text-mid" title={tool.description ?? tool.name}>
                  {tool.name}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
});

/** MCP Tab：服务器列表（extensionsTick 变化重拉，mcp.server_status_changed 事件驱动收敛）+ 键盘导航。 */
export function McpTab() {
  const extensionsTick = useDesktop((s) => s.extensionsTick);
  const [servers, setServers] = useState<McpServerStatusEntry[]>([]);
  const [navIndex, setNavIndex] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const result = await rpcCall<{ servers: McpServerStatusEntry[] }>("mcp.servers.list", {});
      setServers(result.servers);
    } catch {
      // 静默：域未装配（METHOD_NOT_FOUND）或失败均回落空态
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, extensionsTick]);

  // 行内启停/重试后的刷新回调（useCallback 稳定引用，保住 McpRow 的 memo）
  const onRowChanged = useCallback((): void => {
    void refresh();
  }, [refresh]);

  /** 键盘导航：高亮行滚动入视（block:nearest，最小滚动）。 */
  function scrollRowIntoView(index: number): void {
    listRef.current?.querySelectorAll<HTMLElement>("[data-nav-row]")[index]?.scrollIntoView({ block: "nearest" });
  }

  /** MCP 行键盘：↑↓/Home/End 移动高亮；Enter 触发行展开（复用既有切换行为）。 */
  function handleListKey(event: KeyboardEvent<HTMLElement>): void {
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;
    const next = nextIndexFromKey(event.key, navIndex ?? -1, servers.length);
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

  if (servers.length === 0) {
    // 空态一行说明（polish-ui-states-and-runtime A7）：L-22 收口后装配失败为安静空投影，此处给出配置指引
    return <div className="text-2xs text-faint">未配置 MCP 服务器：编辑 mcp.json 或经设置页「MCP 服务器」添加</div>;
  }
  return (
    <div
      ref={listRef}
      tabIndex={0}
      onKeyDown={handleListKey}
      aria-label="MCP 服务器列表"
      className="flex flex-col gap-2"
    >
      {servers.map((server, index) => (
        <McpRow key={server.serverKey} server={server} highlighted={navIndex === index} onChanged={onRowChanged} />
      ))}
    </div>
  );
}
