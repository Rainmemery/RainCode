/**
 * 左侧栏（03 §6.1，宽 264px；UI 重设计轮精修）：品牌头（✦ RainCode）+ 工作区切换器 + 新建会话
 * 主按钮 + 会话检索框 + 会话列表（当前项 accent 指示条）+ 底部 Provider 状态与面板入口
 * （模块标识色：记忆=ok / 扩展=info / 设置=accent，03 §3.1）。
 * 侧栏折叠（refine-ui-context-panel 轮 §6.0）：264px 展开态 ↔ 56px 图标态（默认展开，
 * 用户主动切换）；折叠态保留品牌 ✦ / 新建 + / 搜索 ⌕ / 会话指示点 / 面板入口模块点，悬停出 title。
 * 走查 DOM 契约在默认展开态保持原样（walkthrough-desktop.mts：「+ 新会话」等文案与结构零变更）。
 * 会话列表时间分组（refine-ui-context-panel 轮 §6.1）：今天 / 昨天 / 更早三组标题。
 * UI 管理面板深化轮：检索行（300ms 防抖 keyword 重拉）→ filterSessionRows（归档/子会话双开关，
 * localStorage 持久化）→ groupSessions 分组；会话项「⋯」菜单（重命名 / 分叉 / 归档两段确认，
 * 仅未归档行；归档行灰态只读）。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { filterSessionRows } from "../session-filters.js";
import { groupSessions } from "../subagent-view.js";
import { useDesktop } from "../store.js";
import { nextTheme, THEME_LABEL } from "../theme.js";
import type { SessionListEntry } from "../session-view.js";

type SessionRow = SessionListEntry;

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

const MENU_ITEM_CLASS =
  "block w-full px-3 py-1.5 text-left text-2xs text-mid transition-colors duration-fast hover:bg-hover hover:text-hi";

/**
 * 会话行（memo）：标题 + 相对时间 +「⋯」操作菜单（重命名 / 分叉 / 归档两段确认）。
 * 归档行灰态（opacity-60）只读无菜单；重命名为行内 input（Enter 提交，1~200 字符约束）。
 */
const SessionItem = memo(function SessionItem({
  session,
  active,
  onOpen,
  onRename,
  onFork,
  onArchive,
}: {
  session: SessionRow;
  active: boolean;
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onFork: (id: string) => void;
  onArchive: (id: string) => void;
}) {
  const archived = session.state === "Archived";
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [draft, setDraft] = useState("");
  const titleValid = draft.trim().length >= 1 && draft.trim().length <= 200;

  function startRename(): void {
    setMenuOpen(false);
    setConfirmArchive(false);
    setDraft(session.title);
    setRenaming(true);
  }

  function commitRename(): void {
    if (!titleValid) return; // 1~200 字符约束（06 §2.1 session.rename schema 同口径）
    const title = draft.trim();
    setRenaming(false);
    if (title !== session.title) onRename(session.id, title);
  }

  return (
    <div
      className={`relative flex items-center transition-colors duration-fast ${archived ? "opacity-60" : ""} ${
        active ? "bg-selected" : "hover:bg-hover"
      }`}
      title={archived ? "已归档会话（只读）" : undefined}
    >
      {active && <span className="absolute inset-y-0 left-0 w-0.5 bg-accent" />}
      {renaming ? (
        <input
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => setRenaming(false)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && titleValid) {
              event.preventDefault();
              commitRename();
            } else if (event.key === "Escape") {
              event.preventDefault();
              setRenaming(false);
            }
          }}
          title="标题需 1~200 字符：Enter 提交，Esc 取消"
          className="mx-3 my-1 h-6 min-w-0 flex-1 rounded border border-border-base bg-raised px-1.5 text-2xs text-hi outline-none focus:border-accent-dim"
        />
      ) : (
        <button
          type="button"
          onClick={() => onOpen(session.id)}
          className="flex min-w-0 flex-1 items-center gap-2 px-4 py-1.5 text-left"
        >
          <span className={`min-w-0 flex-1 truncate text-2xs ${active ? "text-hi" : "text-mid"}`}>{session.title}</span>
          <span className="shrink-0 text-2xs text-faint">{relativeTime(session.lastActiveAt)}</span>
        </button>
      )}
      {!archived && !renaming && (
        <button
          type="button"
          onClick={() => {
            setMenuOpen(!menuOpen);
            setConfirmArchive(false);
          }}
          className="h-6 shrink-0 rounded px-1.5 text-2xs text-faint transition-colors duration-fast hover:text-hi"
          title="会话操作"
        >
          ⋯
        </button>
      )}
      {menuOpen && !renaming && (
        <>
          {/* 遮罩点击关闭（z-40 在菜单下方，吞掉本次点击不误触底层行） */}
          <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
          <div className="absolute right-1 top-7 z-50 w-36 rounded-md border border-border-faint bg-popover py-1 shadow-2">
            <button type="button" onClick={startRename} className={MENU_ITEM_CLASS}>
              重命名
            </button>
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                onFork(session.id);
              }}
              className={MENU_ITEM_CLASS}
              title="复制全量历史分叉新会话（新会话独立演进）"
            >
              分叉
            </button>
            {confirmArchive ? (
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onArchive(session.id);
                }}
                className="block w-full px-3 py-1.5 text-left text-2xs text-danger transition-colors duration-fast hover:bg-hover"
                title="归档后移出默认列表（可用侧栏「已归档」开关找回）"
              >
                确认归档？
              </button>
            ) : (
              <button type="button" onClick={() => setConfirmArchive(true)} className={MENU_ITEM_CLASS}>
                归档
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
});

