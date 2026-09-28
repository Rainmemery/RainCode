/**
 * CompactionService：auto-compact 上下文压缩（02-module-design §1.2.5 / NFR-6）。
 *
 * 触发：turn 边界（组装上下文前 / T13 聚合后）估算 token ≥ 窗口阈值（默认 80%）→ 异步启动，
 * 不阻塞当前 turn；in-flight 期间幂等跳过（去重锁）。
 * 提交：摘要消息替换 [0..summarizedCount) 前缀，其余历史原样保留——压缩读快照与写新历史之间
 * 无需丢弃窗口期新增消息（前缀不可变 + slice 合并，02 §1.4 单调合并）；落盘为
 * compaction.applied 事件行（重放语义见 storage jsonl-resume）+ epoch+1 checkpoint。
 * 失败：保留原历史，阈值临时上调至 90%，下个触发点重试；连续 3 次失败仅告警不再重试。
 */
import {
  COMPACTION_EVENT_NAME,
  compactionSummaryRecord,
  ulid,
} from "@novacode/storage";
import type { CheckpointState } from "@novacode/storage";
import type { StoragePort } from "../ports.js";
import type { LlmPort } from "../ports.js";
import type { MessageRecord } from "@novacode/shared";
import {
  buildCompactCompletedEvent,
  buildCompactStartedEvent,
} from "@novacode/shared";

/** 压缩选项（02 §1.3 CompactionOptions；contextWindowTokens 由 server 按 Provider 注入）。 */
export interface CompactionOptions {
  /** 窗口触发比例（默认 0.80；摘要失败后临时上调 0.90）。 */
  thresholdRatio?: number;
  /** 保留区最近消息条数（默认 20）。 */
  keepRecentCount?: number;
  /** 上下文窗口 token 上限（触发估算基准）。 */
  contextWindowTokens: number;
}

/** 压缩宿主（SessionTurnLoop 实现）：历史与 epoch 的窄接口。 */
export interface CompactionHost {
  /** 历史快照副本。 */
  getHistory(): MessageRecord[];
  /** 提交点：prefix 替换 [0..summarizedCount) 前缀，其余原样保留（同步原子，窗口期新增不丢）。 */
  replaceWith(prefix: MessageRecord[], summarizedCount: number): void;
  historyLength(): number;
  currentEpoch(): number;
  updateEpoch(epoch: number): void;
  /** checkpoint 派生快照基座（mode/todo 由循环持有；messageCount 由服务按提交后长度覆盖）。 */
  checkpointBase(): Pick<CheckpointState, "mode" | "todo">;
}

/** 压缩依赖（server/loop 装配注入；事件经 LoopEvents 分配 rpc seq）。 */
export interface CompactionDeps {
  sessionId: string;
  llm: LlmPort;
  storage: StoragePort;
  /** 全部 JSONL 写入经单写者链串行（SessionStream 并发追加会错序 seq）。 */
  serialWrite<T>(task: () => Promise<T>): Promise<T>;
  emitCompactionEvent(
    name: "compact.started" | "compact.completed",
    build: (seq: number, ts: number) => unknown,
  ): void;
  systemPrompt?: string;
  diag(message: string, err?: unknown): void;
}

/** 受理凭证（06 §2.1 session.compact 应答主体）。 */
export interface CompactionTicket {
  compactionId: string;
  epoch: number;
  alreadyRunning: boolean;
}

/** 压缩终态报告（06 §3.5 compact.completed payload 投影）。 */
export interface CompactionReport {
  compactionId: string;
  epoch: number;
  ok: boolean;
  tokensBefore?: number;
  tokensAfter?: number;
  failure?: { reason: string };
}

const DEFAULT_THRESHOLD = 0.8;
const FAILURE_THRESHOLD = 0.9; // 摘要失败后临时阈值（02 §1.4）
const MAX_CONSECUTIVE_FAILURES = 3; // 连续失败后停止自动重试（仅告警）
const FALLBACK_CHARS_PER_TOKEN = 3; // 无 usage 时的字符估算（CJK 偏保守）

/**
 * 上下文 token 估算：优先用最近一轮真实 promptTokens（usage 事件回传）；
 * 尚无 usage 时按字符数 / 3 兜底估算。
 */
