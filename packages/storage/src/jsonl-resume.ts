/**
 * 会话恢复与文件级诊断（05-database §4.4 / §4.5）。
 * - 恢复：checkpoint_offset O(1) 定位 → 校验（完整 checkpoint 行且 epoch 与库内一致）→
 *   增量重放至 EOF；不可用则尾部 ≤256KB 扫描最近完整 checkpoint；再退全量重放（最坏 ≤1s，NFR-5）；
 * - 悬挂 tool_call：assistant 含 toolCallId 而流内无对应 tool 结果 → 内存态以 isError=true 补齐（不改写历史）；
 * - 半行截断修复：EOF 残尾另存 events.jsonl.tail-<ts> 后截去——追加写模型下唯一允许的改写（§4.5）。
 * 所有字节偏移一律在 Buffer 层计算（消息正文含多字节字符，字符串下标≠字节偏移）。
 */
import { open as openFile, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { MessageRecord } from "@raincode/shared";
import {
  COMPACTION_EVENT_NAME,
  COMPACTION_PRUNED_EVENT_NAME,
  HEADER_EVENT_NAME,
  compactionSummaryRecord,
  parseLine,
  type CheckpointLine,
  type CompactionMarkerPayload,
  type EventLine,
} from "./jsonl-lines.js";

const TAIL_SCAN_BYTES = 256 * 1024;

export type CheckpointSource = "recorded" | "tail-scan" | "full-replay";

export interface ResumeReplay {
  source: CheckpointSource;
  /** 命中的 checkpoint（offset 为该行起始字节偏移；full-replay 为文件内最后一条）。 */
  checkpoint: (CheckpointLine & { offset: number }) | null;
  /** 文件内最大 epoch（checkpoint epoch 与头行 payload.epoch 取最大）。 */
  epoch: number;
  /** 增量重放的消息（checkpoint 之后至 EOF；全量时为全部消息）。 */
  messages: MessageRecord[];
  /** 全文件消息（完整历史重建用；includeHistory=false 时为空数组）。 */
  history: MessageRecord[];
  events: EventLine[];
  /** 悬挂 tool_call 补齐的合成结果（isError=true，02 §1.4）。 */
  synthesizedToolResults: MessageRecord[];
  /** 悬挂/损坏行数（半行截断等，仅计数不改写）。 */
  danglingTailLines: number;
  /** 重放消息计数：checkpoint.state.messageCount + 增量消息数（对账口径，§4.4 第 6 步）。 */
  messageCount: number;
}

export interface ResumeReadOptions {
  /** sessions.checkpoint_offset（最近 checkpoint 行起始字节偏移）；0/缺省 = 无可信 checkpoint。 */
  checkpointOffset?: number;
  /** sessions.epoch（库内当前代次，checkpoint 行一致性校验用）。 */
  epoch?: number;
  /** 是否额外做全文件重放填充 history（恢复典型场景开启；缺省 false 以守住 O(1) 定位）。 */
  includeHistory?: boolean;
}

interface LineRange {
  start: number; // 相对 buffer 的字节偏移
  end: number;   // 换行字节位置（不含）
  complete: boolean; // 是否以换行收尾
}

function lineRanges(buf: Buffer): LineRange[] {
  const ranges: LineRange[] = [];
  let start = 0;
  for (;;) {
    const nl = buf.indexOf(10, start); // "\n"
    if (nl === -1) {
      if (start < buf.length) {
        ranges.push({ start, end: buf.length, complete: false });
      }
      break;
    }
    ranges.push({ start, end: nl, complete: true });
    start = nl + 1;
  }
  return ranges;
}

async function readRange(fh: FileHandle, start: number, end: number): Promise<Buffer> {
  const length = end - start;
  const buf = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const { bytesRead } = await fh.read(buf, read, length - read, start + read);
    if (bytesRead <= 0) {
      break;
    }
    read += bytesRead;
  }
  return read === length ? buf : buf.subarray(0, read);
}

function headerEpoch(line: EventLine): number {
  if (line.name !== HEADER_EVENT_NAME) {
    return 0;
  }
  const payload = line.payload as { epoch?: unknown } | null | undefined;
  return typeof payload?.epoch === "number" ? payload.epoch : 0;
}

