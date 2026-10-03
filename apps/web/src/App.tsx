/**
 * Web 会话工作台（T3.8 / UI-5）：侧栏（连接状态/工作区/会话）+ 会话流 + 审批弹窗 +
 * Provider 设置。服务能力与桌面端同源（同一 AgentService 方法表，06 §6.3）。
 */
import { useEffect } from "react";
import { useWeb } from "./state.js";
import { Sidebar } from "./components/Sidebar.js";
import { ChatFlow } from "./components/ChatFlow.js";
import { InputArea } from "./components/InputArea.js";
import { ApprovalDialog } from "./components/ApprovalDialog.js";
import { ProviderSettings } from "./components/ProviderSettings.js";

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
    <div className="flex h-full">
      <Sidebar />
      <main className="flex flex-1 flex-col min-w-0">
        {fatal !== null ? (
          <div className="flex flex-1 items-center justify-center p-8">
            <div className="max-w-md rounded-lg border border-danger bg-ink-900 p-6 text-sm">
              <p className="mb-2 font-semibold text-danger">连接被拒绝</p>
              <p className="text-ink-300">{fatal}</p>
              <p className="mt-3 text-xs text-gray-500">请核对 raincode web 输出的 token 后刷新页面。</p>
            </div>
          </div>
        ) : view === "settings" ? (
          <ProviderSettings />
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
