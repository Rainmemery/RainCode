/**
 * MicrocompactService：full compact 触发前的旧 tool result 预剪枝（T5.4 microcompact，
 * 02 §1.2.5；参照 ZCode core/src/compact/microcompact.ts 触发策略 + dsh
 * compaction-tool-result-pruner 替换形态与回指事件协议，两仓同题互证）。
 *
 * 触发（ZCode 策略）：上下文估算 ≥ thresholdRatio(0.9) × full compact 触发线（阈值=上下文
 * 占比；不做 ZCode 的绝对 2000-token buffer——小窗口下会钳 0，比例式尺度无关且可测）；
 * 白名单工具（默认 read/bash/grep/glob/web_fetch）的超长 tool result（> thresholdChars
 * 8192 code points）为候选；保留最近 keepRecentCount（默认 5）条候选，更老者入剪枝集；
 * 整 pass 估算节省 ≥ minSavingsTokens(256) 才应用（all-or-nothing，确定性）。
 * 替换（dsh 形态）：head + marker + tail，按 Unicode code point 切分不劈代理对（图形容
 * 簇仍可能切开，与 dsh 同口径申报）；配置校验 head + marker + tail ≤ 单条阈值 ⇒ 单过收敛
 * 不变量「剪后恒 ≤ 阈值且严格小于原文」（剪后 5140 < 8192，重入天然跳过）。
 * 持久（dsh 回指协议）：落 `compaction.pruned` 事件行（storage 级，同 compaction.applied
 * 先例，不经 RPC 发布协议零变更），replacements[].sourceMessageId 回指原文 message、
 * prunedContent 内联——resume/回放与内存一致；预剪枝不取压缩去重锁、不 bump epoch
 * （压缩锁括弧协议兼容：独立 pass 插于 full compact 之前，快照前缀与位置截断语义不受
 * content 替换影响——剪枝只换内容不增删消息，index 稳定）。
 * 边界顺序（02 §1.2.5）：组装上下文前 / T13 聚合后——先 micro 后 full；应用后节省 tokens
 * 回落 usage 估算（最近真实请求含未剪枝原文），可使 full compact 不再触发。
 */
import { COMPACTION_PRUNED_EVENT_NAME, ulid } from "@raincode/storage";
import type { CompactionPrunedPayload } from "@raincode/storage";
import type { MessageRecord } from "@raincode/shared";
import type { StoragePort } from "../ports.js";
import { estimateContextTokens, FALLBACK_CHARS_PER_TOKEN } from "./service.js";

/** micro 线 = thresholdRatio × full compact 线（ZCode DEFAULT_MICROCOMPACT_THRESHOLD_RATIO）。 */
export const MICROCOMPACT_THRESHOLD_RATIO = 0.9;
/** 保留最近 N 条候选 tool result（ZCode DEFAULT_MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS）。 */
export const MICROCOMPACT_KEEP_RECENT = 5;
/** 整 pass 最小节省 tokens 门槛（ZCode DEFAULT_MICROCOMPACT_MIN_TOKEN_SAVINGS）。 */
export const MICROCOMPACT_MIN_SAVINGS_TOKENS = 256;
/** 单条 tool result 剪枝阈值（code points；dsh DEFAULTS.thresholdChars）。 */
export const MICROCOMPACT_THRESHOLD_CHARS = 8192;
/** 剪后保留头部 code points（dsh DEFAULTS.headChars）。 */
export const MICROCOMPACT_HEAD_CHARS = 4096;
/** 剪后保留尾部 code points（dsh DEFAULTS.tailChars）。 */
export const MICROCOMPACT_TAIL_CHARS = 1024;
/** 中段替换标记（dsh PRUNE_MARKER 同位；原文保留于会话日志，session_search 可召回）。 */
export const MICROCOMPACT_PRUNE_MARKER = "\n\n[... 中段已预剪枝（microcompact）：原文见会话日志 ...]\n\n";
/** 可压缩工具白名单（ZCode Read/Bash/Grep/Glob/WebFetch → RainCode 内置名）。 */
export const MICROCOMPACT_COMPACTABLE_TOOLS = ["read", "bash", "grep", "glob", "web_fetch"] as const;