function emptyReplay(epoch: number): ResumeReplay {
  return {
    source: "full-replay",
    checkpoint: null,
    epoch,
    messages: [],
    history: [],
    events: [],
    synthesizedToolResults: [],
    danglingTailLines: 0,
    messageCount: 0,
  };
}

/**
 * 悬挂 tool_call 补齐：收集 assistant 消息内 tool_call 块，扣除已有 tool 结果，
 * 未决者合成 isError=true 结果消息（02 §1.4：content=「进程中断，结果丢失」）。
 */
function synthesizeDanglingToolResults(messages: MessageRecord[]): MessageRecord[] {
  const pending = new Set<string>(); // 未决 toolCallId
  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === "tool_call") {
          pending.add(block.toolCallId);
        }
      }
    } else if (message.role === "tool" && typeof message.toolCallId === "string") {
      pending.delete(message.toolCallId);
    }
  }
  const synthesized: MessageRecord[] = [];
  for (const toolCallId of pending.keys()) {
    synthesized.push({
      id: `msg_recovered_${toolCallId}`,
      role: "tool",
      toolCallId,
      content: "进程中断，结果丢失",
      isError: true,
    });
  }
  return synthesized;
}

/** 尾部扫描：从末尾向前找最近一条完整 checkpoint 行，返回其绝对字节偏移。 */
function scanTailForCheckpoint(buf: Buffer, tailStart: number): number | null {
  const ranges = lineRanges(buf);
  for (let i = ranges.length - 1; i >= 0; i--) {
    const range = ranges[i]!;
    if (!range.complete) {
      continue; // EOF 半行不参与
    }
    const parsed = parseLine(buf.subarray(range.start, range.end).toString("utf8"));
    if (parsed.ok && parsed.line.type === "checkpoint") {
      return tailStart + range.start;
    }
  }
  return null;
}

/**
 * 压缩标记应用（05 §4.4 重放语义）：以摘要消息替换历史前 summarizedCount 条。
 * payload 宽松校验，缺字段/非法值时忽略该标记（不中断重放，§4.5 宽松读原则）。
 */
function applyCompactionMarker(history: MessageRecord[], payload: unknown): MessageRecord[] {
  if (typeof payload !== "object" || payload === null) {
    return history;
  }
  const record = payload as Record<string, unknown>;
  const compactionId = record["compactionId"];
  const summary = record["summary"];
  const summarizedCount = record["summarizedCount"];
  if (
    typeof compactionId !== "string" ||
    compactionId.length === 0 ||
    typeof summary !== "string" ||
    typeof summarizedCount !== "number" ||
    !Number.isInteger(summarizedCount) ||
    summarizedCount < 0 ||
    summarizedCount >= history.length
  ) {
    return history;
  }
  const marker: CompactionMarkerPayload = {
    compactionId,
    epoch: typeof record["epoch"] === "number" ? record["epoch"] : 0,
    summary,
    summarizedCount,
    ...(typeof record["tokensBefore"] === "number" ? { tokensBefore: record["tokensBefore"] as number } : {}),
  };
  return [compactionSummaryRecord(marker), ...history.slice(summarizedCount)];
}

/**
 * microcompact 预剪枝应用（T5.4 重放语义）：按 sourceMessageId 回指定位原文，
 * 以事件内联的 prunedContent 替换（同 id 新对象，index 稳定不增删——后续
 * compaction.applied 按 summarizedCount 位置截断的计数语义不受影响）。
 * payload 宽松校验：缺字段/非法值/原文不可定位（如已被 full compact 摘要吸收）逐项忽略，
 * 不中断重放（§4.5 宽松读原则）。
 */
function applyCompactionPruned(history: MessageRecord[], payload: unknown): void {
  if (typeof payload !== "object" || payload === null) {
    return;
  }
  const record = payload as Record<string, unknown>;
  const replacements = record["replacements"];
  if (!Array.isArray(replacements)) {
    return;
  }
  for (const item of replacements) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const entry = item as Record<string, unknown>;
    const sourceMessageId = entry["sourceMessageId"];
    const prunedContent = entry["prunedContent"];
    if (typeof sourceMessageId !== "string" || sourceMessageId.length === 0) {
      continue;
    }
    if (typeof prunedContent !== "string") {
      continue;
    }
    const index = history.findIndex((message) => message.id === sourceMessageId);
    if (index < 0) {
      continue;
    }
    history[index] = { ...history[index]!, content: prunedContent };
  }
}

