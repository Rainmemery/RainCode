/**
 * 扩展面板（UI-4；T4.5 Web 端对齐桌面端，按端最小实现）：MCP 服务器管理（状态投影 /
 * 启停 / 健康检查 / 重试）+ 插件管理（状态 / 启停 / 工具清单）。
 * 低频管理面：进入视图与每次处置后全量刷新；连接/生命周期变化经全局事件
 * （mcp.server_status_changed / plugin.status_changed → store extTick）触发重拉收敛。
 * 域未装配（宿主裁剪）时降级为提示而非报错：另一节照常渲染。
 */
import { useCallback, useEffect, useState } from "react";
import { RpcCallError } from "@raincode/rpc/web";
import type { McpHealthReport, McpServerStatus, McpServerStatusEntry, PluginSummary } from "@raincode/shared";
import { rpcCall, useWeb } from "../state.js";
import { HooksSection } from "./ExtensionsHooks.js";
import { StatusBanner } from "./StatusBanner.js";

/** 状态灯映射（03 §6.5）：绿常亮 / 琥珀脉冲 / 红常亮；Disconnected 灰常亮。 */
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

const STATUS_LABELS: Record<McpServerStatus, string> = {
  Disconnected: "未连接",
  Connecting: "连接中",
  Connected: "已连接",
  Reconnecting: "重连中",
  Failed: "失败",
};

const PLUGIN_STATUS_LABELS: Record<PluginSummary["status"], string> = {
  active: "已激活",
  disabled: "已停用",
  failed: "加载失败",
};

function pluginBadgeClass(status: PluginSummary["status"]): string {
  switch (status) {
    case "active":
      return "border-ok text-ok";
    case "failed":
      return "border-danger text-danger";
    default:
      return "border-border-strong text-mid";
  }
}

function reasonText(reason: unknown): string {
  return reason instanceof RpcCallError ? `${reason.code}: ${reason.message}` : String(reason);
}

const ROW_BUTTON_CLASS =
  "h-6 rounded-md border border-border-strong px-2 text-2xs text-mid transition-colors duration-fast hover:bg-hover disabled:opacity-50";

/** 面板级骨架加载（03 §7）：3 行骨架条，替换纯文本「加载中…」；reduced-motion 下静态可判读。 */
function SkeletonRows(): JSX.Element {
  return (
    <div className="flex flex-col gap-2" role="status" aria-label="加载中">
      {[0, 1, 2].map((index) => (
        <div key={index} className="skeleton h-10 w-full" aria-hidden="true" />
      ))}
    </div>
  );
}