/** 预剪枝选项（CompactionOptions.microcompact；全部缺省即 ZCode/dsh 参照常量）。 */
export interface MicrocompactOptions {
  /** 缺省 true；false 整体关闭。 */
  enabled?: boolean;
  /** micro 线占 full compact 线的比例（0 < ratio ≤ 1）。 */
  thresholdRatio?: number;
  /** 保留最近 N 条候选（≥ 0；0 = 候选全剪）。 */
  keepRecentCount?: number;
  /** 整 pass 最小节省 tokens 门槛（≥ 0）。 */
  minSavingsTokens?: number;
  /** 可压缩工具白名单（覆盖缺省）。 */
  compactableTools?: readonly string[];
  /** 单条剪枝阈值 code points（≥ 1）。 */
  thresholdChars?: number;
  /** 剪后头部保留 code points（≥ 0）。 */
  headChars?: number;
  /** 剪后尾部保留 code points（≥ 0）。 */
  tailChars?: number;
}

export interface ResolvedMicrocompactConfig {
  readonly enabled: boolean;
  readonly thresholdRatio: number;
  readonly keepRecentCount: number;
  readonly minSavingsTokens: number;
  readonly compactableTools: ReadonlySet<string>;
  readonly thresholdChars: number;
  readonly headChars: number;
  readonly tailChars: number;
}

/** 配置解析与校验（构造期 fail-fast；head+marker+tail ≤ threshold 即收敛不变量的静态保证）。 */
export function resolveMicrocompactConfig(options: MicrocompactOptions | undefined): ResolvedMicrocompactConfig {
  const enabled = options?.enabled !== false;
  const thresholdRatio = options?.thresholdRatio ?? MICROCOMPACT_THRESHOLD_RATIO;
  const keepRecentCount = options?.keepRecentCount ?? MICROCOMPACT_KEEP_RECENT;
  const minSavingsTokens = options?.minSavingsTokens ?? MICROCOMPACT_MIN_SAVINGS_TOKENS;
  const compactableTools = new Set(options?.compactableTools ?? MICROCOMPACT_COMPACTABLE_TOOLS);
  const thresholdChars = options?.thresholdChars ?? MICROCOMPACT_THRESHOLD_CHARS;
  const headChars = options?.headChars ?? MICROCOMPACT_HEAD_CHARS;
  const tailChars = options?.tailChars ?? MICROCOMPACT_TAIL_CHARS;

  if (!(Number.isFinite(thresholdRatio) && thresholdRatio > 0 && thresholdRatio <= 1)) {
    throw new Error(`microcompact: thresholdRatio (${String(thresholdRatio)}) must be in (0, 1]`);
  }
  assertInteger("keepRecentCount", keepRecentCount, 0);
  assertInteger("minSavingsTokens", minSavingsTokens, 0);
  assertInteger("thresholdChars", thresholdChars, 1);
  assertInteger("headChars", headChars, 0);
  assertInteger("tailChars", tailChars, 0);
  const emittedChars = headChars + codePointLength(MICROCOMPACT_PRUNE_MARKER) + tailChars;
  if (emittedChars > thresholdChars) {
    throw new Error(
      `microcompact: headChars + marker + tailChars (${String(emittedChars)}) `
      + `must be at most thresholdChars (${String(thresholdChars)})`,
    );
  }
  return {
    enabled,
    thresholdRatio,
    keepRecentCount,
    minSavingsTokens,
    compactableTools,
    thresholdChars,
    headChars,
    tailChars,
  };
}

function assertInteger(name: string, value: number, min: number): void {
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`microcompact: ${name} (${String(value)}) must be an integer >= ${String(min)}`);
  }
}

/** Unicode code point 计数（非 UTF-16 code unit）。 */
export function codePointLength(text: string): number {
  return Array.from(text).length;
}

/**
 * head + marker + tail 替换（dsh pruneContent 单文本块形态）。
 * 按 code point 切分不劈代理对；≤ 阈值返回 null（不动）；head/tail 可能仍切到
 * 字素簇（grapheme），与 dsh 同口径申报。
 */
