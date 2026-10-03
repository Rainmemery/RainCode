/**
 * 记忆管理器（03-ui-design §6.3 / MR-4；T4.5 Web 端对齐桌面端，按端最小实现）：
 * 左：记忆源（MEMORY.md 卡片 + kind 分桶计数，点击即过滤）；
 * 中：MEMORY.md 预览（只读；文件真源 `.raincode/MEMORY.md`，Agent 专用章节经会话增量更新）；
 * 右：晋升草案待确认区（confirm 合入 / reject 忽略）+ 条目检索与列表（kind 过滤 / 置信度 /
 * 来源 / superseded 标记 / 直接管晋升）。
 * memory 域无事件推送：进入视图与每次处置后全量刷新（低频管理面，拉取成本可忽略）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { RpcCallError } from "@raincode/rpc/web";
import type { MemoryDraft, MemoryEntry, MemorySection } from "@raincode/shared";
import { rpcCall, useWeb } from "../state.js";

interface MemoryReadResult {
  content: string;
  exists: boolean;
}

interface EntriesListResult {
  items: MemoryEntry[];
  nextCursor?: string;
}

const KIND_LABELS: Record<MemoryEntry["kind"], string> = {
  decision: "架构决策",
  convention: "项目约定",
  pitfall: "踩坑记录",
  preference: "用户偏好",
  todo: "待办",
};

const KIND_BADGE: Record<MemoryEntry["kind"], string> = {
  decision: "border-accent text-accent",
  convention: "border-ok text-ok",
  pitfall: "border-warn text-warn",
  preference: "border-accent-dim text-accent-dim",
  todo: "border-ink-700 text-gray-400",
};

const SOURCE_LABELS: Record<MemoryEntry["source"], string> = {
  "session-end": "会话结束抽取",
  compact: "压缩抽取",
  manual: "手动",
  "memory-agent": "记忆 Agent",
};

const SECTIONS: MemorySection[] = ["项目概览", "技术栈与命令", "工作约定", "当前进行", "已知坑", "Agent 备忘"];

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

export function MemoryManager(): JSX.Element {
  const workspace = useWeb((s) => s.workspace);
  const setView = useWeb((s) => s.setView);

  const [memoryMd, setMemoryMd] = useState<MemoryReadResult | null>(null);
  const [drafts, setDrafts] = useState<MemoryDraft[]>([]);
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [kindFilter, setKindFilter] = useState<MemoryEntry["kind"] | null>(null);
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 直接管晋升的章节选择（entryId/draftId → 当前选中章节）。 */
  const [promoteSection, setPromoteSection] = useState<Record<string, MemorySection>>({});

  const refresh = useCallback(async (): Promise<void> => {
    if (workspace === null) return;
    try {
      const md = await rpcCall<MemoryReadResult>("memory.read", { workspaceRoot: workspace });
      const [draftRows, entryRows] = await Promise.all([
        rpcCall<{ drafts: MemoryDraft[] }>("memory.drafts.list", {}),
        rpcCall<EntriesListResult>("memory.entries.list", { page: { limit: 200 } }),
      ]);
      setMemoryMd(md);
      setDrafts(draftRows.drafts);
      setEntries(entryRows.items);
      setError(null);
    } catch (err) {
      setError(err instanceof RpcCallError ? `${err.code}: ${err.message}` : String(err));
    }
  }, [workspace]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const kindCounts = useMemo(() => {
    const counts = new Map<MemoryEntry["kind"], number>();
    for (const entry of entries) {
      counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
    }
    return counts;
  }, [entries]);

  const visibleEntries = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((entry) => {
      if (kindFilter !== null && entry.kind !== kindFilter) return false;
      if (q !== "" && !entry.content.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [entries, kindFilter, query]);

  async function handleResolve(draftId: string, action: "confirm" | "reject", section?: MemorySection): Promise<void> {
    setBusyId(draftId);
    try {
      await rpcCall("memory.drafts.resolve", { draftId, action, ...(section !== undefined && { section }) });
      await refresh();
    } catch (err) {
      setError(err instanceof RpcCallError ? `${err.code}: ${err.message}` : String(err));
    } finally {
      setBusyId(null);
    }
  }

  async function handlePromote(entryId: string): Promise<void> {
    setBusyId(entryId);
    try {
      await rpcCall("memory.promote", { entryId, section: promoteSection[entryId] ?? SECTIONS[0] });
      await refresh();
    } catch (err) {
      setError(err instanceof RpcCallError ? `${err.code}: ${err.message}` : String(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-10 shrink-0 items-center gap-3 border-b border-ink-700 bg-ink-900 px-4">
        <button type="button" onClick={() => setView("chat")} className="text-xs text-gray-400 hover:text-white" title="返回主工作区">
          ← 返回
        </button>
        <span className="text-xs font-semibold text-white">记忆管理器</span>
        <span className="min-w-0 flex-1 truncate text-xs text-gray-500">{workspace ?? "未设定工作区"}</span>
        <button type="button" onClick={() => void refresh()} className="text-xs text-gray-400 hover:text-white">
          刷新
        </button>
      </header>
      {workspace === null ? (
        <div className="flex flex-1 items-center justify-center text-xs text-gray-500">先在侧栏设定工作区目录</div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* 左栏：记忆源列表 */}
          <aside className="flex w-[200px] shrink-0 flex-col border-r border-ink-700 bg-ink-900">
            <button
              type="button"
              onClick={() => setKindFilter(null)}
              className={`border-b border-ink-700 px-4 py-3 text-left hover:bg-ink-800 ${kindFilter === null ? "bg-ink-800" : ""}`}
            >
              <div className="flex items-center gap-2">
                <span className={`inline-block h-2 w-2 rounded-full ${memoryMd?.exists ? "bg-ok" : "bg-gray-500"}`} />
                <span className="flex-1 text-xs text-white">MEMORY.md</span>
                <span className="text-xs text-gray-500">{memoryMd?.exists ? "已建" : "未建"}</span>
              </div>
              <div className="mt-1 truncate text-xs text-gray-500">.raincode/MEMORY.md（文件真源）</div>
            </button>
            <div className="px-2 py-2">
              <div className="px-2 pb-1 text-xs text-gray-500">记忆条目（{entries.length}）</div>
              {(Object.keys(KIND_LABELS) as Array<MemoryEntry["kind"]>).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => setKindFilter(kindFilter === kind ? null : kind)}
                  className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-ink-800 ${kindFilter === kind ? "bg-ink-800" : ""}`}
                >
                  <span className={`min-w-0 flex-1 truncate text-xs ${kindFilter === kind ? "text-white" : "text-gray-300"}`}>
                    {KIND_LABELS[kind]}
                  </span>
                  <span className="text-xs text-gray-500">{kindCounts.get(kind) ?? 0}</span>
                </button>
              ))}
            </div>
          </aside>

          {/* 中栏：MEMORY.md 预览（只读） */}
          <section className="flex min-w-0 flex-1 flex-col border-r border-ink-700">
            <div className="flex h-9 shrink-0 items-center border-b border-ink-700 px-3 text-xs text-gray-500">
              MEMORY.md 预览（只读；Agent 专用章节经会话增量更新）
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
              {memoryMd === null ? (
                <div className="text-xs text-gray-500">加载中…</div>
              ) : (
                <pre className="whitespace-pre-wrap break-words font-sans text-xs leading-5 text-gray-300">{memoryMd.content}</pre>
              )}
            </div>
          </section>

          {/* 右栏：待确认区 + 条目检索与列表 */}
          <section className="flex w-[400px] shrink-0 flex-col">
            {error !== null && <div className="border-b border-danger bg-ink-900 px-3 py-1.5 text-xs text-danger">{error}</div>}
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="border-b border-ink-700 px-3 py-2">
                <div className="pb-1 text-xs text-white">
                  待确认草案
                  <span className="ml-2 text-gray-500">{drafts.length === 0 ? "暂无" : `${drafts.length} 条`}</span>
                </div>
                {drafts.map((row) => (
                  <div key={row.id} className="mb-2 rounded border border-ink-700 bg-ink-900 px-2.5 py-2">
                    <div className="flex items-center gap-2">
                      <span className={`rounded border px-1 text-xs ${KIND_BADGE[row.entry.kind]}`}>{KIND_LABELS[row.entry.kind]}</span>
                      <span className="min-w-0 flex-1 truncate text-xs text-gray-300">{row.entry.content}</span>
                      <span className="text-xs text-gray-500">{Math.round(row.entry.confidence * 100)}%</span>
                    </div>
                    <div className="mt-1.5 flex items-center gap-1.5">
                      <span className="text-xs text-gray-500">合入</span>
                      <select
                        defaultValue={row.section}
                        onChange={(event) => setPromoteSection((prev) => ({ ...prev, [row.id]: event.target.value as MemorySection }))}
                        className="h-6 min-w-0 flex-1 rounded border border-ink-700 bg-ink-950 px-1 text-xs text-gray-300 outline-none"
                      >
                        {SECTIONS.map((section) => (
                          <option key={section} value={section}>{section}</option>
                        ))}
                      </select>
                      <button
                        type="button"
                        disabled={busyId === row.id}
                        onClick={() => void handleResolve(row.id, "confirm", promoteSection[row.id])}
                        className="h-6 rounded bg-accent-dim px-2 text-xs text-white disabled:opacity-50"
                      >
                        确认合入
                      </button>
                      <button
                        type="button"
                        disabled={busyId === row.id}
                        onClick={() => void handleResolve(row.id, "reject")}
                        className="h-6 rounded border border-ink-700 px-2 text-xs text-gray-300 hover:bg-ink-800 disabled:opacity-50"
                      >
                        忽略
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              <div className="px-3 py-2">
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="检索记忆条目…"
                  className="h-7 w-full rounded border border-ink-700 bg-ink-950 px-2 text-xs text-white outline-none placeholder:text-gray-500 focus:border-accent"
                />
              </div>
              <div className="px-3 pb-3">
                {visibleEntries.length === 0 && (
                  <div className="px-1 py-3 text-xs text-gray-500">
                    {entries.length === 0 ? "暂无记忆条目：会话结束 / 压缩时自动抽取" : "无匹配条目"}
                  </div>
                )}
                {visibleEntries.map((entry) => (
                  <div key={entry.id} className="mb-2 rounded border border-ink-700 bg-ink-950 px-2.5 py-2">
                    <div className="flex items-center gap-2">
                      <span className={`rounded border px-1 text-xs ${KIND_BADGE[entry.kind]}`}>{KIND_LABELS[entry.kind]}</span>
                      {entry.status === "superseded" && (
                        <span className="rounded border border-danger px-1 text-xs text-danger" title={`已被 ${entry.supersededBy ?? ""} 取代`}>
                          已被取代
                        </span>
                      )}
                      <span className="min-w-0 flex-1" />
                      <span className="text-xs text-gray-500" title="置信度">{Math.round(entry.confidence * 100)}%</span>
                    </div>
                    <div className={`mt-1 text-xs leading-4 ${entry.status === "superseded" ? "text-gray-500 line-through" : "text-gray-300"}`}>
                      {entry.content}
                    </div>
                    <div className="mt-1.5 flex items-center gap-2">
                      <span className="text-xs text-gray-500">{SOURCE_LABELS[entry.source]} · {relativeTime(entry.lastSeenAt)}</span>
                      <span className="min-w-0 flex-1" />
                      {entry.status === "active" && (
                        <>
                          <select
                            value={promoteSection[entry.id] ?? SECTIONS[0]}
                            onChange={(event) => setPromoteSection((prev) => ({ ...prev, [entry.id]: event.target.value as MemorySection }))}
                            className="h-6 rounded border border-ink-700 bg-ink-950 px-1 text-xs text-gray-300 outline-none"
                          >
                            {SECTIONS.map((section) => (
                              <option key={section} value={section}>{section}</option>
                            ))}
                          </select>
                          <button
                            type="button"
                            disabled={busyId === entry.id}
                            onClick={() => void handlePromote(entry.id)}
                            title="合入 MEMORY.md 指定章节（调用即用户确认动作）"
                            className="h-6 rounded border border-ink-700 px-2 text-xs text-gray-300 hover:bg-ink-800 disabled:opacity-50"
                          >
                            晋升
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
