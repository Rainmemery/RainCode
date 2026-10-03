/** 审批弹窗：风险徽章 + 默认 ask reason + 参数预览 + 四级决策（03 §6.4 键盘 1-4/Esc）。 */
import { useEffect } from "react";
import { useWeb } from "../state.js";

export function ApprovalDialog(): JSX.Element {
  const approvals = useWeb((s) => s.approvals);
  const respondApproval = useWeb((s) => s.respondApproval);
  const pending = approvals[0];

  useEffect(() => {
    if (pending === undefined) return;
    const onKey = (e: KeyboardEvent): void => {
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
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/60">
      <div className="w-[480px] rounded-lg border border-ink-700 bg-ink-900 p-4">
        <div className="mb-2 flex items-center gap-2">
          <span
            className={`rounded px-2 py-0.5 text-xs ${
              risk === "high" ? "bg-danger/20 text-danger" : risk === "low" ? "bg-ok/20 text-ok" : "bg-warn/20 text-warn"
            }`}
          >
            {risk} risk
          </span>
          <span className="font-mono text-sm">{pending.toolName}</span>
        </div>
        <p className="mb-2 text-xs text-gray-400">{pending.reason}</p>
        <pre className="mb-4 max-h-40 overflow-auto rounded bg-ink-950 p-2 text-xs text-gray-300">
          {JSON.stringify(pending.normalizedInput, null, 2)}
        </pre>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <button className="rounded bg-accent-dim px-3 py-1.5 text-white" onClick={() => void respondApproval(pending.grantId, "allow", false)}>
            1 仅本次允许
          </button>
          <button className="rounded bg-ink-700 px-3 py-1.5" onClick={() => void respondApproval(pending.grantId, "allow", true, "session")}>
            2 本会话始终
          </button>
          <button className="rounded bg-ink-700 px-3 py-1.5" onClick={() => void respondApproval(pending.grantId, "allow", true, "project")}>
            3 项目始终
          </button>
          <button className="rounded bg-danger px-3 py-1.5 text-white" onClick={() => void respondApproval(pending.grantId, "deny", false)}>
            4 拒绝
          </button>
        </div>
      </div>
    </div>
  );
}