/** 侧栏底部过滤开关（UI 管理面板深化轮）：已归档 / 子会话，localStorage 持久化。 */
function FilterToggle({ label, on, onToggle }: { label: string; on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex items-center gap-1.5 text-2xs text-low transition-colors duration-fast hover:text-hi"
      title={on ? `显示${label}` : `隐藏${label}`}
    >
      <span
        className={`flex h-3 w-3 items-center justify-center rounded-sm border ${
          on ? "border-accent bg-accent" : "border-border-strong"
        }`}
      >
        {on && <span className="text-[8px] leading-none text-on-accent">✓</span>}
      </span>
      {label}
    </button>
  );
}

export default function Sidebar() {
  const workspace = useDesktop((s) => s.workspace);
  const sessions = useDesktop((s) => s.sessions);
  const activeId = useDesktop((s) => s.activeId);
  const providers = useDesktop((s) => s.providers);
  const activeProviderId = useDesktop((s) => s.activeProviderId);
  const usage = useDesktop((s) => s.usage);
  const showArchived = useDesktop((s) => s.showArchived);
  const showSubsessions = useDesktop((s) => s.showSubsessions);
  const pickWorkspace = useDesktop((s) => s.pickWorkspace);
  const createSession = useDesktop((s) => s.createSession);
  const selectSession = useDesktop((s) => s.selectSession);
  const setView = useDesktop((s) => s.setView);
  const setTheme = useDesktop((s) => s.setTheme);
  const refreshSessions = useDesktop((s) => s.refreshSessions);
  const renameSession = useDesktop((s) => s.renameSession);
  const forkSession = useDesktop((s) => s.forkSession);
  const archiveSession = useDesktop((s) => s.archiveSession);
  const setShowArchived = useDesktop((s) => s.setShowArchived);
  const setShowSubsessions = useDesktop((s) => s.setShowSubsessions);
  const theme = useDesktop((s) => s.theme);
  const [collapsed, setCollapsed] = useState(false);
  const [query, setQuery] = useState("");
  const [pendingSearchFocus, setPendingSearchFocus] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const lastFetched = useRef<string | null>(null);

  // 检索 300ms 防抖：keyword 重拉列表（服务端过滤）；挂载首跑跳过（bootstrap 已拉全量）
  useEffect(() => {
    const trimmed = query.trim();
    if (lastFetched.current === null) {
      lastFetched.current = trimmed;
      return;
    }
    const timer = setTimeout(() => {
      lastFetched.current = trimmed;
      void refreshSessions(query);
    }, 300);
    return () => clearTimeout(timer);
  }, [query, refreshSessions]);

  // 折叠态「⌕」→ 展开并聚焦搜索框（展开动效后 focus）
  useEffect(() => {
    if (!collapsed && pendingSearchFocus) {
      searchRef.current?.focus();
      setPendingSearchFocus(false);
    }
  }, [collapsed, pendingSearchFocus]);

  const activeProvider = providers.find((provider) => provider.id === activeProviderId) ?? null;
  // 渲染链 = 检索行（服务端 keyword）→ filterSessionRows（归档/子会话）→ 时间分组
  const visibleSessions = useMemo(
    () => filterSessionRows(sessions, { showArchived, showSubsessions }),
    [sessions, showArchived, showSubsessions],
  );
  const groups = useMemo(() => groupSessions(visibleSessions, Date.now()), [visibleSessions]);

  const openSession = useCallback((id: string) => void selectSession(id), [selectSession]);
  const doRename = useCallback((id: string, title: string) => void renameSession(id, title), [renameSession]);
  const doFork = useCallback((id: string) => void forkSession(id), [forkSession]);
  const doArchive = useCallback((id: string) => void archiveSession(id), [archiveSession]);

  function renderSession(session: SessionRow): JSX.Element {
    return (
      <SessionItem
        key={session.id}
        session={session}
        active={session.id === activeId}
        onOpen={openSession}
        onRename={doRename}
        onFork={doFork}
        onArchive={doArchive}
      />
    );
  }

  if (collapsed) {
    return (
      <aside className="flex w-14 shrink-0 flex-col items-center gap-2 border-r border-border-base bg-panel py-3">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="rounded-sm px-1.5 py-0.5 text-2xs text-low transition-colors duration-fast hover:bg-hover hover:text-hi"
          title="展开侧栏"
        >
          ›
        </button>
        <button type="button" onClick={() => setCollapsed(false)} className="text-sm text-accent" title="RainCode">
          ✦
        </button>
        <button
          type="button"
          onClick={() => void createSession()}
          className="flex h-7 w-7 items-center justify-center rounded-md text-2xs text-mid transition-colors duration-fast hover:bg-hover hover:text-hi"
          title="新建会话"
        >
          +
        </button>
        <button
          type="button"
          onClick={() => {
            setPendingSearchFocus(true);
            setCollapsed(false);
          }}
          className="flex h-7 w-7 items-center justify-center rounded-md text-2xs text-mid transition-colors duration-fast hover:bg-hover hover:text-hi"
          title="搜索会话"
        >
          ⌕
        </button>
        <nav className="flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto py-1">
          {sessions.map((session) => {
            const active = session.id === activeId;
            return (
              <button
                key={session.id}
                type="button"
                onClick={() => void selectSession(session.id)}
                title={session.title}
                className={`h-2 w-2 shrink-0 rounded-full transition-colors duration-fast ${
                  active ? "bg-accent" : "border border-border-strong"
                }`}
              />
            );
          })}
        </nav>
        <div className="flex flex-col items-center gap-2 border-t border-border-faint pt-2">
          <button
            type="button"
            onClick={() => setView("memory")}
            className="flex h-6 w-6 items-center justify-center rounded-md transition-colors duration-fast hover:bg-hover"
            title="记忆管理器"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-ok" />
          </button>
          <button
            type="button"
            onClick={() => setView("extensions")}
            className="flex h-6 w-6 items-center justify-center rounded-md transition-colors duration-fast hover:bg-hover"
            title="扩展面板（MCP / 插件）"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-info" />
          </button>
          <button
            type="button"
            onClick={() => setView("settings")}
            className="flex h-6 w-6 items-center justify-center rounded-md transition-colors duration-fast hover:bg-hover"
            title="设置"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
          </button>
          <button
            type="button"
            onClick={() => setTheme(nextTheme(theme))}
            className="rounded-sm px-1.5 py-0.5 text-2xs text-low transition-colors duration-fast hover:bg-hover hover:text-hi"
            title="切换主题（深色 → 浅色 → 跟随系统）"
          >
            ◐
          </button>
          <span
            className={`dot ${activeProvider !== null ? "dot-ok" : "dot-warn"}`}
            title={activeProvider !== null ? `${activeProvider.name} · ${activeProvider.model}` : "未配置 Provider"}
          />
        </div>
      </aside>
    );
  }

  return (
    <aside className="flex w-[264px] shrink-0 flex-col border-r border-border-base bg-panel">
      <div className="border-b border-border-faint px-4 py-2.5">
        <div className="flex items-baseline gap-1.5">
          <span className="text-sm text-accent">✦</span>
          <span className="text-sm font-semibold text-hi">RainCode</span>
          {/* 主题切换（03 §3.2：深色 → 浅色 → 跟随系统循环） */}
          <button
            type="button"
            className="ml-auto rounded-sm px-1.5 py-0.5 text-2xs text-low transition-colors duration-fast hover:bg-hover hover:text-hi"
            onClick={() => setTheme(nextTheme(theme))}
            title="切换主题（深色 → 浅色 → 跟随系统）"
          >
            ◐ {THEME_LABEL[theme]}
          </button>
          {/* 侧栏折叠切换（refine-ui-context-panel 轮 §6.0） */}
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            className="rounded-sm px-1.5 py-0.5 text-2xs text-low transition-colors duration-fast hover:bg-hover hover:text-hi"
            title="折叠侧栏"
          >
            ‹
          </button>
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
          className="h-8 w-full rounded-md bg-accent text-2xs text-on-accent transition-colors duration-fast hover:bg-accent-hover"
        >
          + 新建会话
        </button>
      </div>
      {/* 会话检索行（UI 管理面板深化轮）：300ms 防抖 keyword 重拉列表 */}
      <div className="border-b border-border-faint px-3 pb-2">
        <input
          ref={searchRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索会话"
          className="h-7 w-full rounded-md border border-border-base bg-raised px-2 text-2xs text-hi outline-none placeholder:text-faint focus:border-accent-dim"
        />
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto">
        {visibleSessions.length === 0 && (
          <div className="px-4 py-3 text-2xs text-faint">{sessions.length === 0 ? "暂无会话" : "无匹配会话"}</div>
        )}
        {groups.today.length > 0 && <div className="px-2 pb-1 pt-2 text-2xs text-faint">今天</div>}
        {groups.today.map((session) => renderSession(session))}
        {groups.yesterday.length > 0 && <div className="px-2 pb-1 pt-2 text-2xs text-faint">昨天</div>}
        {groups.yesterday.map((session) => renderSession(session))}
        {groups.earlier.length > 0 && <div className="px-2 pb-1 pt-2 text-2xs text-faint">更早</div>}
        {groups.earlier.map((session) => renderSession(session))}
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
        {/* 会话过滤开关（UI 管理面板深化轮）：归档/子会话默认隐藏 */}
        <div className="mb-2 flex items-center gap-3 px-1">
          <FilterToggle label="已归档" on={showArchived} onToggle={() => setShowArchived(!showArchived)} />
          <FilterToggle label="子会话" on={showSubsessions} onToggle={() => setShowSubsessions(!showSubsessions)} />
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
