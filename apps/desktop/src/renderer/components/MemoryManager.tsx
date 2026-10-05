/**
 * 记忆管理器（03-ui-design §6.3 稿件 03 / MR-4）：三栏——
 * 左：记忆源（MEMORY.md 卡片 + kind 分桶计数，点击即过滤）；
 * 中：MEMORY.md 预览（只读；文件真源 `.raincode/MEMORY.md`，编辑经 Agent 专用章节走会话）；
 * 右：晋升草案待确认区（02 §7.2 第三层，confirm 合入 / reject 忽略）+ 条目检索与列表
 * （kind chips / 置信度 / 来源 / lastSeen / superseded 标记 / 直接管晋升）。
 * memory 域无事件推送：进入视图与每次处置后全量刷新（低频管理面，拉取成本可忽略）。
 * polish-ui-states-and-runtime A5（§8.1）：条目列表 ↑↓ 移动高亮 / Enter 聚焦「晋升」动作
 * （无晋升按钮的行 no-op；无删除 RPC，故不提供 Delete）；高亮行滚动入视。
 * 同轮深化（spec C1~C3）：MEMORY.md 预览改 Markdown 渲染（复用 Markdown.tsx，仍只读）；
 * 检索非空走服务端 `memory.search`（不再本地 filter 旁路），命中片段以 `--accent-bg` 高亮；
 * 面板错误行接入统一 StatusBanner（A1）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { RpcCallError } from "@raincode/rpc/client";
import type { MemoryDraft, MemoryEntry, MemorySection } from "@raincode/shared";
import { splitHighlight } from "../highlight.js";
import { nextIndexFromKey } from "../list-nav.js";
import { rpcCall, useDesktop } from "../store.js";
import { Markdown } from "./Markdown.js";
import { StatusBanner } from "./StatusBanner.js";

interface MemoryReadResult {
  content: string;
  exists: boolean;
}

/** 服务端 drafts.list 投影为扁平形状：草案字段 + entry 本体随行（shared memoryDraftSchema）。 */
type DraftRow = MemoryDraft;

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
  decision: "border-violet text-violet",
  convention: "border-info text-info",
  pitfall: "border-warn text-warn",
  preference: "border-cyan text-cyan",
  todo: "border-mid text-mid",
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

