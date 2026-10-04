/**
 * 侧栏（03 §6.2 Web 适配；UI 重设计轮对齐赤陶磷光 v2）：品牌头（✦ RainCode）+ 连接状态徽章
 * + 工作区输入 + 新建会话主按钮 + 会话列表（当前项 accent 指示条）+ 用量统计行 + 管理面板入口
 * （模块标识色：记忆=ok / 扩展=info / 设置=accent）。T4.5 对齐桌面端 UI-4。
 */
import { useState } from "react";
import { useWeb } from "../state.js";
import { nextTheme, THEME_LABEL } from "../theme.js";

const CONNECTION_LABEL: Record<string, { text: string; className: string; dot: string }> = {
  connecting: { text: "连接中…", className: "bg-warn/10 text-warn border border-warn/40", dot: "dot dot-warn" },
  ready: { text: "已连接", className: "bg-ok/10 text-ok border border-ok/40", dot: "dot dot-ok" },
  reconnecting: { text: "重连中（断线补偿）…", className: "bg-warn/10 text-warn border border-warn/40", dot: "dot dot-warn" },
  closed: { text: "已断开", className: "bg-danger/10 text-danger border border-danger/40", dot: "dot dot-err" },
};

/** token 数三档缩写（用量统计行，UI-4）：1234 → 1.2k。 */
function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(1)}m`;
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

export function Sidebar(): JSX.Element {
  const connection = useWeb((s) => s.connection);
  const sessions = useWeb((s) => s.sessions);
  const activeId = useWeb((s) => s.activeId);
  const workspace = useWeb((s) => s.workspace);
  const view = useWeb((s) => s.view);
  const usage = useWeb((s) => s.usage);
  const theme = useWeb((s) => s.theme);
  const setWorkspace = useWeb((s) => s.setWorkspace);
  const setView = useWeb((s) => s.setView);
  const setTheme = useWeb((s) => s.setTheme);
  const selectSession = useWeb((s) => s.selectSession);
  const createSession = useWeb((s) => s.createSession);
  const [workspaceDraft, setWorkspaceDraft] = useState(workspace ?? "");

  const badge = CONNECTION_LABEL[connection] ?? CONNECTION_LABEL["connecting"]!;

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border-base bg-panel">
      {/* 品牌头 + 连接状态 + 主题切换（03 §3.2：深色 → 浅色 → 跟随系统循环） */}
      <div className="border-b border-border-faint px-4 py-3">
        <div className="flex items-baseline gap-1.5">
          <span className="text-sm text-accent">✦</span>
          <span className="text-sm font-semibold text-hi">RainCode</span>
          <span className="text-2xs text-faint">Web 工作台</span>
          <button
            className="ml-auto rounded-sm px-1.5 py-0.5 text-2xs text-low transition-colors duration-fast hover:bg-hover hover:text-hi"
            onClick={() => setTheme(nextTheme(theme))}
            title="切换主题（深色 → 浅色 → 跟随系统）"
          >
            ◐ {THEME_LABEL[theme]}
          </button>
        </div>
        <span className={`mt-2 inline-flex items-center gap-1.5 rounded-sm px-2 py-0.5 text-2xs ${badge.className}`}>
          <span className={badge.dot} />
          {badge.text}
        </span>
      </div>
      {/* 工作区（走查契约：aside 内首个 input） */}
      <div className="border-b border-border-faint px-3 py-3">
        <label className="mb-1 block text-2xs text-low">工作区目录（绝对路径）</label>
        <div className="flex gap-1.5">
          <input
            className="h-7 min-w-0 flex-1 rounded-md border border-border-base bg-raised px-2 text-2xs text-hi outline-none placeholder:text-faint focus:border-accent-dim"
            placeholder="D:\path\to\workspace"
            value={workspaceDraft}
            onChange={(e) => setWorkspaceDraft(e.target.value)}
          />
          <button
            className="h-7 rounded-md bg-accent px-2.5 text-2xs text-on-accent transition-colors duration-fast hover:bg-accent-hover"
            onClick={() => setWorkspace(workspaceDraft)}
          >
            设定
          </button>
        </div>
        {workspace !== null ? <p className="mono mt-1.5 truncate text-2xs text-faint" title={workspace}>{workspace}</p> : null}
      </div>
      <div className="px-3 py-2.5">
        <button
          className="h-8 w-full rounded-md bg-accent text-2xs text-on-accent transition-colors duration-fast hover:bg-accent-hover"
          onClick={() => void createSession()}
        >
          + 新会话
        </button>
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {sessions.length === 0 && <div className="px-2 py-2 text-2xs text-faint">暂无会话</div>}
        {sessions.map((row) => {
          const active = row.id === activeId;
          return (
            <button
              key={row.id}
              className={`relative mb-0.5 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-fast ${
                active ? "bg-selected" : "hover:bg-hover"
              }`}
              onClick={() => void selectSession(row.id)}
              title={row.title}
            >
              {active && <span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-accent" />}
              <span className={`min-w-0 flex-1 truncate text-2xs ${active ? "text-hi" : "text-mid"}`}>{row.title}</span>
              <span className="shrink-0 text-2xs text-faint">{relativeTime(row.lastActiveAt)}</span>
            </button>
          );
        })}
      </nav>
      <div className="border-t border-border-faint p-3">
        {activeId !== null && usage !== null && (
          <div
            className="mono mb-2 flex items-center gap-2 px-1 text-2xs text-low"
            title={`本会话累计：输入 ${usage.inputTokens} tokens / 输出 ${usage.outputTokens} tokens / ${usage.turnsCount} 回合${usage.costEstimateUsd !== undefined ? `（按活跃 Provider 单价估算 $${usage.costEstimateUsd.toFixed(4)}）` : ""}`}
          >
            <span>↑{formatTokens(usage.inputTokens)}</span>
            <span>↓{formatTokens(usage.outputTokens)}</span>
            <span>{usage.turnsCount} 轮</span>
            {usage.costEstimateUsd !== undefined && <span>${usage.costEstimateUsd.toFixed(4)}</span>}
          </div>
        )}
        <div className="flex flex-col gap-0.5">
          {([
            ["memory", "记忆管理器", "dot-ok"],
            ["extensions", "扩展面板（MCP / 插件）", "bg-info"],
            ["settings", "⚙ Provider 设置", "bg-accent"],
          ] as const).map(([target, label, dotClass]) => (
            <button
              key={target}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-2xs transition-colors duration-fast ${
                view === target ? "bg-selected text-hi" : "text-mid hover:bg-hover"
              }`}
              onClick={() => setView(view === target ? "chat" : target)}
            >
              <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${dotClass}`} />
              {label}
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
}
