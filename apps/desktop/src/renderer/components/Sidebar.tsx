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
 * polish-ui-states-and-runtime A5（§8.1）：会话列表 ↑↓ 移动高亮 / Home·End / Enter 进入会话 /
 * Delete 两段归档确认；高亮行 scrollIntoView block:nearest 入视。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { filterSessionRows } from "../session-filters.js";
import { nextIndexFromKey } from "../list-nav.js";
import { groupSessions } from "../subagent-view.js";
import { useDesktop } from "../store.js";
import { nextTheme, THEME_LABEL } from "../theme.js";
import SessionItem from "./SessionItem.js";
import type { SessionListEntry } from "../session-view.js";

type SessionRow = SessionListEntry;

function shortName(path: string): string {
  const segments = path.split(/[\\/]+/).filter((part) => part !== "");
  return segments[segments.length - 1] ?? path;
}

/** token 数三档缩写（用量统计行，UI-4）：1234 → 1.2k。 */
function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(1)}m`;
}

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
  // 列表键盘导航（A5）：高亮索引 + 归档两段确认目标（Delete 首次待确认、再次落档）
  const [navIndex, setNavIndex] = useState<number | null>(null);
  const [pendingArchive, setPendingArchive] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const navRef = useRef<HTMLElement | null>(null);
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
  // 列表键盘导航按渲染顺序展平（今天 / 昨天 / 更早），与 DOM 顺序一致
  const orderedSessions = useMemo(
    () => [...groups.today, ...groups.yesterday, ...groups.earlier],
    [groups],
  );
  const navIndexById = useMemo(
    () => new Map(orderedSessions.map((session, index) => [session.id, index])),
    [orderedSessions],
  );

  const openSession = useCallback((id: string) => void selectSession(id), [selectSession]);
  const doRename = useCallback((id: string, title: string) => void renameSession(id, title), [renameSession]);
  const doFork = useCallback((id: string) => void forkSession(id), [forkSession]);
  const doArchive = useCallback(
    (id: string) => {
      setPendingArchive(null);
      void archiveSession(id);
    },
    [archiveSession],
  );

  /** 键盘导航：高亮行滚动入视（block:nearest，最小滚动）。 */
  function scrollSessionIntoView(index: number): void {
    navRef.current?.querySelectorAll<HTMLElement>("[data-nav-row]")[index]?.scrollIntoView({ block: "nearest" });
  }

  /** 会话列表键盘：↑↓/Home/End 移动高亮，Enter 进入会话，Delete 两段归档确认。 */
  function handleListKey(event: KeyboardEvent<HTMLElement>): void {
    const target = event.target;
    // 输入控件聚焦时不劫持按键（重命名 input / 检索框 / 表单）
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;
    const next = nextIndexFromKey(event.key, navIndex ?? -1, orderedSessions.length);
    if (next !== null) {
      event.preventDefault();
      setNavIndex(next);
      scrollSessionIntoView(next);
      return;
    }
    const row = navIndex !== null ? orderedSessions[navIndex] : undefined;
    if (row === undefined) return;
    if (event.key === "Enter") {
      event.preventDefault();
      setPendingArchive(null);
      openSession(row.id);
    } else if (event.key === "Delete") {
      event.preventDefault();
      if (row.state === "Archived") return; // 归档行只读，无归档动作
      if (pendingArchive === row.id) doArchive(row.id);
      else setPendingArchive(row.id);
    }
  }

  function renderSession(session: SessionRow): JSX.Element {
    const index = navIndexById.get(session.id) ?? -1;
    return (
      <SessionItem
        key={session.id}
        session={session}
        active={session.id === activeId}
        highlighted={navIndex === index}
        archivePending={pendingArchive === session.id}
        onOpen={openSession}
        onRename={doRename}
        onFork={doFork}
        onCancelArchive={() => setPendingArchive(null)}
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
      <nav
        ref={navRef}
        tabIndex={0}
        onKeyDown={handleListKey}
        className="min-h-0 flex-1 overflow-y-auto"
        aria-label="会话列表"
      >
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
