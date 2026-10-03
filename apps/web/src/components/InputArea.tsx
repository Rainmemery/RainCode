/** 输入区：Enter 发送 / Shift+Enter 换行 / 停止按钮（03 §6.5）。 */
import { useState } from "react";
import { useWeb } from "../state.js";

export function InputArea(): JSX.Element {
  const send = useWeb((s) => s.send);
  const cancel = useWeb((s) => s.cancel);
  const streaming = useWeb((s) => s.streaming);
  const [draft, setDraft] = useState("");

  const submit = (): void => {
    const text = draft.trim();
    if (text.length === 0) return;
    setDraft("");
    void send(text);
  };

  return (
    <div className="border-t border-ink-700 p-3">
      <div className="flex gap-2">
        <textarea
          className="min-h-[44px] flex-1 resize-y rounded border border-ink-700 bg-ink-950 px-3 py-2 text-sm"
          placeholder="输入指令…（Enter 发送，Shift+Enter 换行）"
          value={draft}
          rows={2}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {streaming ? (
          <button className="rounded bg-danger px-3 py-1.5 text-sm text-white" onClick={() => void cancel()}>
            停止
          </button>
        ) : (
          <button className="rounded bg-accent-dim px-3 py-1.5 text-sm text-white" onClick={submit}>
            发送
          </button>
        )}
      </div>
    </div>
  );
}