/**
 * 恢复重放主流程（05 §4.4 第 1~5 步的文件侧；对账回写由 Storage 完成）。
 * 文件不存在（新会话/空目录）返回空重放，不视为错误。
 */
export async function replaySessionFile(eventsFile: string, options: ResumeReadOptions = {}): Promise<ResumeReplay> {
  const includeHistory = options.includeHistory ?? false;
  let fh: FileHandle;
  try {
    fh = await openFile(eventsFile, "r");
  } catch {
    return emptyReplay(options.epoch ?? 0);
  }

  try {
    const size = (await fh.stat()).size;
    if (size === 0) {
      return emptyReplay(options.epoch ?? 0);
    }

    // 全文件消息（includeHistory 时同读一份完整历史；压缩标记按重放语义就地应用）
    let history: MessageRecord[] = [];
    if (includeHistory) {
      const whole = await readRange(fh, 0, size);
      for (const range of lineRanges(whole)) {
        const parsed = parseLine(whole.subarray(range.start, range.end).toString("utf8"));
        if (parsed.ok && parsed.line.type === "message") {
          history.push(parsed.line.message);
        } else if (parsed.ok && parsed.line.type === "event" && parsed.line.name === COMPACTION_EVENT_NAME) {
          history = applyCompactionMarker(history, parsed.line.payload);
        } else if (parsed.ok && parsed.line.type === "event" && parsed.line.name === COMPACTION_PRUNED_EVENT_NAME) {
          applyCompactionPruned(history, parsed.line.payload);
        }
      }
    }

    // 1) recorded：seek 到 checkpoint_offset，首行须为完整 checkpoint 且 epoch 与库内一致
    const recordedOffset = options.checkpointOffset ?? 0;
    if (recordedOffset > 0 && recordedOffset < size) {
      const chunk = await readRange(fh, recordedOffset, size);
      const firstNl = chunk.indexOf(10);
      const first = firstNl === -1 ? chunk : chunk.subarray(0, firstNl);
      const parsed = parseLine(first.toString("utf8"));
      if (
        parsed.ok &&
        parsed.line.type === "checkpoint" &&
        (options.epoch === undefined || parsed.line.epoch === options.epoch)
      ) {
        return collectChunk({
          source: "recorded",
          buf: chunk,
          startOffset: recordedOffset,
          checkpointOffsetInChunk: 0,
          history,
        });
      }
    }

    // 2) tail-scan：末尾 ≤256KB 内最近完整 checkpoint
    const tailStart = Math.max(0, size - TAIL_SCAN_BYTES);
    const tail = await readRange(fh, tailStart, size);
    const scanOffset = scanTailForCheckpoint(tail, tailStart);
    if (scanOffset !== null) {
      const chunk = scanOffset === 0 ? await readRange(fh, 0, size) : await readRange(fh, scanOffset, size);
      return collectChunk({
        source: "tail-scan",
        buf: chunk,
        startOffset: scanOffset,
        checkpointOffsetInChunk: 0,
        history,
      });
    }

    // 3) full-replay：全量重放（checkpoint 取文件内最后一条）
    const whole = await readRange(fh, 0, size);
    return collectChunk({
      source: "full-replay",
      buf: whole,
      startOffset: 0,
      checkpointOffsetInChunk: null,
      history,
    });
  } finally {
    await fh.close();
  }
}

/**
 * 解析重放区全部行并汇总。checkpoint 选取：recorded/tail-scan 取首行（已校验）；
 * full-replay 取文件内最后一条 checkpoint（offset 供对账回写）。
 * 悬挂检测基准：有完整历史（history 非空）时在全历史上检测，否则仅在增量消息上检测。
 */
