/**
 * 设置页「命令权限」组 · 「决策审计」子区（polish-ui-states-and-runtime Task 4.4；03 §6.2）：
 * `permission.decisions.list` 决策过滤（全部 / allow / deny）+ tool 名输入（300ms 防抖）+ 记录表
 * （相对时间 / 等宽 toolName / decision 徽章 / matchedBy / respondLatencyMs）+ 游标「加载更多」。
 * 只读（审批审计不可编辑）；首载 `.skeleton`；空态一行；行高 32px。
 */
import { useCallback, useEffect, useState } from "react";
import type { PermissionDecision, PermissionDecisionRecord } from "@raincode/shared";
import { rpcCall } from "../store.js";
import { SETTINGS_INPUT_CLASS, SettingsCard, rpcErrorText } from "./SettingsCard.js";

const PAGE_LIMIT = 20;

type DecisionFilter = "all" | Extract<PermissionDecision, "allow" | "deny">;

const FILTERS: Array<{ key: DecisionFilter; label: string }> = [
  { key: "all", label: "全部" },
  { key: "allow", label: "allow" },
  { key: "deny", label: "deny" },
];

const DECISION_BADGE: Record<PermissionDecision, { label: string; className: string }> = {
  allow: { label: "允许", className: "border-ok text-ok" },
  ask: { label: "询问", className: "border-warn text-warn" },
  deny: { label: "拒绝", className: "border-danger text-danger" },
};

const MATCHED_BY_LABEL: Record<PermissionDecisionRecord["matchedBy"], string> = {
  metadata: "元数据",
  mode: "模式",
  "session-rule": "会话规则",
  "project-rule": "项目规则",
  "global-rule": "全局规则",
  default: "默认",
};

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

interface DecisionsResult {
  items: PermissionDecisionRecord[];
  nextCursor?: string;
}

export default function SettingsAudit() {
  const [decision, setDecision] = useState<DecisionFilter>("all");
  const [toolInput, setToolInput] = useState("");
  const [toolName, setToolName] = useState("");
  const [items, setItems] = useState<PermissionDecisionRecord[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // tool 名输入 300ms 防抖（与侧栏会话检索同口径）
  useEffect(() => {
    const timer = setTimeout(() => setToolName(toolInput.trim()), 300);
    return () => clearTimeout(timer);
  }, [toolInput]);

  /** 拉取一页；cursor 缺省 = 首页（重置列表），否则追加。 */
  const load = useCallback(
    async (cursor?: string): Promise<void> => {
      setBusy(true);
      try {
        const params: Record<string, unknown> = {
          page: cursor === undefined ? { limit: PAGE_LIMIT } : { cursor, limit: PAGE_LIMIT },
        };
        if (decision !== "all") params["decision"] = decision;
        if (toolName !== "") params["toolName"] = toolName;
        const result = await rpcCall<DecisionsResult>("permission.decisions.list", params);
        setItems((prev) => (cursor === undefined ? result.items : [...(prev ?? []), ...result.items]));
        setNextCursor(result.nextCursor ?? null);
        setError(null);
      } catch (err) {
        setError(rpcErrorText(err));
        if (cursor === undefined) {
          setItems([]);
          setNextCursor(null);
        }
      } finally {
        setBusy(false);
      }
    },
    [decision, toolName],
  );

  // 过滤条件变化即回到首页并重置骨架
  useEffect(() => {
    setItems(null);
    setNextCursor(null);
    void load();
  }, [load]);

  return (
    <SettingsCard title="决策审计">
      <div className="mb-3 flex items-center gap-1">
        {FILTERS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            onClick={() => setDecision(entry.key)}
            className={`h-6 rounded-sm px-2 text-2xs transition-colors duration-fast ${
              decision === entry.key ? "bg-accent text-on-accent" : "text-mid hover:text-hi"
            }`}
          >
            {entry.label}
          </button>
        ))}
        <input
          value={toolInput}
          onChange={(event) => setToolInput(event.target.value)}
          placeholder="按工具名过滤（如 bash）"
          className={`${SETTINGS_INPUT_CLASS} ml-2 max-w-[220px]`}
        />
        <span className="ml-auto text-2xs text-faint">只读</span>
      </div>
      {error !== null && <div className="mb-2 text-2xs text-danger">{error}</div>}
      {items === null ? (
        <div className="flex flex-col gap-1.5">
          {[0, 1, 2].map((row) => (
            <div key={row} className="skeleton h-7 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="py-2 text-2xs text-faint">暂无决策记录（审批决策落 permission_decisions 审计表）</div>
      ) : (
        <>
          <div className="flex h-7 items-center gap-2 border-b border-border-faint px-1 text-2xs text-low">
            <span className="w-16 shrink-0">时间</span>
            <span className="min-w-0 flex-1">工具</span>
            <span className="w-12 shrink-0">决策</span>
            <span className="w-16 shrink-0">来源</span>
            <span className="w-14 shrink-0 text-right">耗时</span>
          </div>
          {items.map((record) => {
            const badge = DECISION_BADGE[record.decision];
            return (
              <div
                key={record.id}
                className="flex h-8 items-center gap-2 border-b border-border-faint px-1 last:border-b-0"
              >
                <span className="w-16 shrink-0 text-2xs text-faint" title={new Date(record.ts).toLocaleString()}>
                  {relativeTime(record.ts)}
                </span>
                <span className="mono min-w-0 flex-1 truncate text-2xs text-hi" title={record.toolName}>
                  {record.toolName}
                </span>
                <span className="w-12 shrink-0">
                  <span className={`rounded border px-1 text-2xs ${badge.className}`}>{badge.label}</span>
                </span>
                <span className="w-16 shrink-0 text-2xs text-mid">{MATCHED_BY_LABEL[record.matchedBy]}</span>
                <span className="w-14 shrink-0 text-right text-2xs text-faint">
                  {typeof record.respondLatencyMs === "number" ? `${String(record.respondLatencyMs)} ms` : "—"}
                </span>
              </div>
            );
          })}
          {nextCursor !== null && (
            <div className="mt-3 flex justify-center">
              <button
                type="button"
                disabled={busy}
                onClick={() => void load(nextCursor)}
                className="h-7 rounded-md border border-border-strong px-3 text-2xs text-mid transition-colors duration-fast hover:bg-hover disabled:opacity-50"
              >
                {busy ? "加载中…" : "加载更多"}
              </button>
            </div>
          )}
        </>
      )}
    </SettingsCard>
  );
}
