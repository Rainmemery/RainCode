/**
 * 设置页 · 「MCP 服务器」Tab（06 §2.5 mcp.servers.list / add / remove；UI 管理面板深化轮）：
 * 服务器卡片列表（serverKey / transport / 状态灯 / 工具数 / enabled 徽章）+「添加服务器」表单
 * （serverKey [a-z0-9_-]+；stdio→command+args+env，http/sse→url；实时 JSON 预览；level 固定 global）
 * + 删除两段确认。运行态启停 / 重试 / 健康检查在右侧上下文面板 MCP Tab（底部说明）。
 * 组内局部错误红字行（勿污染全局 chat 横幅）。
 * polish-ui-states-and-runtime A5（§8.1）：服务器卡片列表 ↑↓ 移动高亮；Delete 触发删除动作
 * （两段确认）；高亮行滚动入视。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { RpcCallError } from "@raincode/rpc/client";
import type { McpServerStatus, McpServerStatusEntry, McpTransport } from "@raincode/shared";
import { nextIndexFromKey } from "../list-nav.js";
import { rpcCall, useDesktop } from "../store.js";
import { SETTINGS_INPUT_CLASS, SettingsCard, SettingsField, rpcErrorText } from "./SettingsCard.js";

const SERVER_KEY_PATTERN = /^[a-z0-9_-]+$/;

const EMPTY_FORM = { serverKey: "", transport: "stdio", command: "", args: "", env: "", url: "" };

/** 状态灯四态映射（与 ContextPanel / ExtensionsPanel 同款）。 */
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

