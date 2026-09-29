/**
 * 会话 JSONL 追加流（05-database §4.1 / §4.3）。
 * - 写者唯一：句柄随单写者生命周期开启/关闭（finally 语义由 Storage.close 保证）；
 * - 普通行 write 即持久（不逐条 fsync，进程强杀下已 write 数据零丢失，NFR-7）；
 * - checkpoint 行 write 后追加 fsync，是唯一逐条同步的行（断电级持久点）；
 * - epoch 单调合并最小落地：append 拒绝 epoch 小于会话当前值的写入，被拒写入直接丢弃并计数。
 */
import { open, type FileHandle } from "node:fs/promises";
import { messageRecordSchema } from "@raincode/shared";
import type { MessageRecord } from "@raincode/shared";
import {
  JSONL_SCHEMA_VERSION,
  serializeLine,
  type CheckpointLine,
  type CheckpointState,
  type EventLine,
  type MessageLine,
} from "./jsonl-lines.js";

/** 普通行追加结果；rejected 为旧 epoch 写入（已丢弃并计数）。offset 为本行起始字节偏移。 */
export type AppendResult =
  | { accepted: true; seq: number; offset: number }
  | { accepted: false; reason: "stale-epoch" };

/** checkpoint 追加结果；lineStartOffset 即 sessions.checkpoint_offset（行起始偏移），pos 为行尾偏移。 */
export type CheckpointResult =
  | { accepted: true; seq: number; lineStartOffset: number; pos: number; epoch: number }
  | { accepted: false; reason: "stale-epoch" };

export interface SessionStreamOptions {
  /** 重开时由尾部扫描给出的续写行号（缺省 0，新建流）。 */
  lastSeq?: number;
  /** epoch 守卫基准：max(库内 sessions.epoch, 文件内最近 checkpoint epoch)。 */
  epoch?: number;
}

export class SessionStream {
  /** 以追加模式持有句柄；文件不存在则创建（createSession 已写头行，此处为兜底）。 */
  static async open(eventsFile: string, options: SessionStreamOptions = {}): Promise<SessionStream> {
    const handle = await open(eventsFile, "a");
    const stat = await handle.stat();
    return new SessionStream(handle, stat.size, options.lastSeq ?? 0, options.epoch ?? 0);
  }

  private constructor(
    private readonly handle: FileHandle,
    private size: number,
    private lastSeq: number,
    private currentEpoch: number,
  ) {
    this.rejectedWrites = 0;
  }

  /** 旧 epoch 被拒写入计数（05 §4.3 第 5 点：丢弃并计数）。 */
  rejectedWrites: number;

  get byteLength(): number {
    return this.size;
  }

  get epoch(): number {
    return this.currentEpoch;
  }

  get seq(): number {
    return this.lastSeq;
  }

  async appendMessage(message: MessageRecord, options: { epoch?: number } = {}): Promise<AppendResult> {
    const validated = messageRecordSchema.parse(message); // 出口即合法（04 §4.3 同构约束）
    const line: MessageLine = {
      v: JSONL_SCHEMA_VERSION,
      type: "message",
      seq: this.lastSeq + 1,
      ts: Date.now(),
      message: validated,
    };
    return this.append(line, options.epoch);
  }

  async appendEvent(name: string, payload: unknown, options: { epoch?: number } = {}): Promise<AppendResult> {
    const line: EventLine = {
      v: JSONL_SCHEMA_VERSION,
      type: "event",
      seq: this.lastSeq + 1,
      ts: Date.now(),
      name,
      payload,
    };
    return this.append(line, options.epoch);
  }

  /**
   * 追加 checkpoint 行（seq 占用 + fsync）。
   * pos = 本行写入后的文件字节数（含换行）；pos 自身位数影响行长，定点迭代至收敛。
   * epoch 缺省取当前代次；显式传入更高值（如 compact 提交 epoch+1）时提升当前代次。
   */
  async writeCheckpoint(state: CheckpointState, options: { epoch?: number } = {}): Promise<CheckpointResult> {
    const epoch = options.epoch ?? this.currentEpoch;
    if (epoch < this.currentEpoch) {
      this.rejectedWrites += 1;
      return { accepted: false, reason: "stale-epoch" };
    }
    const seq = this.lastSeq + 1;
    const ts = Date.now();
    const lineStart = this.size;

    let pos = lineStart;
    let text = "";
    for (let i = 0; i < 8; i++) {
      const line: CheckpointLine = { v: JSONL_SCHEMA_VERSION, type: "checkpoint", seq, ts, epoch, pos, state };
      text = serializeLine(line);
      const next = lineStart + Buffer.byteLength(text, "utf8") + 1; // +1 换行
      if (next === pos) {
        break;
      }
      pos = next;
    }

    const bytes = Buffer.from(text + "\n", "utf8");
    await this.handle.write(bytes);
    this.size += bytes.byteLength;
    this.lastSeq = seq;
    if (epoch > this.currentEpoch) {
      this.currentEpoch = epoch;
    }
    await this.handle.sync(); // 断电级持久点（05 §4.3 第 3 点）
    return { accepted: true, seq, lineStartOffset: lineStart, pos, epoch };
  }

  async close(): Promise<void> {
    await this.handle.close();
  }

  private async append(line: MessageLine | EventLine, epoch: number | undefined): Promise<AppendResult> {
    if (epoch !== undefined && epoch < this.currentEpoch) {
      this.rejectedWrites += 1;
      return { accepted: false, reason: "stale-epoch" };
    }
    const text = serializeLine(line);
    const bytes = Buffer.from(text + "\n", "utf8");
    const offset = this.size;
    await this.handle.write(bytes);
    this.size += bytes.byteLength;
    this.lastSeq = line.seq;
    if (epoch !== undefined && epoch > this.currentEpoch) {
      this.currentEpoch = epoch;
    }
    return { accepted: true, seq: line.seq, offset };
  }
}
