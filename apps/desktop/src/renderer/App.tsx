/**
 * 顶层布局：连接状态横条 + 可关闭错误横条 + 视图切换（chat 三栏主界面 / settings 设置页 /
 * memory 记忆管理器 / extensions 扩展面板）+ 审批弹窗模态叠加（03 §6.1 / §7）。
 */
import { useDesktop } from "./store.js";
import Sidebar from "./components/Sidebar.js";
import ChatFlow from "./components/ChatFlow.js";
import ProviderSettings from "./components/ProviderSettings.js";
import MemoryManager from "./components/MemoryManager.js";
import ExtensionsPanel from "./components/ExtensionsPanel.js";
import ApprovalDialog from "./components/ApprovalDialog.js";

export default function App() {
  const connection = useDesktop((s) => s.connection);
  const view = useDesktop((s) => s.view);
  const error = useDesktop((s) => s.error);
  const hasApprovals = useDesktop((s) => s.approvals.length > 0);
  const dismissError = useDesktop((s) => s.dismissError);

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
          </>
        )}
        {view === "settings" && (
          <div className="anim-fade flex min-w-0 flex-1">
            <ProviderSettings />
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