/** env 文本（KEY=VALUE 每行）→ Record；空/无合法行返回 undefined（不传字段）。 */
function parseEnvText(text: string): Record<string, string> | undefined {
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

/** 表单 → mcpServerConfig 入参形状（仅携带已填字段；stdio 必填 command，http/sse 必填 url）。 */
function buildConfig(form: typeof EMPTY_FORM): Record<string, unknown> {
  const config: Record<string, unknown> = { serverKey: form.serverKey.trim(), transport: form.transport };
  if (form.transport === "stdio") {
    config.command = form.command.trim();
    const args = form.args.trim() === "" ? [] : form.args.trim().split(/\s+/);
    if (args.length > 0) config.args = args;
    const env = parseEnvText(form.env);
    if (env !== undefined) config.env = env;
  } else {
    config.url = form.url.trim();
  }
  return config;
}

/** 服务器行（memo）：状态灯 + serverKey + transport + 工具数 + enabled 徽章 + 删除两段确认。 */
const ServerRow = memo(function ServerRow({
  server,
  highlighted,
  onRemove,
}: {
  server: McpServerStatusEntry;
  highlighted: boolean;
  onRemove: (serverKey: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div
      data-nav-row
      className={`rounded-md border border-border-faint px-3 py-2 ${highlighted ? "bg-selected" : "bg-panel"}`}
    >
      <div className="flex items-center gap-2">
        <span className={statusDotClass(server.status)} title={STATUS_LABELS[server.status]} />
        <span className="mono text-2xs text-hi">{server.serverKey}</span>
        <span className="rounded border border-border-strong px-1 text-2xs text-mid">{server.transport}</span>
        {typeof server.toolCount === "number" && (
          <span className="text-2xs text-faint" title="命名空间工具数（mcp__serverKey__tool）">
            {server.toolCount} 工具
          </span>
        )}
        <span
          className={`rounded border px-1 text-2xs ${server.enabled ? "border-ok text-ok" : "border-border-strong text-mid"}`}
        >
          {server.enabled ? "已启用" : "已停用"}
        </span>
        <span className="min-w-0 flex-1" />
        {confirming ? (
          <>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="h-6 rounded border border-border-strong px-2 text-2xs text-mid transition-colors duration-fast hover:bg-hover"
            >
              取消
            </button>
            <button
              type="button"
              data-nav-primary
              onClick={() => {
                setConfirming(false);
                onRemove(server.serverKey);
              }}
              className="h-6 rounded border border-danger px-2 text-2xs text-danger transition-colors duration-fast hover:bg-hover"
              title="从 global mcp.json 移除该服务器"
            >
              确认删除？
            </button>
          </>
        ) : (
          <button
            type="button"
            data-nav-primary
            onClick={() => setConfirming(true)}
            className="h-6 rounded border border-border-strong px-2 text-2xs text-mid transition-colors duration-fast hover:border-danger hover:text-danger"
            title="删除服务器配置"
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

export default function SettingsMcp() {
  const extensionsTick = useDesktop((s) => s.extensionsTick);
  const [servers, setServers] = useState<McpServerStatusEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  // 服务器列表键盘导航（A5）：高亮索引
  const [navIndex, setNavIndex] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const result = await rpcCall<{ servers: McpServerStatusEntry[] }>("mcp.servers.list", {});
      setServers(result.servers);
      useDesktop.setState({ mcpServers: result.servers }); // 与右侧上下文面板 MCP Tab 共享投影
      setError(null);
    } catch (err) {
      setError(err instanceof RpcCallError && err.code === "METHOD_NOT_FOUND" ? "MCP 域未装配（当前宿主未启用）" : rpcErrorText(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, extensionsTick]);

  // 实时 JSON 预览（serverKey 合法即预览，未填字段不出现）
  const configPreview = useMemo(() => {
    if (!SERVER_KEY_PATTERN.test(form.serverKey.trim())) return null;
    try {
      return JSON.stringify(buildConfig(form), null, 2);
    } catch {
      return null;
    }
  }, [form]);

  async function handleRemove(serverKey: string): Promise<void> {
    setError(null);
    try {
      await rpcCall("mcp.servers.remove", { serverKey });
      await refresh();
    } catch (err) {
      setError(rpcErrorText(err));
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) return;
    const serverKey = form.serverKey.trim();
    if (!SERVER_KEY_PATTERN.test(serverKey)) {
      setError("serverKey 仅允许小写字母、数字、下划线与连字符（[a-z0-9_-]+）");
      return;
    }
    if (form.transport === "stdio" && form.command.trim() === "") {
      setError("stdio transport 需要填写启动命令 command");
      return;
    }
    if (form.transport !== "stdio" && form.url.trim() === "") {
      setError(`${form.transport} transport 需要填写 url`);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await rpcCall("mcp.servers.add", { config: buildConfig(form), level: "global" });
      setForm(EMPTY_FORM);
      await refresh();
    } catch (err) {
      setError(rpcErrorText(err));
    } finally {
      setSubmitting(false);
    }
  }

  /** 键盘导航：高亮行滚动入视（block:nearest，最小滚动）。 */
  function scrollRowIntoView(index: number): void {
    listRef.current?.querySelectorAll<HTMLElement>("[data-nav-row]")[index]?.scrollIntoView({ block: "nearest" });
  }

  /** 服务器列表键盘：↑↓/Home/End 移动高亮；Delete 触发该行删除动作（两段确认）。 */
  function handleListKey(event: KeyboardEvent<HTMLElement>): void {
    const target = event.target;
    // 添加服务器表单控件聚焦时不劫持按键
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;
    const next = nextIndexFromKey(event.key, navIndex ?? -1, servers.length);
    if (next !== null) {
      event.preventDefault();
      setNavIndex(next);
      scrollRowIntoView(next);
      return;
    }
    if (event.key === "Delete" && navIndex !== null) {
      const row = listRef.current?.querySelectorAll<HTMLElement>("[data-nav-row]")[navIndex];
      if (row === undefined || row === null) return;
      event.preventDefault();
      row.querySelector<HTMLButtonElement>("[data-nav-primary]")?.click();
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <SettingsCard title="服务器列表">
        {error !== null && <div className="mb-2 text-2xs text-danger">{error}</div>}
        <div
          ref={listRef}
          tabIndex={0}
          onKeyDown={handleListKey}
          aria-label="MCP 服务器列表"
          className="flex flex-col gap-2"
        >
          {servers.length === 0 && <div className="py-1 text-2xs text-faint">无（mcp.json 配置后自动连接）</div>}
          {servers.map((server, index) => (
            <ServerRow
              key={server.serverKey}
              server={server}
              highlighted={navIndex === index}
              onRemove={(key) => void handleRemove(key)}
            />
          ))}
        </div>
      </SettingsCard>
      <SettingsCard title="添加服务器">
        <form onSubmit={(event) => void handleSubmit(event)}>
          <div className="grid grid-cols-2 gap-3">
            <SettingsField label="serverKey（[a-z0-9_-]+）">
              <input
                value={form.serverKey}
                onChange={(event) => setForm({ ...form, serverKey: event.target.value })}
                className={SETTINGS_INPUT_CLASS}
                placeholder="例如 filesystem"
              />
            </SettingsField>
            <SettingsField label="transport">
              <select
                value={form.transport}
                onChange={(event) => setForm({ ...form, transport: event.target.value as McpTransport })}
                className={SETTINGS_INPUT_CLASS}
              >
                <option value="stdio">stdio</option>
                <option value="http">http</option>
                <option value="sse">sse</option>
              </select>
            </SettingsField>
            {form.transport === "stdio" ? (
              <>
                <SettingsField label="command（必填）">
                  <input
                    value={form.command}
                    onChange={(event) => setForm({ ...form, command: event.target.value })}
                    className={SETTINGS_INPUT_CLASS}
                    placeholder="例如 npx"
                  />
                </SettingsField>
                <SettingsField label="args（空格切分）">
                  <input
                    value={form.args}
                    onChange={(event) => setForm({ ...form, args: event.target.value })}
                    className={SETTINGS_INPUT_CLASS}
                    placeholder="例如 -y @modelcontextprotocol/server-fs /path"
                  />
                </SettingsField>
                <div className="col-span-2">
                  <SettingsField label="env（KEY=VALUE 每行）">
                    <textarea
                      value={form.env}
                      onChange={(event) => setForm({ ...form, env: event.target.value })}
                      rows={2}
                      className="w-full resize-none rounded-md border border-border-base bg-raised px-2 py-1.5 text-2xs text-hi outline-none placeholder:text-faint focus:border-accent-dim"
                      placeholder={"API_KEY=xxx\nDEBUG=1"}
                    />
                  </SettingsField>
                </div>
              </>
            ) : (
              <div className="col-span-2">
                <SettingsField label="url（必填）">
                  <input
                    value={form.url}
                    onChange={(event) => setForm({ ...form, url: event.target.value })}
                    className={SETTINGS_INPUT_CLASS}
                    placeholder="https://example.com/mcp"
                  />
                </SettingsField>
              </div>
            )}
          </div>
          {configPreview !== null && (
            <pre className="mono mt-2 max-h-32 overflow-auto rounded-md border border-border-faint bg-panel p-2 text-2xs leading-4 text-low">
              {configPreview}
            </pre>
          )}
          <button
            type="submit"
            disabled={submitting}
            className="mt-3 h-8 rounded-md bg-accent px-4 text-2xs text-on-accent transition-colors duration-fast hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            添加服务器
          </button>
        </form>
      </SettingsCard>
      <div className="text-2xs text-faint">运行态启停 / 重试 / 健康检查在右侧上下文面板 MCP Tab</div>
    </div>
  );
}