export function pruneToolResultText(text: string, config: ResolvedMicrocompactConfig): string | null {
  const points = Array.from(text);
  if (points.length <= config.thresholdChars) {
    return null;
  }
  const head = points.slice(0, config.headChars).join("");
  const tail = config.tailChars > 0 ? points.slice(points.length - config.tailChars).join("") : "";
  return head + MICROCOMPACT_PRUNE_MARKER + tail;
}

/** toolCallId → 工具名（自 assistant 消息的 tool_call 块回查；tool 行自身不携带工具名）。 */
function toolNameIndex(history: readonly MessageRecord[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of history) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    for (const block of message.content) {
      if (block.type === "tool_call") {
        names.set(block.toolCallId, block.name);
      }
    }
  }
  return names;
}

export interface MicrocompactReplacementPlan {
  /** 历史数组下标（替换不增删消息，index 稳定）。 */
  index: number;
  /** 原记录引用（应用时以同 id 新对象替换）。 */
  record: MessageRecord;
  sourceMessageId: string;
  toolCallId: string;
  toolName: string;
  prunedContent: string;
  charsBefore: number;
  charsAfter: number;
}

export interface MicrocompactPlan {
  replacements: MicrocompactReplacementPlan[];
  charsRemoved: number;
  tokensSaved: number;
}

export type MicrocompactSkipReason = "not_triggered" | "no_candidates" | "below_min_savings";

/**
 * 单过确定性剪枝计划（纯函数）：白名单 + 超阈值 + 非错误 + 未剪枝的 tool result 为候选，
 * 保留最近 keepRecentCount 条，更老者生成 head+marker+tail 替换；整 pass 节省不足
 * minSavingsTokens 时整体放弃（all-or-nothing）。跳过时返回原因字符串。
 */
export function planMicrocompact(input: {
  history: readonly MessageRecord[];
  config: ResolvedMicrocompactConfig;
}): MicrocompactPlan | MicrocompactSkipReason {
  const { history, config } = input;
  const names = toolNameIndex(history);
  const candidates: Array<{ index: number; record: MessageRecord; toolCallId: string; toolName: string }> = [];
  for (let index = 0; index < history.length; index += 1) {
    const message = history[index]!;
    if (message.role !== "tool" || typeof message.content !== "string" || message.isError === true) {
      continue;
    }
    const toolCallId = message.toolCallId;
    if (typeof toolCallId !== "string") {
      continue;
    }
    const toolName = names.get(toolCallId);
    if (toolName === undefined || !config.compactableTools.has(toolName)) {
      continue;
    }
    if (message.content.includes(MICROCOMPACT_PRUNE_MARKER)) {
      continue; // 已剪枝：重入跳过（幂等；剪后 5140 < 8192 亦天然低于阈值）
    }
    if (codePointLength(message.content) <= config.thresholdChars) {
      continue;
    }
    candidates.push({ index, record: message, toolCallId, toolName });
  }
  const targets = candidates.slice(0, Math.max(0, candidates.length - Math.max(0, config.keepRecentCount)));
  if (targets.length === 0) {
    return "no_candidates";
  }
  const replacements: MicrocompactReplacementPlan[] = [];
  let charsRemoved = 0;
  for (const candidate of targets) {
    const content = candidate.record.content;
    if (typeof content !== "string") {
      continue; // 不可达（候选判定已收窄 string），防御
    }
    const prunedContent = pruneToolResultText(content, config);
    if (prunedContent === null) {
      continue; // 不可达（候选已过阈值），防御
    }
    const charsBefore = codePointLength(content);
    const charsAfter = codePointLength(prunedContent);
    replacements.push({
      index: candidate.index,
      record: candidate.record,
      sourceMessageId: candidate.record.id,
      toolCallId: candidate.toolCallId,
      toolName: candidate.toolName,
      prunedContent,
      charsBefore,
      charsAfter,
    });
    charsRemoved += charsBefore - charsAfter;
  }
  if (replacements.length === 0) {
    return "no_candidates";
  }
  const tokensSaved = Math.floor(charsRemoved / FALLBACK_CHARS_PER_TOKEN);
  if (tokensSaved < config.minSavingsTokens) {
    return "below_min_savings";
  }
  return { replacements, charsRemoved, tokensSaved };
}

