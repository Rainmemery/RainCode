/**
 * 设置页 · 命令权限组「决策审计」子区（polish-ui-states-and-runtime 轮 B3；03 §6.2；双端同构）：
 * `permission.decisions.list` 只读投影——decision（全部 / allow / deny）+ toolName 过滤 + 记录表
 * （相对时间 / 等宽 toolName / decision 徽章 / matchedBy / respondLatencyMs）+ 游标「加载更多」。
 * 行高 32px（§6.5 密度）；toolName 输入 300ms 防抖，避免逐键拉起 RPC。只读，无任何写入口。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { RpcCallError } from "@raincode/rpc/web";
import type { PermissionDecision, PermissionDecisionRecord, PermissionDecisionsListResult } from "@raincode/shared";
import { rpcCall } from "../state.js";
import { relativeTime } from "./SessionRow.js";

const PAGE_SIZE = 50;

type DecisionFilter = "all" | Extract<PermissionDecision, "allow" | "deny">;

const DECISION_FILTERS: Array<{ key: DecisionFilter; label: string }> = [
  { key: "all", label: "全部" },
  { key: "allow", label: "allow" },
  { key: "deny", label: "deny" },
];

/** decision 徽章（allow=ok / ask=warn / deny=danger；ask 记录经「全部」可见）。 */
const DECISION_BADGE: Record<PermissionDecision, string> = {
  allow: "border-ok/40 bg-ok/10 text-ok",
  ask: "border-warn/40 bg-warn/10 text-warn",
  deny: "border-danger/40 bg-danger/10 text-danger",
};

const INPUT_CLASS =
  "h-7 rounded-md border border-border-base bg-raised px-2 text-2xs text-hi outline-none placeholder:text-faint transition-colors duration-fast focus:border-accent-dim";

const ROW_BUTTON_CLASS =
  "h-6 rounded-md border border-border-strong px-2 text-2xs text-mid transition-colors duration-fast hover:bg-hover disabled:opacity-50";

function errText(err: unknown): string {
  return err instanceof RpcCallError ? `${err.code}: ${err.message}` : String(err);
}

export function SettingsAudit(): JSX.Element {
  const [records, setRecords] = useState<PermissionDecisionRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [decision, setDecision] = useState<DecisionFilter>("all");
  const [toolInput, setToolInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  /** 请求序号：丢弃过期响应（防抖窗口内的竞态）。 */
  const reqRef = useRef(0);

  const loadFirstPage = useCallback(async (): Promise<void> => {
    const id = ++reqRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await rpcCall<PermissionDecisionsListResult>("permission.decisions.list", {
        ...(decision !== "all" && { decision }),
        ...(toolInput.trim().length > 0 && { toolName: toolInput.trim() }),
        page: { limit: PAGE_SIZE },
      });
      if (reqRef.current !== id) return;
      setUnavailable(false);
      setRecords(result.items);
      setNextCursor(result.nextCursor);
    } catch (err) {
      if (reqRef.current !== id) return;
      const missing = err instanceof RpcCallError && err.code === "METHOD_NOT_FOUND";
      setUnavailable(missing);
      setError(missing ? null : errText(err));
      setRecords([]);
      setNextCursor(undefined);
    } finally {
      if (reqRef.current === id) setLoading(false);
    }
  }, [decision, toolInput]);

  // 过滤变更（decision 即时 / toolName 防抖）→ 重拉首页
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadFirstPage();
    }, 300);
    return () => {
      window.clearTimeout(timer);
    };
  }, [loadFirstPage]);

  async function loadMore(): Promise<void> {
    if (nextCursor === undefined || loadingMore) return;
    setLoadingMore(true);
    try {
      const result = await rpcCall<PermissionDecisionsListResult>("permission.decisions.list", {
        ...(decision !== "all" && { decision }),
        ...(toolInput.trim().length > 0 && { toolName: toolInput.trim() }),
        page: { limit: PAGE_SIZE, cursor: nextCursor },
      });
      setRecords((prev) => [...prev, ...result.items]);
      setNextCursor(result.nextCursor);
    } catch (err) {
      setError(errText(err));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <section>
      <h3 className="pb-2 text-xs text-mid">决策审计</h3>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex w-fit gap-1 rounded-md border border-border-faint bg-card p-1">
          {DECISION_FILTERS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`h-7 rounded-sm px-3 text-2xs transition-colors duration-fast ${
                item.key === decision ? "bg-accent text-on-accent" : "text-mid hover:bg-hover hover:text-hi"
              }`}
              onClick={() => setDecision(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <input
          className={`${INPUT_CLASS} w-48`}
          placeholder="toolName 过滤（如 bash）"
          value={toolInput}
          onChange={(e) => setToolInput(e.target.value)}
        />
      </div>
      <p className="mt-2 text-2xs text-faint">只读审计：permission_decisions 决策投影，时间倒序。</p>
      {error !== null && <div className="mt-2 text-2xs text-danger">{error}</div>}
      {unavailable ? (
        <div className="mt-2 rounded-md border border-border-faint bg-card px-3 py-2 text-2xs text-faint">
          权限域未装配（当前宿主未启用）
        </div>
      ) : loading ? (
        <div className="mt-2 flex flex-col gap-1.5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton h-8 rounded-md" />
          ))}
        </div>
      ) : records.length === 0 ? (
        <div className="mt-2 rounded-md border border-border-faint bg-card px-3 py-2 text-2xs text-faint">暂无决策记录</div>
      ) : (
        <>
          <div className="mt-2 overflow-hidden rounded-md border border-border-faint bg-card">
            <table className="w-full border-collapse text-left text-2xs">
              <thead>
                <tr className="h-8 border-b border-border-faint text-faint">
                  <th className="px-3 font-normal">时间</th>
                  <th className="px-3 font-normal">工具</th>
                  <th className="px-3 font-normal">决策</th>
                  <th className="px-3 font-normal">命中来源</th>
                  <th className="px-3 text-right font-normal">响应延迟</th>
                </tr>
              </thead>
              <tbody>
                {records.map((record) => (
                  <tr key={record.id} className="h-8 border-b border-border-faint last:border-b-0">
                    <td className="whitespace-nowrap px-3 text-faint" title={new Date(record.ts).toLocaleString()}>
                      {relativeTime(record.ts)}
                    </td>
                    <td className="mono max-w-[160px] truncate px-3 text-hi" title={record.toolName}>
                      {record.toolName}
                    </td>
                    <td className="px-3">
                      <span className={`rounded-sm border px-1.5 py-0.5 ${DECISION_BADGE[record.decision]}`}>
                        {record.decision}
                      </span>
                    </td>
                    <td className="mono px-3 text-low">{record.matchedBy}</td>
                    <td className="whitespace-nowrap px-3 text-right text-faint">
                      {record.respondLatencyMs !== undefined && record.respondLatencyMs !== null
                        ? `${String(record.respondLatencyMs)} ms`
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {nextCursor !== undefined && (
            <div className="mt-2">
              <button type="button" className={ROW_BUTTON_CLASS} disabled={loadingMore} onClick={() => void loadMore()}>
                {loadingMore ? "加载中…" : "加载更多"}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
