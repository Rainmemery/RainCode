/**
 * 左侧栏（03 §6.1，宽 264px；UI 重设计轮精修）：品牌头（✦ RainCode）+ 工作区切换器 + 新建会话
 * 主按钮 + 会话列表（当前项 accent 指示条）+ 底部 Provider 状态与面板入口
 * （模块标识色：记忆=ok / 扩展=info / 设置=accent，03 §3.1）。
 */
import { useDesktop } from "../store.js";

function shortName(path: string): string {
  const segments = path.split(/[\\/]+/).filter((part) => part !== "");
  return segments[segments.length - 1] ?? path;
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

/** token 数三档缩写（用量统计行，UI-4）：1234 → 1.2k。 */
function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(1)}m`;
}

export default function Sidebar() {
  const workspace = useDesktop((s) => s.workspace);
  const sessions = useDesktop((s) => s.sessions);
  const activeId = useDesktop((s) => s.activeId);
  const providers = useDesktop((s) => s.providers);
  const activeProviderId = useDesktop((s) => s.activeProviderId);
  const usage = useDesktop((s) => s.usage);
  const pickWorkspace = useDesktop((s) => s.pickWorkspace);
  const createSession = useDesktop((s) => s.createSession);
  const selectSession = useDesktop((s) => s.selectSession);
  const setView = useDesktop((s) => s.setView);

  const activeProvider = providers.find((provider) => provider.id === activeProviderId) ?? null;

  return (
    <aside className="flex w-[264px] shrink-0 flex-col border-r border-border-base bg-panel">
      <div className="border-b border-border-faint px-4 py-2.5">
        <div className="flex items-baseline gap-1.5">
          <span className="text-sm text-accent">✦</span>
          <span className="text-sm font-semibold text-hi">RainCode</span>
        </div>
      </div>
      <button
        type="button"
        onClick={() => void pickWorkspace()}
        className="border-b border-border-faint px-4 py-2.5 text-left transition-colors duration-fast hover:bg-hover"
        title={workspace ?? "点击选择工作区目录"}
      >
        <div className="truncate text-hi">{workspace !== null ? shortName(workspace) : "选择工作区"}</div>
        <div className="mono truncate text-2xs text-low">{workspace ?? "点击切换项目目录"}</div>
      </button>
      <div className="px-3 py-2">
        <button
          type="button"
          onClick={() => void createSession()}
          className="h-8 w-full rounded-md bg-accent text-2xs text-void transition-colors duration-fast hover:bg-accent-hover"
        >
          + 新建会话
        </button>
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto">
        {sessions.length === 0 && <div className="px-4 py-3 text-2xs text-faint">暂无会话</div>}
        {sessions.map((session) => {
          const active = session.id === activeId;
          return (
            <button
              key={session.id}
              type="button"
              onClick={() => void selectSession(session.id)}
              className={`relative flex w-full items-center gap-2 px-4 py-1.5 text-left transition-colors duration-fast hover:bg-hover ${
                active ? "bg-selected" : ""
              }`}
            >
              {active && <span className="absolute inset-y-0 left-0 w-0.5 bg-accent" />}
              <span className={`min-w-0 flex-1 truncate text-2xs ${active ? "text-hi" : "text-mid"}`}>{session.title}</span>
              <span className="shrink-0 text-2xs text-faint">{relativeTime(session.lastActiveAt)}</span>
            </button>
          );
        })}
      </nav>
      <div className="border-t border-border-faint px-3 py-2.5">
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
        <div className="mb-2 flex items-center gap-2 px-1">
          <span className={`dot ${activeProvider !== null ? "dot-ok" : "dot-warn"}`} />
          {activeProvider !== null ? (
            <span className="min-w-0 flex-1 truncate text-2xs text-mid">
              {activeProvider.name} · {activeProvider.model}
            </span>
          ) : (
            <span className="min-w-0 flex-1 truncate text-2xs text-warn">未配置 Provider</span>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <button
            type="button"
            onClick={() => setView("memory")}
            className="flex h-8 w-full items-center gap-2 rounded-md border border-border-strong px-2.5 text-2xs text-mid transition-colors duration-fast hover:bg-hover"
          >
            <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-ok" />
            记忆管理器
          </button>
          <button
            type="button"
            onClick={() => setView("extensions")}
            className="flex h-8 w-full items-center gap-2 rounded-md border border-border-strong px-2.5 text-2xs text-mid transition-colors duration-fast hover:bg-hover"
          >
            <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-info" />
            扩展面板（MCP / 插件）
          </button>
          <button
            type="button"
            onClick={() => setView("settings")}
            className="flex h-8 w-full items-center gap-2 rounded-md border border-border-strong px-2.5 text-2xs text-mid transition-colors duration-fast hover:bg-hover"
          >
            <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
            设置
          </button>
        </div>
      </div>
    </aside>
  );
}
