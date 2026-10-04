/**
 * 输入区（03 §6.5 Web 适配；T4.5 斜杠命令面板对齐桌面端 UI-4）：Enter 发送 / Shift+Enter 换行 /
 * IME 组合中不发送 / 流式中发送钮变「停止」；输入以「/」开头时浮出技能面板（skills.list，
 * workspace+global 双层），↑↓ 选择 / Tab 补全 / Enter 执行 / Esc 关闭；发送路径解析
 * /name args → skills.invoke（展开在 server 侧，06 §2.9，与 CLI/桌面端同语义）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { SkillSummary } from "@raincode/shared";
import { parseSlashInvocation } from "../session-view.js";
import { rpcCall, useWeb } from "../state.js";

const MAX_HEIGHT_PX = 168;

export function InputArea(): JSX.Element {
  const send = useWeb((s) => s.send);
  const cancel = useWeb((s) => s.cancel);
  const invokeSkill = useWeb((s) => s.invokeSkill);
  const streaming = useWeb((s) => s.streaming);
  const activeId = useWeb((s) => s.activeId);
  const [draft, setDraft] = useState("");
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [paletteDismissed, setPaletteDismissed] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  const slashMode = draft.startsWith("/");
  const query = slashMode ? draft.slice(1).replace(/\s+[\s\S]*$/, "") : "";
  const paletteOpen = slashMode && !paletteDismissed && activeId !== null;
  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return skills.filter((skill) => q === "" || skill.name.startsWith(q));
  }, [skills, query]);

  useEffect(() => {
    const el = areaRef.current;
    if (el === null) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [draft]);

  // 面板打开时拉取技能清单（含当前会话 workspace 层，06 §2.9；低频拉取成本可忽略）
  useEffect(() => {
    if (!paletteOpen || activeId === null) return;
    let cancelled = false;
    void rpcCall<{ items: SkillSummary[] }>("skills.list", { sessionId: activeId })
      .then((result) => {
        if (!cancelled) setSkills(result.items);
      })
      .catch(() => undefined); // 清单拉取失败不阻塞输入；发送路径由服务端权威判定
    return () => {
      cancelled = true;
    };
  }, [paletteOpen, activeId]);

  useEffect(() => {
    setHighlight(0);
  }, [query, skills.length]);

  function completeWith(skill: SkillSummary): void {
    setDraft(`/${skill.name} `);
    areaRef.current?.focus();
  }

  function submit(): void {
    const text = draft.trim();
    if (text.length === 0 || streaming) return;
    if (text.startsWith("/")) {
      const invocation = parseSlashInvocation(text);
      if (invocation === null) {
        useWeb.setState({ error: "无效的斜杠命令（名字域 [a-z0-9-]，输入 / 查看可用技能）" });
        return;
      }
      void invokeSkill(invocation.name, invocation.args);
    } else {
      void send(text);
    }
    setDraft("");
    setPaletteDismissed(false);
  }

  return (
    <div className="border-t border-border-base bg-panel px-4 pb-3 pt-2.5">
      <div className="relative">
        {paletteOpen && filtered.length > 0 && (
          <div className="anim-rise absolute bottom-full left-0 right-0 mb-1.5 overflow-hidden rounded-lg border border-border-base bg-popover shadow-2">
            {filtered.slice(0, 8).map((skill, index) => (
              <button
                key={skill.name}
                type="button"
                onClick={() => completeWith(skill)}
                onMouseEnter={() => setHighlight(index)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors duration-fast ${
                  index === highlight ? "bg-selected" : ""
                }`}
              >
                <span className="mono shrink-0 text-2xs text-accent">/{skill.name}</span>
                {skill.argumentHint !== undefined && <span className="mono shrink-0 text-2xs text-faint">{skill.argumentHint}</span>}
                <span className="shrink-0 rounded-sm border border-border-strong px-1 text-2xs text-low">{skill.source}</span>
                <span className="min-w-0 flex-1 truncate text-2xs text-mid">{skill.description}</span>
              </button>
            ))}
            <div className="flex items-center gap-1 border-t border-border-faint px-3 py-1 text-2xs text-faint">
              <span className="kbd">↑</span>
              <span className="kbd">↓</span>
              <span>选择 ·</span>
              <span className="kbd">Tab</span>
              <span>补全 ·</span>
              <span className="kbd">Enter</span>
              <span>执行 ·</span>
              <span className="kbd">Esc</span>
              <span>关闭</span>
            </div>
          </div>
        )}
        <div className="flex items-end gap-2 rounded-lg border border-border-base bg-raised px-3 py-2 transition-colors duration-fast focus-within:border-accent-dim">
          <textarea
            ref={areaRef}
            className="max-h-[168px] min-h-[44px] flex-1 resize-none bg-transparent text-sm text-hi outline-none placeholder:text-faint"
            placeholder="输入指令，/ 唤起技能命令（Enter 发送，Shift+Enter 换行）"
            value={draft}
            rows={2}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              const enterPressed = e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing;
              if (paletteOpen && filtered.length > 0) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setHighlight((prev) => (prev + 1) % Math.min(filtered.length, 8));
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setHighlight((prev) => (prev - 1 + Math.min(filtered.length, 8)) % Math.min(filtered.length, 8));
                  return;
                }
                if (e.key === "Tab") {
                  e.preventDefault();
                  completeWith(filtered[highlight]!);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setPaletteDismissed(true);
                  return;
                }
                if (enterPressed && !/\s/.test(draft.slice(1))) {
                  // 命令名未敲完（无参）：Enter 补全；已在输参（含尾随空格）则落到正常发送
                  e.preventDefault();
                  completeWith(filtered[highlight]!);
                  return;
                }
              }
              if (enterPressed) {
                e.preventDefault();
                submit();
              }
            }}
          />
          {streaming ? (
            <button
              className="h-8 shrink-0 rounded-md bg-danger px-3 text-2xs text-on-accent transition-colors duration-fast hover:opacity-90"
              onClick={() => void cancel()}
              title="停止生成"
            >
              <span className="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm bg-current align-middle" />
              停止
            </button>
          ) : (
            <button
              className="h-8 shrink-0 rounded-md bg-accent px-3 text-2xs text-on-accent transition-colors duration-fast hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
              onClick={submit}
              disabled={activeId === null || draft.trim() === "" || streaming}
            >
              发送
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