export function estimateContextTokens(history: readonly MessageRecord[], lastPromptTokens: number): number {
  if (lastPromptTokens > 0) {
    return lastPromptTokens;
  }
  let chars = 0;
  for (const message of history) {
    chars += typeof message.content === "string" ? message.content.length : JSON.stringify(message.content).length;
  }
  return Math.ceil(chars / FALLBACK_CHARS_PER_TOKEN);
}

const SUMMARY_PROMPT = [
  "你是会话压缩助手。下面的对话历史即将被你的摘要替换，摘要将成为模型对早期对话的唯一记忆。",
  "请用中文输出结构化摘要（不超过 600 字），尽可能保留：用户目标与约束、已做的决策及其理由、",
  "关键文件路径 / 命令 / 技术约定、未完成的任务（TODO）与下一步计划。",
  "关键信息保留原始措辞；不要编造不存在的事实。直接输出摘要正文。",
].join("\n");

/** 事件/串行化/诊断出口的最小视图（SessionTurnLoop.events 满足）。 */
type LoopEventsView = {
  serialWrite<T>(task: () => Promise<T>): Promise<T>;
  emitPersisted(name: "compact.started" | "compact.completed", build: (seq: number, ts: number) => unknown): void;
  diag(message: string, err?: unknown): void;
};

/** 装配入口（SessionTurnLoop 构造器调用）：deps 由 options + events 视图组装。 */
export function createCompactionService(
  host: CompactionHost,
  input: {
    sessionId: string;
    llm: LlmPort;
    storage: StoragePort;
    systemPrompt?: string;
    events: LoopEventsView;
  },
  options: CompactionOptions,
): CompactionService {
  return new CompactionService(
    host,
    {
      sessionId: input.sessionId,
      llm: input.llm,
      storage: input.storage,
      serialWrite: (task) => input.events.serialWrite(task),
      emitCompactionEvent: (name, build) => input.events.emitPersisted(name, build),
      ...(input.systemPrompt !== undefined && { systemPrompt: input.systemPrompt }),
      diag: (message, err) => input.events.diag(message, err),
    },
    options,
  );
}

export class CompactionService {
  private readonly keepRecent: number;
  private readonly window: number;
  private inFlight: { compactionId: string; epoch: number } | null = null;
  private consecutiveFailures = 0;
  private readonly listeners = new Set<(report: CompactionReport) => void>();

  constructor(
    private readonly host: CompactionHost,
    private readonly deps: CompactionDeps,
    options: CompactionOptions,
  ) {
    this.keepRecent = options.keepRecentCount ?? 20;
    this.window = options.contextWindowTokens;
  }

  /** 压缩完成订阅（02 §1.3 CompactionService.onDone）。返回退订函数。 */
  onDone(listener: (report: CompactionReport) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * turn 边界阈值触发（02 §1.2.5「组装上下文前 / 聚合工具结果后」）。
   * 未达阈值 / 去重锁占用 / 连续失败停机 / 无可摘要前缀 → null（继续正常流程）。
   */
  maybeTrigger(estimateTokens: number): CompactionTicket | null {
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      return null;
    }
    const threshold = this.consecutiveFailures > 0 ? FAILURE_THRESHOLD : (DEFAULT_THRESHOLD);
    if (estimateTokens < threshold * this.window) {
      return null;
    }
    return this.start("auto", estimateTokens);
  }

  /** 手动触发（06 §2.1 session.compact）：越过阈值判定；in-flight 幂等复用既有 ticket。 */
  compactNow(): CompactionTicket | null {
    return this.start("manual", undefined);
  }

  // -------------------------------------------------------------------------

  private start(trigger: "auto" | "manual", tokensBefore: number | undefined): CompactionTicket | null {
    if (this.inFlight !== null) {
      return { compactionId: this.inFlight.compactionId, epoch: this.inFlight.epoch, alreadyRunning: true };
    }
    const history = this.host.getHistory();
    const summarizedCount = this.cutIndex(history);
    if (summarizedCount <= 0) {
      return null; // 历史未超出保留区，无前缀可摘要
    }
    const compactionId = `cp_${ulid()}`;
    const epoch = this.host.currentEpoch();
    this.inFlight = { compactionId, epoch };
    this.deps.emitCompactionEvent("compact.started", (seq, ts) =>
      buildCompactStartedEvent({ seq, ts, sessionId: this.deps.sessionId, compactionId, epoch, trigger }),
    );
    void this.run(compactionId, history.slice(0, summarizedCount), summarizedCount, tokensBefore).catch(
      (err: unknown) => this.deps.diag("compaction task crashed", err),
    );
    return { compactionId, epoch, alreadyRunning: false };
  }

