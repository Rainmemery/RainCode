/**
 * 顶层布局：连接状态横条 + 可关闭错误横条 + 视图切换（chat 三栏主界面 / settings 设置页 /
 * memory 记忆管理器 / extensions 扩展面板）+ 审批弹窗模态叠加（03 §6.1 / §7）。
 * chat 三栏：侧栏（可折叠）+ 会话流 + 右侧上下文面板（仅 chat 视图常驻，可折叠为右缘竖条；
 * refine-ui-context-panel 轮）；settings/memory/extensions 整页视图右栏不渲染。
 * 全局快捷键（UI 管理面板深化轮）：Ctrl/Cmd+N 新建会话、Ctrl/Cmd+J 右侧上下文面板
 * （一次注册；Electron 端完整可用，浏览器端宿主可能保留）。
 */
import { useEffect } from "react";
import { useDesktop } from "./store.js";
import Sidebar from "./components/Sidebar.js";
import ChatFlow from "./components/ChatFlow.js";
import SettingsView from "./components/SettingsView.js";
import MemoryManager from "./components/MemoryManager.js";
import ExtensionsPanel from "./components/ExtensionsPanel.js";
import ContextPanel, { ContextPanelRail } from "./components/ContextPanel.js";
import ApprovalDialog from "./components/ApprovalDialog.js";

export default function App() {
  const connection = useDesktop((s) => s.connection);
  const view = useDesktop((s) => s.view);
  const error = useDesktop((s) => s.error);
  const contextPanelCollapsed = useDesktop((s) => s.contextPanelCollapsed);
  const hasApprovals = useDesktop((s) => s.approvals.length > 0);
  const dismissError = useDesktop((s) => s.dismissError);

  // 全局键盘快捷键（一次注册；getState 直取动作避免依赖抖动）：
  // (ctrl||meta) 且非 alt/shift：n → 新建会话；j → 右侧上下文面板折叠切换
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      const key = event.key.toLowerCase();
      if (key === "n") {
        event.preventDefault();
        void useDesktop.getState().createSession();
      } else if (key === "j") {
        event.preventDefault();
        useDesktop.getState().toggleContextPanel();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="flex h-full flex-col bg-base text-hi">
      {connection === "agent-down" && (
        <div className="flex items-center gap-2 border-b border-danger bg-raised px-4 py-1.5 text-2xs text-danger">
          <span className="dot dot-err" />
          Agent 子进程已断开，正在重启…
        </div>
      )}
      {error !== null && (
        <div className="flex items-center gap-2 border-b border-danger bg-raised px-4 py-1.5 text-2xs text-danger">
          <span className="min-w-0 flex-1 truncate">{error}</span>
          <button type="button" onClick={dismissError} className="shrink-0 text-danger hover:text-hi" title="关闭">
            ✕
          </button>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        {view === "chat" && (
          <>
            <Sidebar />
            <ChatFlow />
            {contextPanelCollapsed ? <ContextPanelRail /> : <ContextPanel />}
          </>
        )}
        {view === "settings" && (
          <div className="anim-fade flex min-w-0 flex-1">
            <SettingsView />
          </div>
        )}
        {view === "memory" && (
          <div className="anim-fade flex min-w-0 flex-1">
            <MemoryManager />
          </div>
        )}
        {view === "extensions" && (
          <div className="anim-fade flex min-w-0 flex-1">
            <ExtensionsPanel />
          </div>
        )}
      </div>
      {hasApprovals && <ApprovalDialog />}
    </div>
  );
}
