/**
 * Web 会话工作台（T3.8 / UI-5；T4.5 管理面板对齐）：侧栏（连接状态/工作区/会话/用量/面板入口）+
 * 会话流 + 审批弹窗 + Provider 设置 + 记忆管理器 + 扩展面板。服务能力与桌面端同源
 * （同一 AgentService 方法表，06 §6.3）；面板按端最小实现，复用协议与状态机语义（04 §2.3 policy）。
 */
import { useEffect } from "react";
import { useWeb } from "./state.js";
import { Sidebar } from "./components/Sidebar.js";
import { ChatFlow } from "./components/ChatFlow.js";
import { InputArea } from "./components/InputArea.js";
import { ApprovalDialog } from "./components/ApprovalDialog.js";
import { ProviderSettings } from "./components/ProviderSettings.js";
import { MemoryManager } from "./components/MemoryManager.js";
import { ExtensionsPanel } from "./components/ExtensionsPanel.js";

export function App(): JSX.Element {
  const bootstrap = useWeb((s) => s.bootstrap);
  const view = useWeb((s) => s.view);
  const connection = useWeb((s) => s.connection);
  const fatal = useWeb((s) => s.fatal);
  const activeId = useWeb((s) => s.activeId);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  return (
    <div className="flex h-full bg-base text-hi">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        {fatal !== null ? (
          <div className="flex flex-1 items-center justify-center p-8">
            <div className="anim-rise max-w-md rounded-xl border border-danger bg-card p-6 text-sm shadow-3">
              <div className="flex items-center gap-2">
                <span className="dot dot-err" />
                <p className="font-semibold text-danger">连接被拒绝</p>
              </div>
              <p className="mt-2 text-mid">{fatal}</p>
              <p className="mt-3 text-2xs text-low">请核对 raincode web 输出的 token 后刷新页面。</p>
            </div>
          </div>
        ) : view === "settings" ? (
          <div className="anim-fade flex min-h-0 flex-1 flex-col">
            <ProviderSettings />
          </div>
        ) : view === "memory" ? (
          <div className="anim-fade flex min-h-0 flex-1 flex-col">
            <MemoryManager />
          </div>
        ) : view === "extensions" ? (
          <div className="anim-fade flex min-h-0 flex-1 flex-col">
            <ExtensionsPanel />
          </div>
        ) : (
          <>
            <ChatFlow />
            {connection === "ready" && activeId !== null ? <InputArea /> : null}
          </>
        )}
        <ApprovalDialog />
      </main>
    </div>
  );
}
