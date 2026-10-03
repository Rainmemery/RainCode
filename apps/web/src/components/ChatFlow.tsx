/** 会话流：当前会话 items 渲染 + 阶段横条（03 §6.3）。 */
import { useEffect, useRef } from "react";
import { useWeb } from "../state.js";

export function ChatFlow(): JSX.Element {
  const activeId = useWeb((s) => s.activeId);
  const view = useWeb((s) => (activeId !== null ? s.views[activeId] : undefined));
  const turnPhase = useWeb((s) => s.turnPhase);
  const streaming = useWeb((s) => s.streaming);
  const error = useWeb((s) => s.error);
  const dismissError = useWeb((s) => s.dismissError);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [view?.items.length, view?.items[view.items.length - 1]]);

  return (
    <div className="flex-1 overflow-y-auto p-4">
      {error !== null ? (
        <div className="mb-3 flex items-center justify-between rounded border border-danger bg-danger/10 px-3 py-2 text-sm text-danger">
          <span>{error}</span>
          <button className="text-xs underline" onClick={dismissError}>关闭</button>
        </div>
      ) : null}
      {view === undefined ? (
        <p className="mt-10 text-center text-sm text-gray-500">选择或新建一个会话</p>
      ) : (
        <>
          {view.items.map((item) =>
            item.kind === "message" ? (
              <div key={item.id} className={`mb-3 flex ${item.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-2xl whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
                    item.role === "user" ? "bg-accent-dim text-white" : "bg-ink-800"
                  }`}
                >
                  {item.text}
                  {item.streaming ? <span className="ml-1 animate-pulse">▊</span> : null}
                </div>
              </div>
            ) : (
              <div key={item.toolCallId} className="mb-3">
                <div className="rounded border border-ink-700 bg-ink-900 px-3 py-2 text-xs">
                  <span
                    className={
                      item.state === "ok"
                        ? "text-ok"
                        : item.state === "error" || item.state === "denied"
                          ? "text-danger"
                          : "text-accent"
                    }
                  >
                    ● {item.state}
                  </span>{" "}
                  <span className="font-mono">{item.toolName}</span>
                  {item.argsPreview !== undefined ? (
                    <span className="ml-2 text-gray-500">{item.argsPreview}</span>
                  ) : null}
                  {item.contentPreview !== undefined ? (
                    <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-gray-400">{item.contentPreview}</pre>
                  ) : null}
                  {item.errorText !== undefined ? <p className="mt-1 text-danger">{item.errorText}</p> : null}
                </div>
              </div>
            ),
          )}
          {streaming && turnPhase !== null ? (
            <div className="mt-2 text-xs text-gray-500">turn 进行中：{turnPhase}</div>
          ) : null}
          <div ref={bottomRef} />
        </>
      )}
    </div>
  );
}