/** 预剪枝宿主（SessionTurnLoop 实现）：历史与 epoch 的窄接口。 */
export interface MicrocompactHost {
  getHistory(): MessageRecord[];
  /** 就地替换 index 处消息（同 id 新对象；预剪枝不增删消息，index 稳定）。 */
  replaceAt(index: number, record: MessageRecord): void;
  currentEpoch(): number;
}

/** 预剪枝依赖（server/loop 装配注入；事件写入经单写者链串行）。 */
export interface MicrocompactDeps {
  sessionId: string;
  storage: StoragePort;
  serialWrite<T>(task: () => Promise<T>): Promise<T>;
  diag(message: string, err?: unknown): void;
}

export type MicrocompactOutcome =
  | { applied: true; prunerId: string; prunedCount: number; charsRemoved: number; tokensSaved: number }
  | { applied: false; reason: MicrocompactSkipReason };

export class MicrocompactService {
  private readonly config: ResolvedMicrocompactConfig;

  constructor(
    private readonly host: MicrocompactHost,
    private readonly deps: MicrocompactDeps,
    options: MicrocompactOptions | undefined,
    /** full compact 触发线（tokens）供给方：CompactionService.fullCompactThresholdTokens。 */
    private readonly fullThresholdTokens: () => number,
  ) {
    this.config = resolveMicrocompactConfig(options);
  }

  /**
   * turn 边界预剪枝（02 §1.2.5「full compact 触发前」）：压力确认（估算 ≥ 0.9 × full 线）
   * 后才剪（dsh 不变量 1）。同步单过、确定性；事件经单写者链异步落盘（fire-and-forget，
   * 重放为真源，两向收敛）。未触发/无候选/节省不足返回 applied:false。
   */
  maybePrune(lastPromptTokens: number): MicrocompactOutcome {
    if (!this.config.enabled) {
      return { applied: false, reason: "not_triggered" };
    }
    const full = this.fullThresholdTokens();
    if (!(full > 0)) {
      return { applied: false, reason: "not_triggered" };
    }
    const thresholdTokens = this.config.thresholdRatio * full;
    const history = this.host.getHistory();
    const estimateTokens = estimateContextTokens(history, lastPromptTokens);
    if (estimateTokens < thresholdTokens) {
      return { applied: false, reason: "not_triggered" };
    }
    const plan = planMicrocompact({ history, config: this.config });
    if (typeof plan === "string") {
      return { applied: false, reason: plan };
    }
    const prunerId = `mc_${ulid()}`;
    for (const replacement of plan.replacements) {
      this.host.replaceAt(replacement.index, { ...replacement.record, content: replacement.prunedContent });
    }
    const payload: CompactionPrunedPayload = {
      prunerId,
      epoch: this.host.currentEpoch(),
      replacements: plan.replacements.map((replacement) => ({
        sourceMessageId: replacement.sourceMessageId,
        toolCallId: replacement.toolCallId,
        toolName: replacement.toolName,
        charsBefore: replacement.charsBefore,
        charsAfter: replacement.charsAfter,
        prunedContent: replacement.prunedContent,
      })),
      charsRemoved: plan.charsRemoved,
      tokensSaved: plan.tokensSaved,
      tokensBefore: estimateTokens,
    };
    void this.deps
      .serialWrite(() =>
        this.deps.storage.appendEvent(this.deps.sessionId, COMPACTION_PRUNED_EVENT_NAME, payload),
      )
      .then((result) => {
        if (!result.accepted) {
          this.deps.diag("microcompact event rejected (stale epoch)");
        }
      })
      .catch((err: unknown) => this.deps.diag("microcompact event append failed", err));
    return {
      applied: true,
      prunerId,
      prunedCount: plan.replacements.length,
      charsRemoved: plan.charsRemoved,
      tokensSaved: plan.tokensSaved,
    };
  }
}

/** 装配入口（SessionTurnLoop 构造器调用）。 */
export function createMicrocompactService(
  host: MicrocompactHost,
  deps: MicrocompactDeps,
  options: MicrocompactOptions | undefined,
  fullThresholdTokens: () => number,
): MicrocompactService {
  return new MicrocompactService(host, deps, options, fullThresholdTokens);
}