function collectChunk(args: {
  source: CheckpointSource;
  buf: Buffer;
  startOffset: number;
  /** recorded/tail-scan：checkpoint 行在 chunk 内的偏移；full-replay：null 表示滚动取最后一条。 */
  checkpointOffsetInChunk: number | null;
  history: MessageRecord[];
}): ResumeReplay {
  const { source, buf, startOffset, checkpointOffsetInChunk, history } = args;

  const messages: MessageRecord[] = [];
  const events: EventLine[] = [];
  let checkpoint: (CheckpointLine & { offset: number }) | null = null;
  let epoch = 0;
  let danglingTailLines = 0;

  for (const range of lineRanges(buf)) {
    const absoluteOffset = startOffset + range.start;
    const raw = buf.subarray(range.start, range.end);
    if (raw.length === 0) {
      continue;
    }
    const parsed = parseLine(raw.toString("utf8"));
    if (!parsed.ok) {
      danglingTailLines += 1; // 半行/损坏行：只计数不改写（§4.5 写侧修复属打开流时流程）
      continue;
    }
    const line = parsed.line;
    if (line.type === "message") {
      messages.push(line.message);
    } else if (line.type === "event") {
      events.push(line);
      epoch = Math.max(epoch, headerEpoch(line));
    } else if (checkpointOffsetInChunk !== null) {
      // recorded/tail-scan：只认定位到的那一条 checkpoint
      if (checkpoint === null && absoluteOffset === startOffset + checkpointOffsetInChunk) {
        checkpoint = { ...line, offset: absoluteOffset };
        epoch = Math.max(epoch, line.epoch);
      }
    } else {
      // full-replay：滚动取最后一条
      checkpoint = { ...line, offset: absoluteOffset };
      epoch = Math.max(epoch, line.epoch);
    }
  }

  const danglingScanBase = history.length > 0 ? history : messages;
  const synthesizedToolResults = synthesizeDanglingToolResults(danglingScanBase);

  return {
    source,
    checkpoint,
    epoch,
    messages,
    history,
    events,
    synthesizedToolResults,
    danglingTailLines,
    // 对账口径：checkpoint 时计数 + 增量重放消息数（§4.4 第 6 步）
    messageCount: (checkpoint?.state.messageCount ?? 0) + messages.length,
  };
}

/**
 * 尾部状态扫描（重开流时续写用）：完整行的最大 seq 与最近 checkpoint/头行 epoch。
 * 只读末尾 ≤256KB；文件不存在或为空返回零值。
 */
export interface TailState {
  lastSeq: number;
  epoch: number;
}

export async function scanTailState(eventsFile: string): Promise<TailState> {
  let fh: FileHandle;
  try {
    fh = await openFile(eventsFile, "r");
  } catch {
    return { lastSeq: 0, epoch: 0 };
  }
  try {
    const size = (await fh.stat()).size;
    if (size === 0) {
      return { lastSeq: 0, epoch: 0 };
    }
    const tailStart = Math.max(0, size - TAIL_SCAN_BYTES);
    const tail = await readRange(fh, tailStart, size);
    let lastSeq = 0;
    let epoch = 0;
    for (const range of lineRanges(tail)) {
      const parsed = parseLine(tail.subarray(range.start, range.end).toString("utf8"));
      if (!parsed.ok) {
        continue;
      }
      lastSeq = Math.max(lastSeq, parsed.line.seq);
      if (parsed.line.type === "checkpoint") {
        epoch = Math.max(epoch, parsed.line.epoch);
      } else if (parsed.line.type === "event") {
        epoch = Math.max(epoch, headerEpoch(parsed.line));
      }
    }
    return { lastSeq, epoch };
  } finally {
    await fh.close();
  }
}

/**
 * 半行截断修复（05 §4.5）：EOF 无换行残尾 → 残尾另存 events.jsonl.tail-<ts> 后截去。
 * 返回是否发生修复；文件不存在/完整结尾返回 false。
 */
export async function repairDanglingTail(eventsFile: string): Promise<boolean> {
  let fh: FileHandle;
  try {
    fh = await openFile(eventsFile, "r+");
  } catch {
    return false;
  }
  try {
    const size = (await fh.stat()).size;
    if (size === 0) {
      return false;
    }
    const tailLength = Math.min(size, TAIL_SCAN_BYTES);
    const windowStart = size - tailLength;
    const tail = await readRange(fh, windowStart, size);
    if (tail.at(-1) === 10) {
      return false; // EOF 以换行收尾：无残尾
    }
    const lastNl = tail.lastIndexOf(10);
    const cut = lastNl === -1 ? 0 : lastNl + 1; // 窗口内残尾起点
    const residual = tail.subarray(cut);
    if (residual.length > 0) {
      await writeFile(`${eventsFile}.tail-${Date.now()}`, residual, { flag: "a" });
    }
    await fh.truncate(windowStart + cut);
    return true;
  } finally {
    await fh.close();
  }
}
