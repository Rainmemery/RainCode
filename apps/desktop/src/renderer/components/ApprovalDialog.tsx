/**
 * 权限审批弹窗（03 §6.1 第 5 条）：固定遮罩 + 520px 对话框；风险徽章、工具名与完整参数、
 * reason、四级决策按钮；键盘 1-4 直选、Esc = 拒绝（仅挂载于 approvals 非空时）。
 */
import { useEffect, useRef } from "react";
import { useDesktop } from "../store.js";

interface RiskStyle {
  badge: string;
  label: string;
}

/** 风险徽章：1px 语义色描边 + 8% 透明底（03 §6.5 徽章规范）。 */
function riskStyle(riskLevel: string | undefined): RiskStyle {
  if (riskLevel === "high") {
    return { badge: "border-danger text-danger bg-[color-mix(in_srgb,var(--danger)_8%,transparent)]", label: "高风险" };
  }
  if (riskLevel === "low") {
    return { badge: "border-ok text-ok bg-[color-mix(in_srgb,var(--ok)_8%,transparent)]", label: "低风险" };
  }
  return { badge: "border-warn text-warn bg-[color-mix(in_srgb,var(--warn)_8%,transparent)]", label: "中风险" };
}

export default function ApprovalDialog() {
  const approval = useDesktop((s) => s.approvals[0]);
  const respondApproval = useDesktop((s) => s.respondApproval);
  // B4 缺陷修复：弹窗出现时主动接管焦点。此前审批弹出时消息输入框保持焦点，keydown 守卫
  // 「输入控件聚焦不响应」使快捷键 1-4/Esc 全部落入输入框（用户刚发完消息的常态场景必现）。
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const grantId = approval?.grantId;
  useEffect(() => {
    if (grantId !== undefined) dialogRef.current?.focus();
  }, [grantId]);

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      // 输入控件聚焦时不响应数字直选，避免误批
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      const current = useDesktop.getState().approvals[0];
      if (current === undefined) return;
      const respond = useDesktop.getState().respondApproval;
      if (event.key === "Escape") {
        void respond(current.grantId, "deny", false);
      } else if (event.key === "1") {
        void respond(current.grantId, "allow", false);
      } else if (event.key === "2") {
        void respond(current.grantId, "allow", false, "session");
      } else if (event.key === "3") {
        void respond(current.grantId, "allow", true, "global");
      } else if (event.key === "4") {
        void respond(current.grantId, "deny", false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (approval === undefined) return null;
  const risk = riskStyle(approval.metadata.riskLevel);
  const inputText =
    approval.normalizedInput === undefined || approval.normalizedInput === null
      ? "（无参数）"
      : JSON.stringify(approval.normalizedInput, null, 2);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div ref={dialogRef} tabIndex={-1} className="w-[520px] rounded-xl border border-border-strong bg-popover p-5 shadow-2xl outline-none">
        <div className="flex items-center gap-2">
          <span className={`shrink-0 rounded-sm border px-1.5 py-0.5 text-2xs ${risk.badge}`}>{risk.label}</span>
          <span className="mono min-w-0 truncate text-hi">{approval.toolName}</span>
        </div>
        {approval.reason !== "" && <div className="mt-2 truncate text-2xs text-low">{approval.reason}</div>}
        <pre className="mono mt-3 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-raised px-3 py-2 text-2xs leading-relaxed text-mid">
          {inputText}
        </pre>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={() => void respondApproval(approval.grantId, "allow", false)}
            className="h-8 flex-1 rounded-md bg-accent text-2xs text-void hover:bg-accent-hover"
          >
            仅本次允许
          </button>
          <button
            type="button"
            onClick={() => void respondApproval(approval.grantId, "allow", false, "session")}
            className="h-8 flex-1 rounded-md border border-border-strong text-2xs text-mid hover:bg-hover"
          >
            本会话允许
          </button>
          <button
            type="button"
            onClick={() => void respondApproval(approval.grantId, "allow", true, "global")}
            className="h-8 flex-1 rounded-md border border-border-strong text-2xs text-mid hover:bg-hover"
          >
            始终允许
          </button>
          <button
            type="button"
            onClick={() => void respondApproval(approval.grantId, "deny", false)}
            className="h-8 flex-1 rounded-md border border-border-faint text-2xs text-danger hover:border-danger hover:bg-hover"
          >
            拒绝
          </button>
        </div>
        <div className="mt-2 text-center text-2xs text-faint">快捷键 1-4 直选 · Esc 拒绝</div>
      </div>
    </div>
  );
}
