/**
 * 扩展面板（UI-4，T3.9）：MCP 服务器管理（T3.7 域：状态投影 / 启停 / 健康检查 / 重试）
 * + 插件管理（T3.5 域：状态 / 启停 / 工具清单）。
 * 低频管理面与记忆管理器同口径：进入视图与每次处置后全量刷新；
 * 连接/生命周期变化由全局事件（mcp.server_status_changed / plugin.status_changed）活更，
 * reducer 落 store（session-view.ts），本组件只读渲染 + 动作触发。
 */
import { useCallback, useEffect, useState } from "react";
import { RpcCallError } from "@raincode/rpc/client";
import type { McpServerStatus, McpServerStatusEntry, McpHealthReport, PluginSummary } from "@raincode/shared";
import { rpcCall, useDesktop } from "../store.js";

/** 状态灯四态映射（03 §6.5）：绿常亮 / 青脉冲 / 琥珀脉冲 / 红常亮；Disconnected 灰常亮。 */
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
      return "dot";
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

export default function ExtensionsPanel() {
  const mcpServers = useDesktop((s) => s.mcpServers);
  const plugins = useDesktop((s) => s.plugins);
  const extensionsTick = useDesktop((s) => s.extensionsTick);
  const setView = useDesktop((s) => s.setView);

  const [health, setHealth] = useState<Record<string, McpHealthReport>>({});
  const [healthBusy, setHealthBusy] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mcpUnavailable, setMcpUnavailable] = useState(false);
  const [pluginsUnavailable, setPluginsUnavailable] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    setError(null);
    // 域未装配（宿主裁剪）时降级为提示而非报错：面板仍渲染另一节
    // B10 缺陷修复：刷新先重扫描插件目录（新拷入插件即时装载），再重拉投影——此前仅重拉 list，
    // 「发布 = 插件目录拷入」后必须重启应用，按钮语义与实际行为不符
    const [mcpResult, pluginsResult] = await Promise.allSettled([
      rpcCall<{ servers: McpServerStatusEntry[] }>("mcp.servers.list", {}),
      (async () => {
        try {
          await rpcCall("plugins.rescan", {});
        } catch (err) {
          // 域未装配（METHOD_NOT_FOUND）时维持旧口径仅重拉；其余重扫描错误不阻塞重拉
          if (!(err instanceof RpcCallError) || err.code !== "METHOD_NOT_FOUND") {
            const text = err instanceof RpcCallError ? `${err.code}: ${err.message}` : String(err);
            setError(text);
          }
        }
        return rpcCall<{ plugins: PluginSummary[] }>("plugins.list", {});
      })(),
    ]);
    if (mcpResult.status === "fulfilled") {
      setMcpUnavailable(false);
      useDesktop.setState({ mcpServers: mcpResult.value.servers });
    } else if (mcpResult.reason instanceof RpcCallError && mcpResult.reason.code === "METHOD_NOT_FOUND") {
      setMcpUnavailable(true);
    } else {
      setError(reasonText(mcpResult.reason));
    }
    if (pluginsResult.status === "fulfilled") {
      setPluginsUnavailable(false);
      useDesktop.setState({ plugins: pluginsResult.value.plugins });
    } else if (pluginsResult.reason instanceof RpcCallError && pluginsResult.reason.code === "METHOD_NOT_FOUND") {
      setPluginsUnavailable(true);
    } else {
      setError(reasonText(pluginsResult.reason));
    }
  }, []);

  // 挂载与全局状态事件（extensionsTick）时重拉：拉取可能早于域就绪（init 异步受理），
  // 事件对未知行不可增量补——tick 通道保证最终收敛到全量投影
  useEffect(() => {
    void refresh();
  }, [refresh, extensionsTick]);

  async function runHealth(serverKey?: string): Promise<void> {
    setHealthBusy(true);
    try {
      const result = await rpcCall<{ items: McpHealthReport[] }>("mcp.servers.health", {
        ...(serverKey !== undefined && { serverKey }),
      });
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
        <button type="button" onClick={() => setView("chat")} className="text-2xs text-mid hover:text-hi" title="返回主工作区">
          ← 返回
        </button>
        <span className="text-2xs text-hi">扩展面板</span>
        <span className="min-w-0 flex-1 truncate text-2xs text-faint">MCP 服务器 · 插件</span>
        <button type="button" onClick={() => void refresh()} className="text-2xs text-mid hover:text-hi">
          刷新
        </button>
      </header>
      {error !== null && (
        <div className="border-b border-danger bg-raised px-4 py-1.5 text-2xs text-danger">{error}</div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <div className="mx-auto flex w-full max-w-[760px] flex-col gap-6">
          {/* MCP 服务器（T3.7 域） */}
          <section>
            <div className="flex items-center gap-2 pb-2">
              <span className="text-2xs text-hi">MCP 服务器</span>
              <span className="text-2xs text-faint">
                {mcpServers.length === 0 ? "无（mcp.json 配置后自动连接）" : `${mcpServers.length} 个`}
              </span>
              <span className="min-w-0 flex-1" />
              {mcpServers.length > 0 && (
                <button
                  type="button"
                  disabled={healthBusy}
                  onClick={() => void runHealth()}
                  className="h-6 rounded border border-border-strong px-2 text-2xs text-mid hover:bg-hover disabled:opacity-50"
                  title="对全部已连接 server 发 MCP ping 实测 RTT；非连接状态只读投影"
                >
                  健康检查
                </button>
              )}
            </div>
            {mcpUnavailable && (
              <div className="rounded-md border border-border-base bg-panel px-3 py-2 text-2xs text-faint">
                MCP 域未装配（当前宿主未启用）
              </div>
            )}
            <div className="flex flex-col gap-2">
              {mcpServers.map((server) => {
                const report = health[server.serverKey];
                return (
                  <div key={server.serverKey} className="rounded-md border border-border-base bg-panel px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className={statusDotClass(server.status)} title={STATUS_LABELS[server.status]} />
                      <span className="mono text-2xs text-hi">{server.serverKey}</span>
                      <span className="rounded border border-border-strong px-1 text-2xs text-mid">{server.transport}</span>
                      <span className="text-2xs text-faint">{STATUS_LABELS[server.status]}</span>
                      {typeof server.toolCount === "number" && (
                        <span className="text-2xs text-faint" title="命名空间工具数（mcp__serverKey__tool）">
                          {server.toolCount} 工具
                        </span>
                      )}
                      {report !== undefined && report.ok && typeof report.latencyMs === "number" && (
                        <span className="text-2xs text-ok" title="健康检查 RTT">
                          {report.latencyMs}ms
                        </span>
                      )}
                      {report !== undefined && !report.ok && typeof report.lastError === "string" && (
                        <span className="min-w-0 flex-1 truncate text-2xs text-danger" title={report.lastError}>
                          {report.lastError}
                        </span>
                      )}
                      <span className="min-w-0 flex-1" />
                      {server.status === "Failed" && (
                        <button
                          type="button"
                          disabled={busyKey === server.serverKey}
                          onClick={() => void retryServer(server.serverKey)}
                          className="h-6 rounded border border-border-strong px-2 text-2xs text-mid hover:bg-hover disabled:opacity-50"
                        >
                          重试
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={busyKey === server.serverKey}
                        onClick={() => void toggleServer(server)}
                        className="h-6 rounded border border-border-strong px-2 text-2xs text-mid hover:bg-hover disabled:opacity-50"
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
                  </div>
                );
              })}
            </div>
          </section>

          {/* 插件（T3.5 域） */}
          <section>
            <div className="flex items-center gap-2 pb-2">
              <span className="text-2xs text-hi">插件</span>
              <span className="text-2xs text-faint">
                {plugins.length === 0 ? "无（发布 = 插件目录拷入 <dataRoot>/plugins/ 后点「刷新」装载）" : `${plugins.length} 个`}
              </span>
            </div>
            {pluginsUnavailable && (
              <div className="rounded-md border border-border-base bg-panel px-3 py-2 text-2xs text-faint">
                插件域未装配（当前宿主未启用）
              </div>
            )}
            <div className="flex flex-col gap-2">
              {plugins.map((plugin) => (
                <div key={plugin.name} className="rounded-md border border-border-base bg-panel px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className={`rounded border px-1 text-2xs ${pluginBadgeClass(plugin.status)}`}>
                      {PLUGIN_STATUS_LABELS[plugin.status]}
                    </span>
                    <span className="mono text-2xs text-hi">{plugin.name}</span>
                    {plugin.version !== undefined && <span className="text-2xs text-faint">v{plugin.version}</span>}
                    <span className="min-w-0 flex-1 truncate text-2xs text-mid">{plugin.description}</span>
                    <button
                      type="button"
                      disabled={busyKey === plugin.name}
                      onClick={() => void togglePlugin(plugin)}
                      className="h-6 shrink-0 rounded border border-border-strong px-2 text-2xs text-mid hover:bg-hover disabled:opacity-50"
                      title={plugin.enabled ? "停用（写入 plugins.json 停用名单，目录保留）" : "启用并加载激活"}
                    >
                      {plugin.enabled ? "停用" : "启用"}
                    </button>
                  </div>
                  {plugin.tools.length > 0 && (
                    <div className="mt-1 truncate text-2xs text-faint" title={plugin.tools.join(", ")}>
                      {plugin.tools.length} 工具：{plugin.tools.join(", ")}
                    </div>
                  )}
                  {plugin.lastError !== null && (
                    <div className="mt-1 truncate text-2xs text-danger" title={plugin.lastError}>
                      {plugin.lastError}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function reasonText(reason: unknown): string {
  return reason instanceof RpcCallError ? `${reason.code}: ${reason.message}` : String(reason);
}
