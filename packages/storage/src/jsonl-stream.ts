/**
 * 会话 JSONL 追加流（05-database §4.1 / §4.3）。
 * - 写者唯一：句柄随单写者生命周期开启/关闭；流内经单写者链串行，close 排空在途写后
 *   才释放句柄（T4.2：close 感知 pending 写——在途 write 与 handle.close 并发会 EBADF，
 *   甚至 fd 复用错写他文件）；
 * - close 后到达的追加以 STORAGE_CLOSED 类型化错误拒绝（不再重开文件句柄——旧行为会在
 *   close 窗口经 openSessionStream 重开流，句柄泄漏且写入落在关闭之后）；
 * - 普通行 write 即持久（不逐条 fsync，进程强杀下已 write 数据零丢失，NFR-7）；
 * - checkpoint 行 write 后追加 fsync，是唯一逐条同步的行（断电级持久点）；
 * - epoch 单调合并最小落地：append 拒绝 epoch 小于会话当前值的写入，被拒写入直接丢弃并计数。
 */
import { open, type FileHandle } from "node:fs/promises";
import { messageRecordSchema } from "@raincode/shared";
import type { MessageRecord } from "@raincode/shared";
import { StorageError } from "./errors.js";
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

  /** 流内单写者链：seq 分配与句柄写入同链串行，close 经同链排空（T4.2）。 */
  private writeTail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private closePromise: Promise<void> | null = null;

  get byteLength(): number {
    return this.size;
  }

  get epoch(): number {
    return this.currentEpoch;
  }

  get seq(): number {
    return this.lastSeq;
  }

  appendMessage(message: MessageRecord, options: { epoch?: number } = {}): Promise<AppendResult> {
    const validated = messageRecordSchema.parse(message); // 出口即合法（04 §4.3 同构约束）
    return this.enqueue(() => {
      const line: MessageLine = {
        v: JSONL_SCHEMA_VERSION,
        type: "message",
        seq: this.lastSeq + 1,
        ts: Date.now(),
        message: validated,
      };
      return this.append(line, options.epoch);
    });
  }

  appendEvent(name: string, payload: unknown, options: { epoch?: number } = {}): Promise<AppendResult> {
    return this.enqueue(() => {
      const line: EventLine = {
        v: JSONL_SCHEMA_VERSION,
        type: "event",
        seq: this.lastSeq + 1,
        ts: Date.now(),
        name,
        payload,
      };
      return this.append(line, options.epoch);
    });
  }

  /**
   * 追加 checkpoint 行（seq 占用 + fsync）。
   * pos = 本行写入后的文件字节数（含换行）；pos 自身位数影响行长，定点迭代至收敛。
   * epoch 缺省取当前代次；显式传入更高值（如 compact 提交 epoch+1）时提升当前代次。
   */
  writeCheckpoint(state: CheckpointState, options: { epoch?: number } = {}): Promise<CheckpointResult> {
    return this.enqueue(() => this.writeCheckpointLocked(state, options.epoch));
  }

  /** 关闭流：先设拒绝栅栏，再经单写者链排空在途写，最后释放句柄（幂等，重复调用复用同一 promise）。 */
  close(): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      await this.writeTail;
      await this.handle.close();
    })();
    return this.closePromise;
  }

  /** 全部句柄操作经单写者链；close 后到达的写入类型化拒绝（不重开句柄，T4.2）。 */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    if (this.closed) {
      return Promise.reject(new StorageError("STORAGE_CLOSED", "session stream is closed"));
    }
    const run = this.writeTail.then(task, task);
    this.writeTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async writeCheckpointLocked(
    state: CheckpointState,
    epochOverride: number | undefined,
  ): Promise<CheckpointResult> {
    const epoch = epochOverride ?? this.currentEpoch;
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
