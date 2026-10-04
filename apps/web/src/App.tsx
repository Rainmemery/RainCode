/**
 * Web 会话工作台（T3.8 / UI-5；T4.5 管理面板对齐；refine-ui-context-panel 轮三栏装配）：
 * 侧栏（可折叠）+ 主区（chat/settings/memory/extensions 视图切换）+ 右侧上下文面板
 * （03 §6.1：仅 chat 视图常驻 300px，可折叠为右缘竖条；fatal 态不渲染右栏）。
 * 服务能力与桌面端同源（同一 AgentService 方法表，06 §6.3）；面板按端最小实现，
 * 复用协议与状态机语义（04 §2.3 policy）。
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
import { ContextPanel } from "./components/ContextPanel.js";

/** 折叠态右缘竖条（03 §6.0：折叠后以图标组唤起）：「«」展开按钮 + 三模块色点纯视觉提示。 */
function ContextRail(): JSX.Element {
  const toggleContextPanel = useWeb((s) => s.toggleContextPanel);
  return (
    <div className="flex w-8 shrink-0 flex-col items-center gap-3 border-l border-border-faint bg-panel py-3">
      <button
        type="button"
        className="rounded-sm px-1.5 py-0.5 text-2xs text-low transition-colors duration-fast hover:bg-hover hover:text-hi"
        onClick={toggleContextPanel}
        title="展开上下文面板"
      >
        «
      </button>
      {/* 三模块色点（记忆=ok / MCP=info / 子代理=violet），纯视觉提示，div 即可 */}
      <div className="h-1.5 w-1.5 rounded-full bg-ok" />
      <div className="h-1.5 w-1.5 rounded-full bg-info" />
      <div className="h-1.5 w-1.5 rounded-full bg-violet" />
    </div>
  );
}

export function App(): JSX.Element {
  const bootstrap = useWeb((s) => s.bootstrap);
  const view = useWeb((s) => s.view);
  const connection = useWeb((s) => s.connection);
  const fatal = useWeb((s) => s.fatal);
  const activeId = useWeb((s) => s.activeId);
  const contextPanelCollapsed = useWeb((s) => s.contextPanelCollapsed);

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
      {/* 右栏仅在非 fatal 且 chat 视图挂载；settings/memory/extensions 整页视图独占主区 */}
      {fatal === null && view === "chat" ? contextPanelCollapsed ? <ContextRail /> : <ContextPanel /> : null}
    </div>
  );
}
