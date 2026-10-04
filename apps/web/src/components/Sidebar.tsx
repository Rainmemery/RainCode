/**
 * 侧栏（03 §6.2 Web 适配；UI 重设计轮对齐赤陶磷光 v2；refine-ui-context-panel 轮增折叠与
 * 时间分组）：品牌头（✦ RainCode）+ 连接状态徽章 + 工作区输入 + 新建会话主按钮 +
 * 会话列表（今天/昨天/更早分组，当前项 accent 指示条）+ 用量统计行 + 管理面板入口
 * （模块标识色：记忆=ok / 扩展=info / 设置=accent）。折叠态为 56px 图标态（品牌 ✦、新建 +、
 * 会话色点列、面板入口模块点、主题 ◐、连接 dot，悬停出 title）；走查 DOM 契约在默认展开态
 * 保持原样（aside 首个 input / 「+ 新会话」/「设定」/ 面板入口中文文案）。T4.5 对齐桌面端 UI-4。
 */
import { useState } from "react";
import { useWeb } from "../state.js";
import { groupSessions } from "../subagent-view.js";
import { nextTheme, THEME_LABEL } from "../theme.js";

const CONNECTION_LABEL: Record<string, { text: string; className: string; dot: string }> = {
  connecting: { text: "连接中…", className: "bg-warn/10 text-warn border border-warn/40", dot: "dot dot-warn" },
  ready: { text: "已连接", className: "bg-ok/10 text-ok border border-ok/40", dot: "dot dot-ok" },
  reconnecting: { text: "重连中（断线补偿）…", className: "bg-warn/10 text-warn border border-warn/40", dot: "dot dot-warn" },
  closed: { text: "已断开", className: "bg-danger/10 text-danger border border-danger/40", dot: "dot dot-err" },
};

/** 面板入口（走查契约文案；模块标识色折叠态用 bg 色点投影）。 */
const PANEL_ENTRIES = [
  ["memory", "记忆管理器", "bg-ok"],
  ["extensions", "扩展面板（MCP / 插件）", "bg-info"],
  ["settings", "⚙ Provider 设置", "bg-accent"],
] as const;

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
  // 折叠态为本地交互态（默认展开，不进 store；03 §6.0：264px ↔ 56px）
  const [collapsed, setCollapsed] = useState(false);

  const badge = CONNECTION_LABEL[connection] ?? CONNECTION_LABEL["connecting"]!;
  const groups = groupSessions(sessions, Date.now());

  // -----------------------------------------------------------------
  // 折叠态：56px 图标态（品牌 ✦ / 新建 + / 会话色点列 / 面板模块点 / 主题 / 连接 dot）
  // -----------------------------------------------------------------
  if (collapsed) {
    return (
      <aside className="flex w-14 shrink-0 flex-col items-center gap-2 border-r border-border-base bg-panel py-3">
        <button
          type="button"
          className="text-sm text-accent transition-opacity duration-fast hover:opacity-80"
          onClick={() => setCollapsed(false)}
          title="展开侧栏"
        >
          ✦
        </button>
        <button
          type="button"
          className="flex h-7 w-7 items-center justify-center rounded-md border border-border-strong text-2xs text-mid transition-colors duration-fast hover:bg-hover hover:text-hi"
          onClick={() => void createSession()}
          title="新建会话"
        >
          +
        </button>
        {/* 会话列表 → 色点列（active=accent 实心点，其余 border-strong 空心点） */}
        <nav className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto py-1">
          {sessions.map((row) => {
            const active = row.id === activeId;
            return (
              <button
                key={row.id}
                type="button"
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors duration-fast hover:bg-hover"
                onClick={() => void selectSession(row.id)}
                title={`${row.title} · ${relativeTime(row.lastActiveAt)}`}
              >
                <span className={`h-2 w-2 rounded-full ${active ? "bg-accent" : "border border-border-strong"}`} />
              </button>
            );
          })}
        </nav>
        <div className="flex flex-col items-center gap-1.5 border-t border-border-faint pt-2">
          {PANEL_ENTRIES.map(([target, label, dotBg]) => (
            <button
              key={target}
              type="button"
              className="flex h-6 w-6 items-center justify-center rounded-md transition-colors duration-fast hover:bg-hover"
              onClick={() => setView(target)}
              title={label}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${dotBg}`} />
            </button>
          ))}
          <button
            type="button"
            className="flex h-6 w-6 items-center justify-center rounded-md text-2xs text-low transition-colors duration-fast hover:bg-hover hover:text-hi"
            onClick={() => setTheme(nextTheme(theme))}
            title="切换主题（深色 → 浅色 → 跟随系统）"
          >
            ◐
          </button>
          <span className={badge.dot} title={badge.text} />
        </div>
      </aside>
    );
  }

  // -----------------------------------------------------------------
  // 展开态：结构保持现状（走查契约：aside 首个 input 为工作区输入）
  // -----------------------------------------------------------------
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border-base bg-panel">
      {/* 品牌头 + 连接状态 + 主题切换 + 折叠（03 §3.2：深色 → 浅色 → 跟随系统循环） */}
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
          <button
            className="rounded-sm px-1.5 py-0.5 text-2xs text-low transition-colors duration-fast hover:bg-hover hover:text-hi"
            onClick={() => setCollapsed(true)}
            title="折叠侧栏"
          >
            ‹
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
      {/* 会话列表：今天 / 昨天 / 更早 三组（组内保持 lastActiveAt 降序入参顺序） */}
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {sessions.length === 0 && <div className="px-2 py-2 text-2xs text-faint">暂无会话</div>}
        {([["今天", groups.today], ["昨天", groups.yesterday], ["更早", groups.earlier]] as const).map(
          ([label, rows]) =>
            rows.length === 0 ? null : (
              <div key={label}>
                <div className="px-2 pb-1 pt-2 text-2xs text-faint">{label}</div>
                {rows.map((row) => {
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
              </div>
            ),
        )}
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
          {PANEL_ENTRIES.map(([target, label, dotBg]) => (
            <button
              key={target}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-2xs transition-colors duration-fast ${
                view === target ? "bg-selected text-hi" : "text-mid hover:bg-hover"
              }`}
              onClick={() => setView(view === target ? "chat" : target)}
            >
              <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${dotBg}`} />
              {label}
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
}