  /** 摘要 → 串行提交（标记行 + 内存替换 + epoch+1 checkpoint）→ 完成事件。 */
  private async run(
    compactionId: string,
    prefix: MessageRecord[],
    summarizedCount: number,
    tokensBefore: number | undefined,
  ): Promise<void> {
    let report: CompactionReport;
    try {
      const summary = (await this.summarize(prefix)).trim();
      if (summary.length === 0) {
        throw new Error("summary is empty");
      }
      const summaryRecord = compactionSummaryRecord({ compactionId, epoch: 0, summary, summarizedCount });
      const nextEpoch = this.host.currentEpoch() + 1;
      let committedEpoch = this.host.currentEpoch();
      await this.deps.serialWrite(async () => {
        const marker = await this.deps.storage.appendEvent(
          this.deps.sessionId,
          COMPACTION_EVENT_NAME,
          {
            compactionId,
            epoch: nextEpoch,
            summary,
            summarizedCount,
            ...(tokensBefore !== undefined && { tokensBefore }),
          },
          { epoch: nextEpoch },
        );
        if (!marker.accepted) {
          this.deps.diag("compaction marker rejected (stale epoch); keep original history");
          return;
        }
        // 提交点（串行链内同步替换）：读-改-换之间无 await 空隙，窗口期新增消息经 slice 保留
        this.host.replaceWith([summaryRecord], summarizedCount);
        const checkpoint = await this.deps.storage.writeCheckpoint(
          this.deps.sessionId,
          { ...this.host.checkpointBase(), messageCount: this.host.historyLength() },
          { epoch: nextEpoch },
        );
        if (checkpoint.accepted) {
          committedEpoch = checkpoint.epoch;
          this.host.updateEpoch(checkpoint.epoch);
        }
      });
      report = {
        compactionId,
        epoch: committedEpoch,
        ok: true,
        ...(tokensBefore !== undefined && { tokensBefore }),
        tokensAfter: estimateContextTokens(this.host.getHistory(), 0),
      };
      this.consecutiveFailures = 0;
    } catch (reason: unknown) {
      this.consecutiveFailures += 1; // 阈值临时上调至 0.9；连续 3 次后自动触发停机
      report = {
        compactionId,
        epoch: this.host.currentEpoch(),
        ok: false,
        ...(tokensBefore !== undefined && { tokensBefore }),
        failure: { reason: reason instanceof Error ? reason.message : String(reason) },
      };
      this.deps.diag(`compaction failed (${String(this.consecutiveFailures)}/${String(MAX_CONSECUTIVE_FAILURES)})`, reason);
    } finally {
      this.inFlight = null;
    }
    this.deps.emitCompactionEvent("compact.completed", (seq, ts) =>
      buildCompactCompletedEvent({ seq, ts, sessionId: this.deps.sessionId, ...report }),
    );
    for (const listener of this.listeners) {
      try {
        listener(report);
      } catch (err: unknown) {
        this.deps.diag("compaction onDone listener threw", err);
      }
    }
  }

  /**
   * 摘要前缀切点：保留最近 keepRecent 条；成对安全——切点落在 tool 结果上时前移，
   * 避免保留区出现无 assistant tool_call 伙伴的孤儿 tool 消息（OpenAI 线格式非法）。
   */
  private cutIndex(history: readonly MessageRecord[]): number {
    let cut = history.length - this.keepRecent;
    if (cut <= 0) {
      return 0;
    }
    while (cut < history.length && history[cut]?.role === "tool") {
      cut += 1;
    }
    return cut;
  }

  /** 对被摘要前缀生成结构化摘要（复用会话模型；一次非流式用途的流式调用）。 */
  private async summarize(prefix: readonly MessageRecord[]): Promise<string> {
    const transcript = prefix
      .map((message, index) => {
        const text =
          typeof message.content === "string" ? message.content : JSON.stringify(message.content);
        return `[${String(index + 1)}] ${message.role}: ${text}`;
      })
      .join("\n");
    let summary = "";
    await this.deps.llm.streamChat({
      messages: [
        { role: "user", content: `${SUMMARY_PROMPT}\n\n<conversation>\n${transcript}\n</conversation>` },
      ],
      includeUsage: false,
      signal: new AbortController().signal,
      onEvent: (event) => {
        if (event.type === "delta.text") {
          summary += event.text;
        }
      },
    });
    return summary;
  }
}
