/**
 * 左侧栏（03 §6.1，宽 264px）：工作区切换器 + 新建会话主按钮 + 会话列表 + 底部 Provider 状态与设置入口。
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

export default function Sidebar() {
  const workspace = useDesktop((s) => s.workspace);
  const sessions = useDesktop((s) => s.sessions);
  const activeId = useDesktop((s) => s.activeId);
  const providers = useDesktop((s) => s.providers);
  const activeProviderId = useDesktop((s) => s.activeProviderId);
  const pickWorkspace = useDesktop((s) => s.pickWorkspace);
  const createSession = useDesktop((s) => s.createSession);
  const selectSession = useDesktop((s) => s.selectSession);
  const setView = useDesktop((s) => s.setView);

  const activeProvider = providers.find((provider) => provider.id === activeProviderId) ?? null;

  return (
    <aside className="flex w-[264px] shrink-0 flex-col border-r border-border-base bg-panel">
      <button
        type="button"
        onClick={() => void pickWorkspace()}
        className="border-b border-border-faint px-4 py-2.5 text-left hover:bg-hover"
        title={workspace ?? "点击选择工作区目录"}
      >
        <div className="truncate text-hi">{workspace !== null ? shortName(workspace) : "选择工作区"}</div>
        <div className="truncate text-2xs text-low">{workspace ?? "点击切换项目目录"}</div>
      </button>
      <div className="px-3 py-2">
        <button
          type="button"
          onClick={() => void createSession()}
          className="h-8 w-full rounded-md bg-accent text-2xs text-void hover:bg-accent-hover"
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
              className={`relative flex w-full items-center gap-2 px-4 py-1.5 text-left hover:bg-hover ${active ? "bg-selected" : ""}`}
            >
              {active && <span className="absolute inset-y-0 left-0 w-0.5 bg-accent" />}
              <span className={`min-w-0 flex-1 truncate text-2xs ${active ? "text-hi" : "text-mid"}`}>{session.title}</span>
              <span className="shrink-0 text-2xs text-faint">{relativeTime(session.lastActiveAt)}</span>
            </button>
          );
        })}
      </nav>
      <div className="border-t border-border-faint px-3 py-2.5">
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
        <button
          type="button"
          onClick={() => setView("settings")}
          className="h-8 w-full rounded-md border border-border-strong text-2xs text-mid hover:bg-hover"
        >
          设置
        </button>
      </div>
    </aside>
  );
}
