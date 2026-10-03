/** 侧栏：连接状态条（重连状态可视化）+ 工作区输入 + 会话列表（03 §6.2 Web 适配）。 */
import { useState } from "react";
import { useWeb } from "../state.js";

const CONNECTION_LABEL: Record<string, { text: string; className: string }> = {
  connecting: { text: "连接中…", className: "bg-warn/20 text-warn" },
  ready: { text: "已连接", className: "bg-ok/20 text-ok" },
  reconnecting: { text: "重连中（断线补偿）…", className: "bg-warn/20 text-warn" },
  closed: { text: "已断开", className: "bg-danger/20 text-danger" },
};

export function Sidebar(): JSX.Element {
  const connection = useWeb((s) => s.connection);
  const sessions = useWeb((s) => s.sessions);
  const activeId = useWeb((s) => s.activeId);
  const workspace = useWeb((s) => s.workspace);
  const view = useWeb((s) => s.view);
  const setWorkspace = useWeb((s) => s.setWorkspace);
  const setView = useWeb((s) => s.setView);
  const selectSession = useWeb((s) => s.selectSession);
  const createSession = useWeb((s) => s.createSession);
  const [workspaceDraft, setWorkspaceDraft] = useState(workspace ?? "");

  const badge = CONNECTION_LABEL[connection] ?? CONNECTION_LABEL["connecting"]!;

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-ink-700 bg-ink-900">
      <div className="border-b border-ink-700 p-3">
        <div className="mb-1 text-sm font-semibold">RainCode Web</div>
        <span className={`inline-block rounded px-2 py-0.5 text-xs ${badge.className}`}>{badge.text}</span>
      </div>
      <div className="border-b border-ink-700 p-3">
        <label className="mb-1 block text-xs text-gray-400">工作区目录（绝对路径）</label>
        <div className="flex gap-1">
          <input
            className="min-w-0 flex-1 rounded border border-ink-700 bg-ink-950 px-2 py-1 text-xs"
            placeholder="D:\path\to\workspace"
            value={workspaceDraft}
            onChange={(e) => setWorkspaceDraft(e.target.value)}
          />
          <button
            className="rounded bg-accent-dim px-2 py-1 text-xs text-white"
            onClick={() => setWorkspace(workspaceDraft)}
          >
            设定
          </button>
        </div>
        {workspace !== null ? <p className="mt-1 truncate text-xs text-gray-500" title={workspace}>{workspace}</p> : null}
      </div>
      <button
        className="m-3 rounded bg-accent-dim px-3 py-1.5 text-sm text-white"
        onClick={() => void createSession()}
      >
        + 新会话
      </button>
      <nav className="flex-1 overflow-y-auto px-2 pb-2">
        {sessions.map((row) => (
          <button
            key={row.id}
            className={`mb-1 w-full truncate rounded px-2 py-1.5 text-left text-sm ${
              row.id === activeId ? "bg-ink-700 text-white" : "text-gray-300 hover:bg-ink-800"
            }`}
            onClick={() => void selectSession(row.id)}
            title={row.title}
          >
            {row.title}
          </button>
        ))}
      </nav>
      <div className="border-t border-ink-700 p-2">
        <button
          className={`w-full rounded px-2 py-1.5 text-left text-sm ${view === "settings" ? "bg-ink-700" : "hover:bg-ink-800"}`}
          onClick={() => setView(view === "settings" ? "chat" : "settings")}
        >
          ⚙ Provider 设置
        </button>
      </div>
    </aside>
  );
}
