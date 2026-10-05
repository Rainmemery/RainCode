/**
 * 会话行（自 Sidebar 拆分的既有纪律，护架构门禁单文件 ≤500 行）：
 * 标题 + 相对时间 +「⋯」操作菜单（重命名 / 分叉 / 归档两段确认）。归档行灰态（opacity-60）
 * 只读无菜单；重命名为行内 input（Enter 提交，1~200 字符约束）。
 * polish-ui-states-and-runtime A5：新增 keyboard 归档两段确认（archivePending，复用同一 onArchive
 * 处置）与键盘高亮（highlighted）；根节点 `data-nav-row` 供列表 ↑↓ 导航定位滚动。
 */
import { memo, useState } from "react";
import type { SessionListEntry } from "../session-view.js";

type SessionRow = SessionListEntry;

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

const MENU_ITEM_CLASS =
  "block w-full px-3 py-1.5 text-left text-2xs text-mid transition-colors duration-fast hover:bg-hover hover:text-hi";

export default memo(function SessionItem({
  session,
  active,
  highlighted,
  archivePending,
  onOpen,
  onRename,
  onFork,
  onCancelArchive,
  onArchive,
}: {
  session: SessionRow;
  active: boolean;
  highlighted: boolean;
  archivePending: boolean;
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onFork: (id: string) => void;
  onCancelArchive: () => void;
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
      data-nav-row
      className={`relative flex items-center transition-colors duration-fast ${archived ? "opacity-60" : ""} ${
        highlighted || active ? "bg-selected" : "hover:bg-hover"
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
      {archivePending ? (
        <>
          <button
            type="button"
            onClick={onCancelArchive}
            className="h-6 shrink-0 rounded border border-border-strong px-1.5 text-2xs text-mid transition-colors duration-fast hover:bg-hover"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => onArchive(session.id)}
            className="mr-1 h-6 shrink-0 rounded border border-danger px-1.5 text-2xs text-danger transition-colors duration-fast hover:bg-hover"
            title="归档后移出默认列表（可用侧栏「已归档」开关找回）"
          >
            确认归档？
          </button>
        </>
      ) : (
        !archived &&
        !renaming && (
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
        )
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
