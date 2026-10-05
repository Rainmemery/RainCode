/**
 * compaction.pruned 重放单测（T5.4）：replaySessionFile 全量重放遇剪枝事件行时，
 * 按 sourceMessageId 回指定位原文并以内联 prunedContent 替换（resume/回放与内存一致）——
 * - 正常回指替换（id 定位、其余消息不动、事件行进 events）；
 * - 宽松校验：缺字段/非法值/原文不可定位逐项忽略，不中断重放；
 * - 与 full compact 标记（compaction.applied）先后重放一致：剪枝不增删消息，位置截断计数不受影响。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { COMPACTION_EVENT_NAME, COMPACTION_PRUNED_EVENT_NAME, JSONL_SCHEMA_VERSION, serializeLine } from "../src/index.js";
import { replaySessionFile } from "../src/jsonl-resume.js";
import type { MessageRecord } from "@raincode/shared";

const dirs: string[] = [];
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const TS = 1769587200000;

function messageLine(seq: number, message: MessageRecord): string {
  return serializeLine({ v: JSONL_SCHEMA_VERSION, type: "message", seq, ts: TS + seq, message });
}

function eventLine(seq: number, name: string, payload: unknown): string {
  return serializeLine({ v: JSONL_SCHEMA_VERSION, type: "event", seq, ts: TS + seq, name, payload });
}

async function writeEventsFile(lines: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "raincode-prune-replay-"));
  dirs.push(dir);
  const file = join(dir, "events.jsonl");
  await writeFile(file, `${lines.join("\n")}\n`, "utf8");
  return file;
}

const userMessage: MessageRecord = { id: "m1", role: "user", content: "帮我读取配置" };
const toolMessage: MessageRecord = { id: "m2", role: "tool", toolCallId: "tc1", content: "x".repeat(9000) };
const userMessage2: MessageRecord = { id: "m3", role: "user", content: "继续" };
const prunedContent = "HEAD[... 中段已预剪枝（microcompact）...]TAIL";

function prunedEvent(seq: number, overrides: Record<string, unknown> = {}): string {
  return eventLine(seq, COMPACTION_PRUNED_EVENT_NAME, {
    prunerId: "mc_test",
    epoch: 0,
    replacements: [
      {
        sourceMessageId: "m2",
        toolCallId: "tc1",
        toolName: "read",
        charsBefore: 9000,
        charsAfter: prunedContent.length,
        prunedContent,
      },
    ],
    charsRemoved: 9000 - prunedContent.length,
    tokensSaved: 1000,
    tokensBefore: 3000,
    ...overrides,
  });
}

describe("compaction.pruned 重放（T5.4 resume/回放一致）", () => {
  it("按 sourceMessageId 回指替换：tool 消息内容替换为 prunedContent，其余消息不动", async () => {
    const file = await writeEventsFile([
      messageLine(1, userMessage),
      messageLine(2, toolMessage),
      prunedEvent(3),
      messageLine(4, userMessage2),
    ]);
    const replay = await replaySessionFile(file, { includeHistory: true });
    assert.equal(replay.history.length, 3, "剪枝不增删消息");
    assert.equal(replay.history[0]!.content, "帮我读取配置");
    assert.equal(replay.history[1]!.id, "m2");
    assert.equal(replay.history[1]!.content, prunedContent);
    assert.equal(replay.history[2]!.content, "继续");
    assert.ok(replay.events.some((event) => event.name === COMPACTION_PRUNED_EVENT_NAME));
  });

  it("宽松校验：缺字段/非法值/原文不可定位逐项忽略，不中断重放", async () => {
    const file = await writeEventsFile([
      messageLine(1, userMessage),
      messageLine(2, toolMessage),
      eventLine(3, COMPACTION_PRUNED_EVENT_NAME, { prunerId: "mc_x" }), // replacements 缺失
      eventLine(4, COMPACTION_PRUNED_EVENT_NAME, { replacements: "not-array" }), // 非数组
      eventLine(5, COMPACTION_PRUNED_EVENT_NAME, { replacements: [{ sourceMessageId: "m2" }] }), // 缺 prunedContent
      eventLine(6, COMPACTION_PRUNED_EVENT_NAME, { replacements: [{ prunedContent: "y" }] }), // 缺 sourceMessageId
      eventLine(7, COMPACTION_PRUNED_EVENT_NAME, { replacements: [{ sourceMessageId: "m_missing", prunedContent: "y" }] }), // 原文不可定位
      eventLine(8, COMPACTION_PRUNED_EVENT_NAME, { replacements: [{ sourceMessageId: 42, prunedContent: "y" }] }), // 类型非法
      messageLine(9, userMessage2),
    ]);
    const replay = await replaySessionFile(file, { includeHistory: true });
    assert.equal(replay.history.length, 3);
    assert.equal(replay.history[1]!.content, "x".repeat(9000), "全部条目忽略，原文保留");
    assert.equal(replay.history[2]!.content, "继续");
  });

  it("与 full compact 标记先后重放一致：剪枝只换内容，summarizedCount 位置截断不受影响", async () => {
    // 真实时序：触发 turn 的用户输入（m3）先于剪枝事件与压缩标记落盘（边界在输入落库之后）
    const m3: MessageRecord = { id: "m3", role: "user", content: "继续" };
    const m4: MessageRecord = { id: "m4", role: "assistant", content: "压缩窗口期回复" };
    const file = await writeEventsFile([
      messageLine(1, userMessage),
      messageLine(2, toolMessage),
      messageLine(3, m3),
      prunedEvent(4),
      eventLine(5, COMPACTION_EVENT_NAME, {
        compactionId: "cp_test",
        epoch: 1,
        summary: "此前历史摘要",
        summarizedCount: 2, // 触发时被摘要前缀 = [m1, m2（已剪枝）]；保留区 [m3]
      }),
      messageLine(6, m4),
    ]);
    const replay = await replaySessionFile(file, { includeHistory: true });
    assert.equal(replay.history.length, 3, "摘要替换 [m1, m2) + 保留区 m3 + 窗口期 m4");
    assert.equal(replay.history[0]!.id, "msg_compact_cp_test");
    assert.equal(replay.history[1]!.id, "m3");
    assert.equal(replay.history[2]!.id, "m4");
  });
});