export function ExtensionsPanel(): JSX.Element {
  const extTick = useWeb((s) => s.extTick);
  const setView = useWeb((s) => s.setView);

  const [mcpServers, setMcpServers] = useState<McpServerStatusEntry[]>([]);
  const [plugins, setPlugins] = useState<PluginSummary[]>([]);
  const [mcpUnavailable, setMcpUnavailable] = useState(false);
  const [pluginsUnavailable, setPluginsUnavailable] = useState(false);
  const [health, setHealth] = useState<Record<string, McpHealthReport>>({});
  const [healthBusy, setHealthBusy] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (): Promise<void> => {
    setError(null);
    // B10 缺陷修复：刷新先重扫描插件目录（plugins.rescan，新拷入插件即时装载），再重拉投影
    // ——此前仅重拉 list，「发布 = 插件目录拷入」后必须重启应用，按钮语义与实际行为不符
    const [mcpResult, pluginsResult] = await Promise.allSettled([
      rpcCall<{ servers: McpServerStatusEntry[] }>("mcp.servers.list", {}),
      (async () => {
        try {
          await rpcCall("plugins.rescan", {});
        } catch (err) {
          // 域未装配（METHOD_NOT_FOUND）时维持旧口径仅重拉；其余重扫描错误不阻塞重拉
          if (!(err instanceof RpcCallError) || err.code !== "METHOD_NOT_FOUND") {
            setError(reasonText(err));
          }
        }
        return rpcCall<{ plugins: PluginSummary[] }>("plugins.list", {});
      })(),
    ]);
    if (mcpResult.status === "fulfilled") {
      setMcpUnavailable(false);
      setMcpServers(mcpResult.value.servers);
    } else if (mcpResult.reason instanceof RpcCallError && mcpResult.reason.code === "METHOD_NOT_FOUND") {
      setMcpUnavailable(true);
    } else {
      setError(reasonText(mcpResult.reason));
    }
    if (pluginsResult.status === "fulfilled") {
      setPluginsUnavailable(false);
      setPlugins(pluginsResult.value.plugins);
    } else if (pluginsResult.reason instanceof RpcCallError && pluginsResult.reason.code === "METHOD_NOT_FOUND") {
      setPluginsUnavailable(true);
    } else {
      setError(reasonText(pluginsResult.reason));
    }
    setLoading(false); // 首载骨架收敛（allSettled 恒不抛；后续刷新直取旧投影）
  }, []);

  // 挂载与全局状态事件（extTick）时重拉：拉取可能早于域就绪（init 异步受理），
  // 事件对未知行不可增量补——tick 通道保证最终收敛到全量投影
  useEffect(() => {
    void refresh();
  }, [refresh, extTick]);

  async function runHealth(): Promise<void> {
    setHealthBusy(true);
    try {
      const result = await rpcCall<{ items: McpHealthReport[] }>("mcp.servers.health", {});
      setHealth((prev) => {
        const next = { ...prev };
        for (const report of result.items) next[report.serverKey] = report;
        return next;
      });
    } catch (err) {
      setError(err instanceof RpcCallError ? `${err.code}: ${err.message}` : String(err));
    } finally {
      setHealthBusy(false);
    }
  }

  async function toggleServer(server: McpServerStatusEntry): Promise<void> {
    setBusyKey(server.serverKey);
    try {
      await rpcCall("mcp.servers.setEnabled", { serverKey: server.serverKey, enabled: !server.enabled });
      await refresh();
    } catch (err) {
      setError(err instanceof RpcCallError ? `${err.code}: ${err.message}` : String(err));
    } finally {
      setBusyKey(null);
    }
  }

  async function retryServer(serverKey: string): Promise<void> {
    setBusyKey(serverKey);
    try {
      await rpcCall("mcp.servers.retry", { serverKey });
      await refresh();
    } catch (err) {
      setError(err instanceof RpcCallError ? `${err.code}: ${err.message}` : String(err));
    } finally {
      setBusyKey(null);
    }
  }

  async function togglePlugin(plugin: PluginSummary): Promise<void> {
    setBusyKey(plugin.name);
    try {
      await rpcCall("plugins.setEnabled", { name: plugin.name, enabled: !plugin.enabled });
      await refresh();
    } catch (err) {
      setError(err instanceof RpcCallError ? `${err.code}: ${err.message}` : String(err));
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-10 shrink-0 items-center gap-3 border-b border-border-base bg-panel px-4">
        <button type="button" onClick={() => setView("chat")} className="text-2xs text-mid transition-colors duration-fast hover:text-hi" title="返回主工作区">
          ← 返回
        </button>
        <span className="text-2xs text-hi">扩展面板</span>
        <span className="min-w-0 flex-1 truncate text-2xs text-faint">MCP 服务器 · 插件</span>
        <button type="button" onClick={() => void refresh()} className="text-2xs text-mid transition-colors duration-fast hover:text-hi">
          刷新
        </button>
      </header>
      {error !== null && (
        <div className="border-b border-border-faint px-4 py-2">
          <StatusBanner tone="danger" text={error} onDismiss={() => setError(null)} />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <div className="mx-auto flex w-full max-w-[760px] flex-col gap-6">
          {/* MCP 服务器 */}
          <section>
            <div className="flex items-center gap-2 pb-2">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-info" />
              <span className="text-2xs font-medium text-hi">MCP 服务器</span>
              <span className="text-2xs text-faint">
                {mcpServers.length === 0 ? "无（mcp.json 配置后自动连接）" : `${mcpServers.length} 个`}
              </span>
              <span className="min-w-0 flex-1" />
              {mcpServers.length > 0 && (
                <button
                  type="button"
                  disabled={healthBusy}
                  onClick={() => void runHealth()}
                  className={ROW_BUTTON_CLASS}
                  title="对全部已连接 server 发 MCP ping 实测 RTT；非连接状态只读投影"
                >
                  {healthBusy ? "检查中…" : "健康检查"}
                </button>
              )}
            </div>
            {mcpUnavailable && (
              <div className="rounded-md border border-border-faint bg-card px-3 py-2 text-2xs text-faint">
                MCP 域未装配（当前宿主未启用）
              </div>
            )}
            {loading && mcpServers.length === 0 && !mcpUnavailable ? (
              <SkeletonRows />
            ) : (
            <div className="flex flex-col gap-2">
              {mcpServers.map((server) => {
                const report = health[server.serverKey];
                return (
                  <div key={server.serverKey} className="rounded-lg border border-border-base bg-card px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className={statusDotClass(server.status)} title={STATUS_LABELS[server.status]} />
                      <span className="mono text-2xs text-hi">{server.serverKey}</span>
                      <span className="rounded-sm border border-border-strong px-1 text-2xs text-low">{server.transport}</span>
                      <span className="text-2xs text-faint">{STATUS_LABELS[server.status]}</span>
                      {typeof server.toolCount === "number" && (
                        <span className="text-2xs text-faint" title="命名空间工具数（mcp__serverKey__tool）">
                          {server.toolCount} 工具
                        </span>
                      )}
                      {report !== undefined && report.ok && typeof report.latencyMs === "number" && (
                        <span className="mono text-2xs text-ok" title="健康检查 RTT">{report.latencyMs}ms</span>
                      )}
                      {report !== undefined && !report.ok && typeof report.lastError === "string" && (
                        <span className="min-w-0 flex-1 truncate text-2xs text-danger" title={report.lastError}>{report.lastError}</span>
                      )}
                      <span className="min-w-0 flex-1" />
                      {server.status === "Failed" && (
                        <button
                          type="button"
                          disabled={busyKey === server.serverKey}
                          onClick={() => void retryServer(server.serverKey)}
                          className={ROW_BUTTON_CLASS}
                        >
                          重试
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={busyKey === server.serverKey}
                        onClick={() => void toggleServer(server)}
                        className={ROW_BUTTON_CLASS}
                        title={server.enabled ? "停用：断连 + 工具注销 + 配置保留" : "启用：受理即返重连，最终状态经事件"}
                      >
                        {server.enabled ? "停用" : "启用"}
                      </button>
                    </div>
                    {typeof server.lastError === "string" && (
                      <div className="mt-1 truncate text-2xs text-danger" title={server.lastError}>{server.lastError}</div>
                    )}
                  </div>
                );
              })}
            </div>
            )}
          </section>

          {/* 插件 */}
          <section>
            <div className="flex items-center gap-2 pb-2">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-violet" />
              <span className="text-2xs font-medium text-hi">插件</span>
              <span className="text-2xs text-faint">
                {plugins.length === 0 ? "无（发布 = 插件目录拷入 <dataRoot>/plugins/ 后点「刷新」装载）" : `${plugins.length} 个`}
              </span>
            </div>
            {pluginsUnavailable && (
              <div className="rounded-md border border-border-faint bg-card px-3 py-2 text-2xs text-faint">
                插件域未装配（当前宿主未启用）
              </div>
            )}
            <div className="flex flex-col gap-2">
              {plugins.map((plugin) => (
                <div key={plugin.name} className="rounded-lg border border-border-base bg-card px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className={`shrink-0 rounded-sm border px-1 text-2xs ${pluginBadgeClass(plugin.status)}`}>
                      {PLUGIN_STATUS_LABELS[plugin.status]}
                    </span>
                    <span className="mono text-2xs text-hi">{plugin.name}</span>
                    {plugin.version !== undefined && <span className="mono text-2xs text-faint">v{plugin.version}</span>}
                    <span className="min-w-0 flex-1 truncate text-2xs text-mid">{plugin.description}</span>
                    <button
                      type="button"
                      disabled={busyKey === plugin.name}
                      onClick={() => void togglePlugin(plugin)}
                      className={`${ROW_BUTTON_CLASS} shrink-0`}
                      title={plugin.enabled ? "停用（写入 plugins.json 停用名单，目录保留）" : "启用并加载激活"}
                    >
                      {plugin.enabled ? "停用" : "启用"}
                    </button>
                  </div>
                  {plugin.tools.length > 0 && (
                    <div className="mono mt-1 truncate text-2xs text-low" title={plugin.tools.join(", ")}>
                      {plugin.tools.length} 工具：{plugin.tools.join(", ")}
                    </div>
                  )}
                  {plugin.lastError !== null && (
                    <div className="mt-1 truncate text-2xs text-danger" title={plugin.lastError}>{plugin.lastError}</div>
                  )}
                </div>
              ))}
            </div>
          </section>

          {/* Hooks（ui-panel-deepening 轮：置于 MCP 与插件区之后） */}
          <HooksSection />
        </div>
      </div>
    </div>
  );
}
