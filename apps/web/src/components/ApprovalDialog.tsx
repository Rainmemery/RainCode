/**
 * 审批弹窗（03 §6.1 第 5 条 / §6.4）：顶部琥珀色带（dsh 审批卡范式）+ 风险徽章 + mono 工具名
 * 与参数预览 + 四级决策；键盘 1-4/Esc。B8：风险徽章中文文案与桌面端同源。
 */
import { useEffect, useRef } from "react";
import { focusableWithin, nextFocusIndex } from "../focus-trap.js";
import { useWeb } from "../state.js";

/** 风险徽章中文文案（B8 缺陷修复：与桌面端同文案，此前直出英文 riskLevel）。 */
const RISK_LABEL: Record<string, string> = { high: "高风险", medium: "中风险", low: "低风险" };

const RISK_BADGE: Record<string, string> = {
  high: "border-danger text-danger bg-danger/10",
  medium: "border-warn text-warn bg-warn/10",
  low: "border-ok text-ok bg-ok/10",
};

export function ApprovalDialog(): JSX.Element {
  const approvals = useWeb((s) => s.approvals);
  const respondApproval = useWeb((s) => s.respondApproval);
  const pending = approvals[0];
  const dialogRef = useRef<HTMLDivElement | null>(null);
  /** 弹窗打开前的焦点元素（关闭时归还，§8.1）；null 表示尚未记录。 */
  const restoreRef = useRef<HTMLElement | null>(null);
  const open = pending !== undefined;
  const grantId = pending?.grantId ?? "";

  // 打开：记录触发元素并聚焦弹窗首个可交互元素；关闭：焦点归还触发元素（§8.1）
  useEffect(() => {
    if (!open) return;
    if (restoreRef.current === null) {
      restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    const root = dialogRef.current;
    if (root !== null) (focusableWithin(root)[0] ?? root).focus();
    return () => {
      const target = restoreRef.current;
      restoreRef.current = null;
      target?.focus();
    };
  }, [open, grantId]);

  useEffect(() => {
    if (pending === undefined) return;
    const onKey = (e: KeyboardEvent): void => {
      // Tab/Shift+Tab 在弹窗内循环，不逃逸到背景（§8.1）
      if (e.key === "Tab") {
        const root = dialogRef.current;
        if (root === null) return;
        const items = focusableWithin(root);
        if (items.length === 0) return;
        e.preventDefault();
        const current = items.indexOf(document.activeElement as HTMLElement);
        items[nextFocusIndex(current, items.length, e.shiftKey)]?.focus();
        return;
      }
      if (e.key === "1") void respondApproval(pending.grantId, "allow", false);
      else if (e.key === "2") void respondApproval(pending.grantId, "allow", true, "session");
      else if (e.key === "3") void respondApproval(pending.grantId, "allow", true, "project");
      else if (e.key === "4" || e.key === "Escape") void respondApproval(pending.grantId, "deny", false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [pending, respondApproval]);

  if (pending === undefined) return <></>;
  const risk = pending.metadata.riskLevel ?? "medium";

  return (
    <div className="overlay-mask anim-fade absolute inset-0 z-10 flex items-center justify-center">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="权限审批"
        tabIndex={-1}
        className="corner-ticks anim-rise w-[500px] overflow-hidden rounded-xl border border-border-strong bg-popover shadow-3 outline-none"
      >
        {/* 顶部色带：等待审批语义（warn） */}
        <div className="flex items-center gap-2 bg-warn/10 px-5 py-2.5">
          <span className="dot dot-warn" />
          <span className="text-2xs font-medium text-warn">等待你的确认 · 权限审批</span>
          <span
            className={`ml-auto shrink-0 rounded-sm border px-1.5 py-0.5 text-2xs ${RISK_BADGE[risk] ?? RISK_BADGE["medium"]}`}
          >
            {RISK_LABEL[risk] ?? `${risk} risk`}
          </span>
        </div>
        <div className="px-5 py-4">
          <div className="flex items-center gap-2">
            <span className="mono min-w-0 truncate text-sm text-hi">{pending.toolName}</span>
          </div>
          {pending.reason !== undefined && pending.reason !== "" && (
            <p className="mt-1.5 text-2xs text-low">{pending.reason}</p>
          )}
          <pre className="mono mt-3 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border-faint bg-raised px-3 py-2 text-2xs leading-relaxed text-mid">
            {JSON.stringify(pending.normalizedInput, null, 2)}
          </pre>
          <div className="mt-4 grid grid-cols-2 gap-2 text-sm">
            <button
              className="h-8 rounded-md bg-accent text-2xs text-on-accent transition-colors duration-fast hover:bg-accent-hover"
              onClick={() => void respondApproval(pending.grantId, "allow", false)}
            >
              1 仅本次允许
            </button>
            <button
              className="h-8 rounded-md border border-border-strong text-2xs text-mid transition-colors duration-fast hover:bg-hover"
              onClick={() => void respondApproval(pending.grantId, "allow", true, "session")}
            >
              2 本会话始终
            </button>
            <button
              className="h-8 rounded-md border border-border-strong text-2xs text-mid transition-colors duration-fast hover:bg-hover"
              onClick={() => void respondApproval(pending.grantId, "allow", true, "project")}
            >
              3 项目始终
            </button>
            <button
              className="h-8 rounded-md border border-danger/50 text-2xs text-danger transition-colors duration-fast hover:bg-hover hover:border-danger"
              onClick={() => void respondApproval(pending.grantId, "deny", false)}
            >
              4 拒绝
            </button>
          </div>
          <div className="mt-2.5 flex items-center justify-center gap-1 text-2xs text-faint">
            <span>快捷键</span>
            <span className="kbd">1</span>
            <span>–</span>
            <span className="kbd">4</span>
            <span>直选 ·</span>
            <span className="kbd">Esc</span>
            <span>拒绝</span>
          </div>
        </div>
      </div>
    </div>
  );
}