export default function MemoryManager() {
  const workspace = useDesktop((s) => s.workspace);
  const setView = useDesktop((s) => s.setView);

  const [memoryMd, setMemoryMd] = useState<MemoryReadResult | null>(null);
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [kindFilter, setKindFilter] = useState<MemoryEntry["kind"] | null>(null);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<{ key: string; entries: MemoryEntry[] } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 直接管晋升的章节选择（entryId → 当前选中章节）。 */
  const [promoteSection, setPromoteSection] = useState<Record<string, MemorySection>>({});
  // 条目列表键盘导航（A5）：高亮索引
  const [navIndex, setNavIndex] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    if (workspace === null) return;
    try {
      const md = await rpcCall<MemoryReadResult>("memory.read", { workspaceRoot: workspace });
      const [draftRows, entryRows] = await Promise.all([
        rpcCall<{ drafts: DraftRow[] }>("memory.drafts.list", {}),
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

  /** 检索键：query 非空时走服务端 `memory.search`（02 §7.4 同源禁旁路），空查询回落 list 基线。 */
  const trimmedQuery = query.trim();
  const searchKey = trimmedQuery === "" ? "" : JSON.stringify([trimmedQuery, kindFilter]);
  const searching = searchKey !== "" && (search === null || search.key !== searchKey);

  useEffect(() => {
    if (searchKey === "") return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void rpcCall<{ entries: MemoryEntry[] }>("memory.search", {
        query: trimmedQuery,
        ...(kindFilter !== null && { kind: kindFilter }),
        limit: 50,
      })
        .then((result) => {
          if (cancelled) return;
          setSearch({ key: searchKey, entries: result.entries });
          setError(null);
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(err instanceof RpcCallError ? `${err.code}: ${err.message}` : String(err));
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [searchKey, trimmedQuery, kindFilter]);

  const kindCounts = useMemo(() => {
    const counts = new Map<MemoryEntry["kind"], number>();
    for (const entry of entries) {
      counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
    }
    return counts;
  }, [entries]);

  const visibleEntries = useMemo(() => {
    if (searchKey !== "") {
      return search !== null && search.key === searchKey ? search.entries : [];
    }
    // 空查询基线（既口径不变）：memory.entries.list 投影 + 端层 kind 过滤
    return kindFilter === null ? entries : entries.filter((entry) => entry.kind === kindFilter);
  }, [entries, kindFilter, search, searchKey]);

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

  /** 键盘导航：高亮行滚动入视（block:nearest，最小滚动）。 */
  function scrollEntryIntoView(index: number): void {
    listRef.current?.querySelectorAll<HTMLElement>("[data-nav-row]")[index]?.scrollIntoView({ block: "nearest" });
  }

  /** 条目列表键盘：↑↓/Home/End 移动高亮；Enter 触发该行「晋升」动作（无按钮行 no-op）。 */
  function handleListKey(event: KeyboardEvent<HTMLElement>): void {
    const target = event.target;
    // 检索框 / 章节下拉聚焦时不劫持按键
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;
    const next = nextIndexFromKey(event.key, navIndex ?? -1, visibleEntries.length);
    if (next !== null) {
      event.preventDefault();
      setNavIndex(next);
      scrollEntryIntoView(next);
      return;
    }
    if (event.key === "Enter" && navIndex !== null) {
      const row = listRef.current?.querySelectorAll<HTMLElement>("[data-nav-row]")[navIndex];
      if (row === undefined || row === null) return;
      const primary = row.querySelector<HTMLButtonElement>("[data-nav-primary]");
      if (primary === null) return; // 已被取代 / 非活跃行无晋升动作
      event.preventDefault();
      primary.click();
    }
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-10 shrink-0 items-center gap-3 border-b border-border-base bg-panel px-4">
        <button type="button" onClick={() => setView("chat")} className="text-2xs text-mid hover:text-hi" title="返回主工作区">
          ← 返回
        </button>
        <span className="text-2xs text-hi">记忆管理器</span>
        <span className="min-w-0 flex-1 truncate text-2xs text-faint">{workspace ?? "未选择工作区"}</span>
        <button type="button" onClick={() => void refresh()} className="text-2xs text-mid hover:text-hi">
          刷新
        </button>
      </header>
      {workspace === null ? (
        <div className="flex flex-1 items-center justify-center text-2xs text-faint">选择工作区后可用</div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* 左栏：记忆源列表 */}
          <aside className="flex w-[200px] shrink-0 flex-col border-r border-border-base bg-panel">
            <button
              type="button"
              onClick={() => setKindFilter(null)}
              className={`border-b border-border-faint px-4 py-3 text-left hover:bg-hover ${kindFilter === null ? "bg-selected" : ""}`}
            >
              <div className="flex items-center gap-2">
                <span className="dot dot-ok" />
                <span className="flex-1 text-2xs text-hi">MEMORY.md</span>
                <span className="text-2xs text-faint">{memoryMd?.exists ? "已建" : "未建"}</span>
              </div>
              <div className="mt-1 truncate text-2xs text-faint">.raincode/MEMORY.md（文件真源）</div>
            </button>
            <div className="px-2 py-2">
              <div className="px-2 pb-1 text-2xs text-faint">记忆条目（{entries.length}）</div>
              {(Object.keys(KIND_LABELS) as Array<MemoryEntry["kind"]>).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => setKindFilter(kindFilter === kind ? null : kind)}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-hover ${kindFilter === kind ? "bg-selected" : ""}`}
                >
                  <span className={`min-w-0 flex-1 truncate text-2xs ${kindFilter === kind ? "text-hi" : "text-mid"}`}>
                    {KIND_LABELS[kind]}
                  </span>
                  <span className="text-2xs text-faint">{kindCounts.get(kind) ?? 0}</span>
                </button>
              ))}
            </div>
          </aside>

          {/* 中栏：MEMORY.md 预览（只读） */}
          <section className="flex min-w-0 flex-1 flex-col border-r border-border-base">
            <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border-faint px-3 text-2xs text-faint">
              <span className="min-w-0 flex-1 truncate">MEMORY.md 预览（只读；Agent 专用章节经会话增量更新）</span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
              {memoryMd === null ? (
                <div className="flex flex-col gap-2" role="status" aria-label="加载中">
                  <div className="skeleton h-3 w-full" aria-hidden="true" />
                  <div className="skeleton h-3 w-11/12" aria-hidden="true" />
                  <div className="skeleton h-3 w-full" aria-hidden="true" />
                  <div className="skeleton h-3 w-3/4" aria-hidden="true" />
                </div>
              ) : (
                <div className="text-2xs leading-5 text-mid">
                  {!memoryMd.exists && (
                    <div className="mb-2 text-2xs text-faint">MEMORY.md 尚未建立，以下为待写入的模板骨架（只读）。</div>
                  )}
                  <Markdown text={memoryMd.content} />
                </div>
              )}
            </div>
          </section>

          {/* 右栏：待确认区 + 条目检索与列表 */}
          <section className="flex w-[420px] shrink-0 flex-col">
            {error !== null && (
              <div className="border-b border-border-faint p-2">
                <StatusBanner tone="danger" text={error} onDismiss={() => setError(null)} />
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto">
              {/* 晋升草案待确认区（02 §7.2 第三层） */}
              <div className="border-b border-border-faint px-3 py-2">
                <div className="pb-1 text-2xs text-hi">
                  待确认草案
                  <span className="ml-2 text-faint">{drafts.length === 0 ? "暂无" : `${drafts.length} 条`}</span>
                </div>
                {drafts.map((row) => (
                  <div key={row.id} className="mb-2 rounded-md border border-border-base bg-raised px-2.5 py-2">
                    <div className="flex items-center gap-2">
                      <span className={`rounded border px-1 text-2xs ${KIND_BADGE[row.entry.kind]}`}>{KIND_LABELS[row.entry.kind]}</span>
                      <span className="min-w-0 flex-1 truncate text-2xs text-mid">{row.entry.content}</span>
                      <span className="text-2xs text-faint">{Math.round(row.entry.confidence * 100)}%</span>
                    </div>
                    <div className="mt-1.5 flex items-center gap-1.5">
                      <span className="text-2xs text-faint">合入</span>
                      <select
                        defaultValue={row.section}
                        onChange={(event) => setPromoteSection((prev) => ({ ...prev, [row.id]: event.target.value as MemorySection }))}
                        className="h-6 min-w-0 flex-1 rounded border border-border-base bg-raised px-1 text-2xs text-mid outline-none"
                      >
                        {SECTIONS.map((section) => (
                          <option key={section} value={section}>{section}</option>
                        ))}
                      </select>
                      <button
                        type="button"
                        disabled={busyId === row.id}
                        onClick={() => void handleResolve(row.id, "confirm", promoteSection[row.id])}
                        className="h-6 rounded bg-accent px-2 text-2xs text-on-accent hover:bg-accent-hover disabled:opacity-50"
                      >
                        确认合入
                      </button>
                      <button
                        type="button"
                        disabled={busyId === row.id}
                        onClick={() => void handleResolve(row.id, "reject")}
                        className="h-6 rounded border border-border-strong px-2 text-2xs text-mid hover:bg-hover disabled:opacity-50"
                      >
                        忽略
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              {/* 条目检索 + 列表 */}
              <div className="px-3 py-2">
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="检索记忆条目…"
                  className="h-7 w-full rounded-md border border-border-base bg-raised px-2 text-2xs text-hi outline-none placeholder:text-faint focus:border-accent-dim"
                />
              </div>
              <div
                ref={listRef}
                tabIndex={0}
                onKeyDown={handleListKey}
                aria-label="记忆条目列表"
                className="px-3 pb-3"
              >
                {visibleEntries.length === 0 && (
                  <div className="px-1 py-3 text-2xs text-faint">
                    {searching
                      ? "检索中…"
                      : searchKey !== ""
                        ? "无匹配条目"
                        : entries.length === 0
                          ? "暂无记忆条目：会话结束 / 压缩时自动抽取"
                          : "无匹配条目"}
                  </div>
                )}
                {visibleEntries.map((entry, index) => (
                  <div
                    key={entry.id}
                    data-nav-row
                    className={`mb-2 rounded-md border border-border-base px-2.5 py-2 ${
                      navIndex === index ? "bg-selected" : "bg-panel"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className={`rounded border px-1 text-2xs ${KIND_BADGE[entry.kind]}`}>{KIND_LABELS[entry.kind]}</span>
                      {entry.status === "superseded" && (
                        <span className="rounded border border-danger px-1 text-2xs text-danger" title={`已被 ${entry.supersededBy ?? ""} 取代`}>
                          已被取代
                        </span>
                      )}
                      <span className="min-w-0 flex-1" />
                      <span className="text-2xs text-faint" title="置信度">{Math.round(entry.confidence * 100)}%</span>
                    </div>
                    <div className={`mt-1 text-2xs leading-4 ${entry.status === "superseded" ? "text-faint line-through" : "text-mid"}`}>
                      {splitHighlight(entry.content, query).map((segment, segmentIndex) =>
                        segment.hit ? (
                          <mark key={segmentIndex} className="rounded-sm bg-accent-bg px-0.5 text-inherit">
                            {segment.text}
                          </mark>
                        ) : (
                          <span key={segmentIndex}>{segment.text}</span>
                        ),
                      )}
                    </div>
                    <div className="mt-1.5 flex items-center gap-2">
                      <span className="text-2xs text-faint">{SOURCE_LABELS[entry.source]} · {relativeTime(entry.lastSeenAt)}</span>
                      <span className="min-w-0 flex-1" />
                      {entry.status === "active" && (
                        <>
                          <select
                            value={promoteSection[entry.id] ?? SECTIONS[0]}
                            onChange={(event) => setPromoteSection((prev) => ({ ...prev, [entry.id]: event.target.value as MemorySection }))}
                            className="h-6 rounded border border-border-base bg-raised px-1 text-2xs text-mid outline-none"
                          >
                            {SECTIONS.map((section) => (
                              <option key={section} value={section}>{section}</option>
                            ))}
                          </select>
                          <button
                            type="button"
                            data-nav-primary
                            disabled={busyId === entry.id}
                            onClick={() => void handlePromote(entry.id)}
                            title="合入 MEMORY.md 指定章节（调用即用户确认动作）"
                            className="h-6 rounded border border-border-strong px-2 text-2xs text-mid hover:bg-hover disabled:opacity-50"
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
