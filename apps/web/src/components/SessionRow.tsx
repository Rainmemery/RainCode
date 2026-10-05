/**
 * 会话行 + 「⋯」操作菜单（自 Sidebar 抽出以护 500 行门禁）：仅 Active 行显示菜单，
 * 行内重命名 / 分叉 / 归档两段确认；键盘高亮行（§8.1）以 bg-hover + 左侧 accent 指示条呈现。
 */
import type { SessionListEntry } from "../session-view.js";

const MENU_ITEM_CLASS =
  "block w-full px-2.5 py-1 text-left text-2xs text-mid transition-colors duration-fast hover:bg-hover hover:text-hi";

/** 相对时间（刚刚 / N 分钟前 / N 小时前 / N 天前；Sidebar 折叠态 title 复用）。 */
export function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

interface SessionRowProps {
  row: SessionListEntry;
  active: boolean;
  /** 键盘高亮行（§8.1）：非当前会话时以 bg-hover + 左侧 accent 指示条呈现。 */
  highlighted: boolean;
  /** 展平渲染序，data-session-index 供滚动入视定位。 */
  index: number;
  archived: boolean;
  menuOpen: boolean;
  renaming: boolean;
  archiveConfirm: boolean;
  onSelect: (id: string) => void;
  onOpenMenu: (id: string) => void;
  onCloseMenu: () => void;
  onStartRename: (id: string) => void;
  onRenameSubmit: (id: string, title: string) => void;
  onFork: (id: string) => void;
  onArchiveClick: (id: string) => void;
  onArchiveConfirm: (id: string) => void;
}

/** 会话行 + 「⋯」操作菜单（仅 Active 行；归档行灰态只读无菜单）：重命名行内编辑 / 分叉 / 归档两段确认。 */
export function SessionRowItem(props: SessionRowProps): JSX.Element {
  const { row, active, highlighted, index, archived, menuOpen, renaming, archiveConfirm } = props;
  if (renaming) {
    return (
      <div className="mb-0.5 flex h-8 items-center rounded-md bg-selected px-2">
        <input
          autoFocus
          className="h-6 min-w-0 flex-1 rounded-sm border border-accent-dim bg-raised px-1.5 text-2xs text-hi outline-none"
          defaultValue={row.title}
          maxLength={200}
          onKeyDown={(e) => {
            if (e.key === "Enter") props.onRenameSubmit(row.id, e.currentTarget.value);
            if (e.key === "Escape") props.onCloseMenu();
          }}
          onBlur={props.onCloseMenu}
          title="Enter 提交重命名，Esc 取消"
        />
      </div>
    );
  }
  return (
    <div className="relative mb-0.5">
      <div
        data-session-index={index}
        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 transition-colors duration-fast ${
          active ? "bg-selected" : highlighted ? "bg-hover" : "hover:bg-hover"
        } ${archived ? "opacity-60" : ""}`}
      >
        {(active || highlighted) && <span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-accent" />}
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => props.onSelect(row.id)}
          title={archived ? `${row.title}（已归档，只读）` : row.title}
        >
          <span className={`min-w-0 flex-1 truncate text-2xs ${active ? "text-hi" : "text-mid"}`}>{row.title}</span>
          <span className="shrink-0 text-2xs text-faint">{relativeTime(row.lastActiveAt)}</span>
        </button>
        {!archived && (
          <button
            type="button"
            className="shrink-0 rounded-sm px-1 text-2xs text-low transition-colors duration-fast hover:bg-hover hover:text-hi"
            onClick={() => props.onOpenMenu(row.id)}
            title="会话操作（重命名 / 分叉 / 归档）"
          >
            ⋯
          </button>
        )}
      </div>
      {menuOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={props.onCloseMenu} title="关闭菜单" />
          <div className="anim-rise absolute right-1 top-full z-50 w-28 rounded-md border border-border-faint bg-card py-1 shadow-2">
            <button type="button" className={MENU_ITEM_CLASS} onClick={() => props.onStartRename(row.id)}>
              重命名
            </button>
            <button type="button" className={MENU_ITEM_CLASS} onClick={() => props.onFork(row.id)}>
              分叉
            </button>
            {archiveConfirm ? (
              <button
                type="button"
                className="block w-full px-2.5 py-1 text-left text-2xs text-danger transition-colors duration-fast hover:bg-hover"
                onClick={() => props.onArchiveConfirm(row.id)}
              >
                确认归档？
              </button>
            ) : (
              <button type="button" className={MENU_ITEM_CLASS} onClick={() => props.onArchiveClick(row.id)}>
                归档
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
