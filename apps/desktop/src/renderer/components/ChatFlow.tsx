/**
 * 中部会话流（03 §6.1）：ChatItem → 消息气泡、ToolItem → 工具卡；流式尾部光标、
 * 空态引导（03 §6.5 页面级空态）、审批中琥珀横条、自动滚动，底部输入区。
 * 子代理进度卡（refine-ui-context-panel 轮 §6.1 第 4 条）：violet 标识卡片挂在 items 流之后，
 * 按 spawned 事件归属的活跃会话过滤（subagent.* 不带 sessionId）。
 */
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useDesktop } from "../store.js";
import MessageBubble from "./MessageBubble.js";
import ToolCard from "./ToolCard.js";
import InputArea from "./InputArea.js";
import type { HookItem } from "../session-view.js";
import type { SubagentRecord } from "../subagent-view.js";

const HOOK_OUTCOME_LABEL: Record<HookItem["outcome"], string> = {
  running: "执行中",
  success: "完成",
  blocked: "已拦截",
  failed: "失败（不阻塞）",
  timed_out: "超时（不阻塞）",
  skipped_untrusted: "未授信跳过",
};

const ASCII_BOX_WIDTH = 29;
const EMPTY_ASCII = [
  "┌" + "─".repeat(ASCII_BOX_WIDTH) + "┐",
  "│" + " ".repeat(ASCII_BOX_WIDTH) + "│",
  "│" + "      RAINCODE  DESKTOP      " + "│",
  "│" + "      › _" + " ".repeat(ASCII_BOX_WIDTH - 9) + "│",
  "│" + " ".repeat(ASCII_BOX_WIDTH) + "│",
  "└" + "─".repeat(ASCII_BOX_WIDTH) + "┘",
].join("\n");

function EmptyState() {
  const createSession = useDesktop((s) => s.createSession);
  return (
    <div className="anim-fade flex h-full flex-col items-center justify-center gap-5 px-6">
      <pre className="mono whitespace-pre text-2xs leading-relaxed text-faint">{EMPTY_ASCII}</pre>
      <div className="text-mid">这里还没有内容，从一次对话开始</div>
      <button
        type="button"
        onClick={() => void createSession()}
        className="h-8 rounded-md bg-accent px-4 text-2xs text-on-accent transition-colors duration-fast hover:bg-accent-hover"
      >
        新建第一个会话
      </button>
    </div>
  );
}

function PendingBanner() {
  return (
    <div className="flex items-center gap-2 border-b border-warn bg-warn/10 px-6 py-1.5 text-2xs text-warn">
      <span className="dot dot-warn" />
      等待你的确认
    </div>
  );
}

/** hook 执行行（T5.1）：单行紧凑投影，拦截/失败态用警示色强调。 */
function HookRow({ item }: { item: HookItem }) {
  const emphasized = item.outcome === "blocked" || item.outcome === "failed" || item.outcome === "timed_out";
  return (
    <div
      className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-2xs ${
        emphasized ? "border-warn text-warn" : "border-line text-mid"
      }`}
    >
      <span className={item.outcome === "running" ? "dot dot-run" : emphasized ? "dot dot-warn" : "dot dot-ok"} />
      <span className="mono">hooks</span>
      <span>{item.phase}</span>
      <span>{HOOK_OUTCOME_LABEL[item.outcome]}</span>
      <span className="text-faint">×{String(item.hookCount)}</span>
      {item.durationMs !== undefined && <span className="text-faint">{String(item.durationMs)}ms</span>}
      {item.reason !== undefined && <span className="truncate text-faint">— {item.reason}</span>}
    </div>
  );
}

/** 子代理状态灯（与右栏子代理 Tab 同映射：Pending/Stopped 灰、Running 青脉冲、Completed 绿、Failed 红）。 */
function subagentDotClass(status: SubagentRecord["status"]): string {
  switch (status) {
    case "Running":
      return "dot dot-run";
    case "Completed":
      return "dot dot-ok";
    case "Failed":
      return "dot dot-err";
    default:
      return "dot dot-idle";
  }
}

/**
 * 子代理进度卡（refine-ui-context-panel 轮 §6.1 第 4 条）：violet 标识；存在 Pending/Running
 * 全展开（每行：状态灯 + profile 名 + 当前动作摘要）；全部终态默认折叠单行「N 个子代理已完成」，
 * 点击可再展开（本地 useState）。
 */
const SubagentCard = memo(function SubagentCard({ records }: { records: SubagentRecord[] }) {
  const [expanded, setExpanded] = useState(false);
  const hasActive = records.some((record) => record.status === "Pending" || record.status === "Running");
  const showRows = hasActive || expanded;
  return (
    <div className="rounded-md border border-violet/40 bg-violet/5 px-3 py-2">
      <button
        type="button"
        onClick={() => {
          if (!hasActive) setExpanded(!expanded);
        }}
        className="flex w-full items-center gap-2 text-left"
        title={hasActive ? undefined : expanded ? "收起子代理明细" : "展开子代理明细"}
      >
        <span className="mono shrink-0 text-2xs text-violet">◈ 子代理</span>
        <span className="text-2xs text-faint">
          {hasActive ? `×${String(records.length)}` : `${String(records.length)} 个子代理已完成`}
        </span>
        <span className="min-w-0 flex-1" />
        {!hasActive && (
          <span className={`shrink-0 text-2xs text-faint transition-transform duration-med ${expanded ? "rotate-90" : ""}`}>
            ▸
          </span>
        )}
      </button>
      {showRows &&
        records.map((record) => {
          const text = record.summary ?? record.stage ?? record.taskPreview;
          return (
            <div key={record.subagentId} className="flex items-center gap-2 py-0.5">
              <span className={subagentDotClass(record.status)} />
              <span className="mono shrink-0 text-2xs text-hi">{record.profileName}</span>
              <span className="min-w-0 flex-1 truncate text-2xs text-mid" title={text}>
                {text}
              </span>
              {record.turnsUsed !== null && <span className="shrink-0 text-2xs text-faint">{String(record.turnsUsed)} 轮</span>}
            </div>
          );
        })}
    </div>
  );
});

export default function ChatFlow() {
  const view = useDesktop((s) => (s.activeId === null ? undefined : s.views[s.activeId]));
  const hasApprovals = useDesktop((s) => s.approvals.length > 0);
  const activeId = useDesktop((s) => s.activeId);
  const subagents = useDesktop((s) => s.subagents);
  // spawned 事件归属的活跃会话过滤（subagent.* 不带 sessionId，归属=事件到达时 activeId）
  const sessionSubagents = useMemo(
    () => subagents.filter((record) => record.sessionId === activeId),
    [subagents, activeId],
  );
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [view]);

  const items = view?.items ?? [];

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-base">
      {hasApprovals && <PendingBanner />}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="corner-ticks mx-auto flex w-full max-w-[760px] flex-col gap-3 px-6 py-5">
            {items.map((item) =>
              item.kind === "message" ? (
                <MessageBubble key={item.id} item={item} />
              ) : item.kind === "hook" ? (
                <HookRow key={item.id} item={item} />
              ) : (
                <ToolCard key={item.toolCallId} item={item} />
              ),
            )}
            {sessionSubagents.length > 0 && <SubagentCard records={sessionSubagents} />}
          </div>
        )}
      </div>
      <InputArea />
    </main>
  );
}
