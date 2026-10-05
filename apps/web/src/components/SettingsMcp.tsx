/**
 * 设置页 · MCP 服务器分区（ui-panel-deepening 轮）：mcp.servers.list 卡片投影（状态灯 /
 * transport / 工具数 / enabled 徽章）+ 添加服务器表单（serverKey [a-z0-9_-]+ 校验、stdio/
 * http/sse 三 transport、env KEY=VALUE 逐行解析、实时 JSON 预览）+ 两段确认删除。
 * 配置面只管增删与 enabled 徽章投影；运行态启停 / 重试 / 健康检查在右侧上下文面板 MCP Tab。
 */
import { memo, useCallback, useEffect, useState } from "react";
import { RpcCallError } from "@raincode/rpc/web";
import type { McpServerStatusEntry, McpServerStatus, McpTransport } from "@raincode/shared";
import { rpcCall } from "../state.js";

/** 状态灯映射（03 §6.5，与 ExtensionsPanel 同款）：绿常亮 / 青脉冲 / 红常亮 / 灰常亮。 */
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

const INPUT_CLASS =
  "h-8 w-full rounded-md border border-border-base bg-raised px-2 text-2xs text-hi outline-none placeholder:text-faint transition-colors duration-fast focus:border-accent-dim";

const ROW_BUTTON_CLASS =
  "h-6 rounded-md border border-border-strong px-2 text-2xs text-mid transition-colors duration-fast hover:bg-hover disabled:opacity-50";

/** serverKey 命名空间键（mcp__<serverKey>__<toolName>，02 §3.3）。 */
const SERVER_KEY_RE = /^[a-z0-9_-]+$/;

/** env 逐行解析（KEY=VALUE，值可含 =；空行与无 KEY 行跳过；全空返回 null 即省略 env）。 */
function parseEnvLines(text: string): Record<string, string> | null {
  const record: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    record[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1);
  }
  return Object.keys(record).length > 0 ? record : null;
}

/** 服务器卡（memo：列表刷新时未变更行不重渲染，与既有组件一致）。 */
const ServerCard = memo(function ServerCard({
  server,
  removeArmed,
  removeBusy,
  onRemoveClick,
  onRemoveConfirm,
}: {
  server: McpServerStatusEntry;
  removeArmed: boolean;
  removeBusy: boolean;
  onRemoveClick: (serverKey: string) => void;
  onRemoveConfirm: (serverKey: string) => void;
}) {
  return (
    <div className="rounded-lg border border-border-base bg-card px-3 py-2">
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
        <span
          className={`shrink-0 rounded-sm border px-1 text-2xs ${server.enabled ? "border-ok text-ok" : "border-border-strong text-mid"}`}
        >
          {server.enabled ? "已启用" : "已停用"}
        </span>
        <span className="min-w-0 flex-1" />
        {removeArmed ? (
          <button
            type="button"
            className="h-6 shrink-0 rounded-md border border-danger bg-danger/10 px-2 text-2xs text-danger transition-colors duration-fast hover:bg-danger/20 disabled:opacity-40"
            disabled={removeBusy}
            onClick={() => onRemoveConfirm(server.serverKey)}
            title="再次点击确认删除（mcp.servers.remove）"
          >
            确认删除？
          </button>
        ) : (
          <button
            type="button"
            className={`${ROW_BUTTON_CLASS} shrink-0`}
            onClick={() => onRemoveClick(server.serverKey)}
            title="删除服务器配置（再次点击确认）"
          >
            删除
          </button>
        )}
      </div>
      {typeof server.lastError === "string" && (
        <div className="mt-1 truncate text-2xs text-danger" title={server.lastError}>
          {server.lastError}
        </div>
      )}
    </div>
  );
});

