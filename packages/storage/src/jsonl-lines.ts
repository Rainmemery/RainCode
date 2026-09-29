/**
 * JSONL 行格式（05-database §4.2）。
 * 信封统一为 {v, type, seq, ts, ...}：v 为格式版本，seq 为会话内单调递增行号，ts 为 unix 毫秒。
 * 三类行：message（消息定稿）/ event（非消息类持久事件）/ checkpoint（派生快照，逐条 fsync）。
 * 流式 delta 不落盘（UI 瞬态，05 §4.2）。
 * 头行为 event 行 name="session.created"，payload 携带 schemaVersion + epoch（本波约定，
 * 作为 append 拒绝旧 epoch 的文件内基准之一，05 §4.3 第 5 点单调合并）。
 * 本模块只做信封解析与序列化，行内偏移/字节计算在 jsonl-resume（Buffer 层，多字节安全）。
 */
import { messageRecordSchema } from "@raincode/shared";
import type { CollaborationMode, MessageRecord, TodoItem, TokenUsage } from "@raincode/shared";

/** JSONL 格式版本（信封 v 字段）。 */
export const JSONL_SCHEMA_VERSION = 1;

/** 头行事件名（05 §4.2 示例首行）。 */
export const HEADER_EVENT_NAME = "session.created";

/** RAINCODE 版本（头行 payload.raincodeVersion，与包版本一致）。 */
export const RAINCODE_VERSION = "0.1.0";

export interface MessageLine {
  v: number;
  type: "message";
  seq: number;
  ts: number;
  message: MessageRecord;
}

export interface EventLine {
  v: number;
  type: "event";
  seq: number;
  ts: number;
  name: string;
  payload: unknown;
}

/** checkpoint.state：todo、协作模式等派生快照（05 §4.2 示例 + 02 §1.2.3）。 */
export interface CheckpointState {
  mode: CollaborationMode;
  todo: TodoItem[];
  messageCount: number;
  usage?: TokenUsage;
}

export interface CheckpointLine {
  v: number;
  type: "checkpoint";
  seq: number;
  ts: number;
  /** 压缩代次：append 拒绝 epoch 小于会话当前值的写入（02 §1.2.5 单调合并）。 */
  epoch: number;
  /** 该行写入后的文件字节数（= 下一条待写行偏移，05 §4.2 约定）。 */
  pos: number;
  state: CheckpointState;
}

export type JsonlLine = MessageLine | EventLine | CheckpointLine;

/**
 * 压缩提交标记（05 §4.2 event 行「压缩报告」的持久形态；02 §1.2.5）。
 * payload：{ compactionId, epoch, summary, summarizedCount, tokensBefore? }；
 * 重放语义（05 §4.4）：历史重建遇到该行时，以摘要消息替换其前 summarizedCount 条消息
 * （[0..summarizedCount) 为触发时被摘要的前缀，窗口期新增消息在其后，不受影响）。
 */
export const COMPACTION_EVENT_NAME = "compaction.applied";

export interface CompactionMarkerPayload {
  compactionId: string;
  epoch: number;
  summary: string;
  /** 触发时被摘要替换的历史前缀长度（成对安全调整后；重放按此截断）。 */
  summarizedCount: number;
  tokensBefore?: number;
}

/** 压缩摘要消息（内存提交与重放共用同一构造，保证两侧 id/内容一致）。 */
export function compactionSummaryRecord(marker: CompactionMarkerPayload): MessageRecord {
  return {
    id: `msg_compact_${marker.compactionId}`,
    role: "user",
    content: `[上下文压缩] 以下是此前会话历史的结构化摘要，后续对话以本摘要为早期上下文：\n${marker.summary}`,
  };
}

export function serializeLine(line: JsonlLine): string {
  return JSON.stringify(line);
}

export type ParsedLine = { ok: true; line: JsonlLine } | { ok: false; raw: string };

/**
 * 解析单行（宽松读、严格写）：信封字段类型校验 + message 行经 shared schema 校验；
 * 不认识的 v / type 视为损坏行返回 ok:false，由上层计数，不中断重放。
 */
export function parseLine(raw: string): ParsedLine {
  if (raw.length === 0) {
    return { ok: false, raw };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, raw };
  }
  if (typeof value !== "object" || value === null) {
    return { ok: false, raw };
  }
  const record = value as Record<string, unknown>;
  const seq = record["seq"];
  const ts = record["ts"];
  if (typeof seq !== "number" || typeof ts !== "number") {
    return { ok: false, raw };
  }
  switch (record["type"]) {
    case "message": {
      const parsed = messageRecordSchema.safeParse(record["message"]);
      if (!parsed.success) {
        return { ok: false, raw };
      }
      return { ok: true, line: { v: JSONL_SCHEMA_VERSION, type: "message", seq, ts, message: parsed.data } };
    }
    case "event": {
      const name = record["name"];
      if (typeof name !== "string") {
        return { ok: false, raw };
      }
      return { ok: true, line: { v: JSONL_SCHEMA_VERSION, type: "event", seq, ts, name, payload: record["payload"] } };
    }
    case "checkpoint": {
      const epoch = record["epoch"];
      const pos = record["pos"];
      const state = record["state"];
      if (typeof epoch !== "number" || typeof pos !== "number" || typeof state !== "object" || state === null) {
        return { ok: false, raw };
      }
      return {
        ok: true,
        line: { v: JSONL_SCHEMA_VERSION, type: "checkpoint", seq, ts, epoch, pos, state: state as CheckpointState },
      };
    }
    default:
      return { ok: false, raw };
  }
}
