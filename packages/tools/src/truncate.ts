/**
 * 输出预算裁剪（02-module-design §2.4 / §5.3：环形缓冲保留头 70% / 尾 30%，标记 truncated）。
 * 字节口径按 UTF-8 计算（模型可见内容预算的统一口径）；切点回退到字符边界防残缺码元。
 */

/** 头部/尾部占比（02 §2.4：头 70% / 尾 30%）。 */
const HEAD_RATIO = 0.7;

const TRUNCATION_MARKER = "\n…[输出超出预算，中间内容已截断（保留头 70% / 尾 30%），建议缩小读取范围]…\n";

/** 从缓冲尾部向前回退到 UTF-8 字符起始字节（防截断出残缺码元）。 */
function safeCutIndex(buf: Buffer, index: number): number {
  let i = Math.min(index, buf.length);
  while (i > 0 && (buf[i]! & 0xc0) === 0x80) {
    i -= 1;
  }
  return i;
}

function decode(buf: Buffer): string {
  return buf.toString("utf8");
}

/**
 * 按 UTF-8 字节预算裁剪文本：超预算时保留头 70% / 尾 30% 并插入截断标记。
 * 返回 truncated=false 时 text 与输入一致。
 */
export function truncateToByteBudget(text: string, maxBytes: number): {
  text: string;
  truncated: boolean;
} {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    return { text: "", truncated: text.length > 0 };
  }
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) {
    return { text, truncated: false };
  }
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
  const budget = Math.max(maxBytes - markerBytes, 0);
  const headBytes = Math.floor(budget * HEAD_RATIO);
  const tailBytes = Math.max(budget - headBytes, 0);
  const head = decode(buf.subarray(0, safeCutIndex(buf, headBytes)));
  const tailStart = safeCutIndex(buf, buf.length - tailBytes);
  const tail = decode(buf.subarray(tailStart, buf.length));
  return { text: `${head}${TRUNCATION_MARKER}${tail}`, truncated: true };
}

/**
 * 流式环形缓冲（02 §5.3：输出环形缓冲封顶，磁盘不落地）。
 * 字节超预算后仅保留头 70% / 尾 30%；push 摊销 O(1)（尾窗口滑动）。
 */
export class OutputRingBuffer {
  private head: Buffer = Buffer.alloc(0);
  private tail: Buffer = Buffer.alloc(0);
  private total = 0;
  private capped = false;
  private readonly headCap: number;
  private readonly tailCap: number;

  constructor(readonly maxBytes: number) {
    const budget = Math.max(maxBytes, 1);
    this.headCap = Math.floor(budget * HEAD_RATIO);
    this.tailCap = Math.max(budget - this.headCap, 1);
  }

  push(chunk: Buffer): void {
    this.total += chunk.length;
    if (this.head.length < this.headCap) {
      const room = this.headCap - this.head.length;
      this.head = Buffer.concat([this.head, chunk.subarray(0, Math.min(room, chunk.length))]);
      const rest = chunk.subarray(Math.min(room, chunk.length));
      if (rest.length === 0) return;
      chunk = rest;
    } else {
      this.capped = true;
    }
    // 尾窗口：保留最近 tailCap 字节
    this.tail = Buffer.concat([this.tail, chunk]);
    if (this.tail.length > this.tailCap) {
      this.capped = true;
      this.tail = this.tail.subarray(this.tail.length - this.tailCap);
    }
  }

  get truncated(): boolean {
    return this.capped || this.total > this.maxBytes;
  }

  get byteLength(): number {
    return this.total;
  }

  /** 当前缓冲内容（头窗 + 省略标记 + 尾窗）。 */
  text(): string {
    if (!this.truncated) {
      return decode(Buffer.concat([this.head, this.tail]));
    }
    const head = decode(this.head.subarray(0, safeCutIndex(this.head, this.head.length)));
    const tail = decode(this.tail.subarray(safeCutIndex(this.tail, Math.max(this.tail.length - this.tailCap, 0))));
    return `${head}${TRUNCATION_MARKER}${tail}`;
  }
}