export function SettingsMcp(): JSX.Element {
  const [servers, setServers] = useState<McpServerStatusEntry[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removeArmed, setRemoveArmed] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  // 添加服务器表单
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [serverKey, setServerKey] = useState("");
  const [transport, setTransport] = useState<McpTransport>("stdio");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [envText, setEnvText] = useState("");
  const [url, setUrl] = useState("");

  const refresh = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const result = await rpcCall<{ servers: McpServerStatusEntry[] }>("mcp.servers.list", {});
      setUnavailable(false);
      setServers(result.servers);
    } catch (err) {
      if (err instanceof RpcCallError && err.code === "METHOD_NOT_FOUND") setUnavailable(true);
      else setError(err instanceof RpcCallError ? `${err.code}: ${err.message}` : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function removeServer(serverKey_: string): Promise<void> {
    setRemoving(true);
    try {
      await rpcCall("mcp.servers.remove", { serverKey: serverKey_ });
      setRemoveArmed(null);
      await refresh();
    } catch (err) {
      setError(err instanceof RpcCallError ? `${err.code}: ${err.message}` : String(err));
    } finally {
      setRemoving(false);
    }
  }

  async function submitServer(): Promise<void> {
    setFormError(null);
    if (!SERVER_KEY_RE.test(serverKey)) {
      setFormError("serverKey 需匹配 [a-z0-9_-]+");
      return;
    }
    if (transport === "stdio" && command.trim().length === 0) {
      setFormError("stdio transport 需要 command");
      return;
    }
    if (transport !== "stdio" && url.trim().length === 0) {
      setFormError(`${transport} transport 需要 url`);
      return;
    }
    setBusy(true);
    try {
      const env = parseEnvLines(envText);
      const args = argsText.split(/\s+/).filter((part) => part.length > 0);
      await rpcCall("mcp.servers.add", {
        config: {
          serverKey,
          transport,
          ...(transport === "stdio" && { command: command.trim() }),
          ...(transport === "stdio" && args.length > 0 && { args }),
          ...(transport === "stdio" && env !== null && { env }),
          ...(transport !== "stdio" && { url: url.trim() }),
        },
        level: "global",
      });
      setServerKey("");
      setCommand("");
      setArgsText("");
      setEnvText("");
      setUrl("");
      await refresh();
    } catch (err) {
      setFormError(err instanceof RpcCallError ? `${err.code}: ${err.message}` : String(err));
    } finally {
      setBusy(false);
    }
  }

  // 实时 JSON 预览（与提交 payload 同构；空字段不出现）
  const envPreview = parseEnvLines(envText);
  const argsPreview = argsText.split(/\s+/).filter((part) => part.length > 0);
  const configPreview = {
    serverKey,
    transport,
    ...(transport === "stdio" && command.trim().length > 0 && { command: command.trim() }),
    ...(transport === "stdio" && argsPreview.length > 0 && { args: argsPreview }),
    ...(transport === "stdio" && envPreview !== null && { env: envPreview }),
    ...(transport !== "stdio" && url.trim().length > 0 && { url: url.trim() }),
  };

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-4 px-6 py-5">
      <section>
        <h3 className="pb-2 text-xs text-mid">MCP 服务器</h3>
        {error !== null && <div className="pb-2 text-2xs text-danger">{error}</div>}
        {unavailable ? (
          <div className="rounded-md border border-border-faint bg-card px-3 py-2 text-2xs text-faint">
            MCP 域未装配（当前宿主未启用）
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {servers.length === 0 && (
              <div className="rounded-md border border-border-faint bg-card px-3 py-2 text-2xs text-faint">
                暂无服务器（mcp.json 配置后自动连接，或用下方表单添加）
              </div>
            )}
            {servers.map((server) => (
              <ServerCard
                key={server.serverKey}
                server={server}
                removeArmed={removeArmed === server.serverKey}
                removeBusy={removing}
                onRemoveClick={setRemoveArmed}
                onRemoveConfirm={(key) => void removeServer(key)}
              />
            ))}
          </div>
        )}
      </section>
      <section>
        <h3 className="pb-2 text-xs text-mid">添加服务器（写入 global 层）</h3>
        <div className="rounded-md border border-border-faint bg-card p-3">
          <div className="grid grid-cols-2 gap-2.5">
            <input
              className={INPUT_CLASS}
              placeholder="serverKey（[a-z0-9_-]+）"
              value={serverKey}
              onChange={(e) => setServerKey(e.target.value)}
            />
            <select
              className={INPUT_CLASS}
              value={transport}
              onChange={(e) => setTransport(e.target.value as McpTransport)}
              title="传输类型：stdio 命令行 / http·sse 远程"
            >
              <option value="stdio">stdio</option>
              <option value="http">http</option>
              <option value="sse">sse</option>
            </select>
            {transport === "stdio" ? (
              <>
                <input
                  className={INPUT_CLASS}
                  placeholder="command（如 npx）"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                />
                <input
                  className={INPUT_CLASS}
                  placeholder="args（空格分隔，如 -y @model/mcp）"
                  value={argsText}
                  onChange={(e) => setArgsText(e.target.value)}
                />
                <textarea
                  className={`${INPUT_CLASS} col-span-2 min-h-[56px] resize-y`}
                  placeholder="env（每行 KEY=VALUE）"
                  value={envText}
                  onChange={(e) => setEnvText(e.target.value)}
                />
              </>
            ) : (
              <input
                className={`${INPUT_CLASS} col-span-2`}
                placeholder="url（http/sse 服务端点）"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            )}
          </div>
          <pre className="mono mt-2.5 max-h-40 overflow-auto rounded-md border border-border-faint bg-raised p-2 text-2xs text-low">
            {JSON.stringify(configPreview, null, 2)}
          </pre>
          {formError !== null && <p className="mt-1.5 text-2xs text-danger">{formError}</p>}
          <div className="mt-2.5">
            <button
              type="button"
              className="h-8 rounded-md bg-accent px-3 text-2xs text-on-accent transition-colors duration-fast hover:bg-accent-hover disabled:opacity-40"
              disabled={busy}
              onClick={() => void submitServer()}
              title="添加到 global 层（mcp.servers.add，受理后状态经事件收敛）"
            >
              添加服务器
            </button>
          </div>
        </div>
        <p className="mt-2 text-2xs text-faint">运行态启停 / 重试 / 健康检查在右侧上下文面板 MCP Tab。</p>
      </section>
    </div>
  );
}
