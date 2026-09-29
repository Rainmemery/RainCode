/**
 * 底部输入区（03 §6.1 第 6 条）：bg-raised 圆角框聚焦转 accent-dim 边框；textarea 自适应
 * 3~8 行，Enter 发送（Shift+Enter 换行，IME 组合中不发送）；流式中发送钮变「停止」；
 * 下方弱化提示行显示当前模型或 Provider 引导。
 */
import { useEffect, useRef, useState } from "react";
import { useDesktop } from "../store.js";

const MAX_HEIGHT_PX = 168;

export default function InputArea() {
  const streaming = useDesktop((s) => s.streaming);
  const activeId = useDesktop((s) => s.activeId);
  const providers = useDesktop((s) => s.providers);
  const activeProviderId = useDesktop((s) => s.activeProviderId);
  const send = useDesktop((s) => s.send);
  const cancel = useDesktop((s) => s.cancel);
  const setView = useDesktop((s) => s.setView);
  const [text, setText] = useState("");
  const areaRef = useRef<HTMLTextAreaElement>(null);

  const provider = providers.find((p) => p.id === activeProviderId) ?? null;
  const canSend = activeId !== null && provider !== null && text.trim() !== "" && !streaming;

  useEffect(() => {
    const el = areaRef.current;
    if (el === null) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [text]);

  function handleSend(): void {
    if (activeId === null || provider === null || streaming) return;
    const trimmed = text.trim();
    if (trimmed === "") return;
    void send(trimmed);
    setText("");
  }

  return (
    <div className="px-6 pb-3 pt-2">
      <div className="flex items-end gap-2 rounded-lg border border-border-base bg-raised px-3 py-2 focus-within:border-accent-dim">
        <textarea
          ref={areaRef}
          rows={3}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              handleSend();
            }
          }}
          disabled={provider === null}
          placeholder={provider === null ? "先配置模型 Provider…" : "输入消息，Enter 发送，Shift+Enter 换行"}
          className="min-h-[60px] max-h-[168px] flex-1 resize-none bg-transparent text-hi outline-none placeholder:text-faint disabled:cursor-not-allowed disabled:opacity-50"
        />
        {streaming ? (
          <button
            type="button"
            onClick={() => void cancel()}
            className="h-8 shrink-0 rounded-md bg-accent px-3 text-2xs text-void hover:bg-accent-hover"
            title="停止生成"
          >
            <span className="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm bg-current align-middle" />
            停止
          </button>
        ) : (
          <button
            type="button"
            onClick={handleSend}
            disabled={!canSend}
            className="h-8 shrink-0 rounded-md bg-accent px-3 text-2xs text-void hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            发送
          </button>
        )}
      </div>
      <div className="px-1 pt-1 text-2xs">
        {provider !== null ? (
          <span className="text-faint">
            {provider.name} · {provider.model}
          </span>
        ) : (
          <button type="button" onClick={() => setView("settings")} className="text-warn hover:underline">
            先配置模型 Provider →
          </button>
        )}
      </div>
    </div>
  );
}
