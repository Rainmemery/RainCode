/**
 * T6.2 会话录制回放 lane 共享库：录制工具（scripts/record-replay-fixture.mts）与
 * 重放 harness（replay-lane.test.ts）共用同一断言实现，保证录制期 fail-fast 与
 * CI 回归判定同口径。
 *
 * 断言集（07 §12.2 T6.2 验收）：
 * - 凭据扫描（04 §5.3 口径，fail-closed）：会话流内不得出现 API key / Bearer /
 *   凭据类 env 赋值 / JWT 形态字串；
 * - 双路重放收敛：tail-scan（或 full-replay）路径与 recorded O(1) 定位路径对同一
 *   events.jsonl 产出逐字段一致（除 source 外 deepEqual）；
 * - 确定性：同路径复跑产出完全一致（重放为纯读，无时钟/随机依赖）；
 * - 投影一致：重放 history 与录制期原会话终态（幂等 resume 快照的全量内存历史）
 *   逐字段一致；崩溃种子场景额外断言悬挂 tool_call 合成与半行截尾计数。
 */
import { deepEqual, equal, ok } from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { MessageRecord } from "@raincode/shared";
import { replaySessionFile } from "../src/jsonl-resume.js";
import type { ResumeReplay } from "../src/jsonl-resume.js";

/** fixture 根目录（本文件位于 packages/storage/test/，fixture 在 test/fixtures/replay/）。 */
export const REPLAY_FIXTURE_ROOT = fileURLToPath(new URL("./fixtures/replay/", import.meta.url));

/** expected.json 形态：录制期原会话终态 + 崩溃种子申报（仅 crash 场景）。 */
export interface ReplayFixtureExpected {
  scenario: string;
  recordedAt: string;
  description: string;
  /** 原会话终态全量消息（录制期幂等 session.resume 快照的 messages 投影）。 */
  messages: MessageRecord[];
  /** 崩溃种子申报：录制后经文件级注入的悬挂 assistant 消息与半行截尾。 */
  seeded?: {
    assistantMessageId: string;
    danglingToolCallId: string;
    truncatedTail: boolean;
  };
}

/** 凭据形态字串（04 §5.3：明文 key 与凭据类 env 值绝不写入会话 JSONL）。 */
const CREDENTIAL_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "openai-style api key", pattern: /sk-[A-Za-z0-9_-]{8,}/ },
  { name: "bearer token", pattern: /Bearer\s+[A-Za-z0-9._-]+/i },
  { name: "credential json field", pattern: /"(?:apiKey|api_key|secretAccessKey|password|Authorization)"\s*:\s*"/i },
  { name: "credential env assignment", pattern: /RAINCODE_(?:PROVIDER_API_KEY|WEB_TOKEN)\s*[:=]\s*\S/ },
  { name: "jwt-shaped token", pattern: /eyJ[A-Za-z0-9_-]{20,}/ },
];

/** fail-closed 凭据扫描：命中即抛错（录制工具拒绝落盘、CI 拒绝 fixture）。 */
export function assertCredentialFree(raw: string, label: string): void {
  for (const { name, pattern } of CREDENTIAL_PATTERNS) {
    const hit = raw.match(pattern);
    ok(hit === null, `${label}: 疑似凭据泄漏（${name}）：${JSON.stringify(hit?.[0]?.slice(0, 24) ?? "")}`);
  }
}

/** 列出全部 fixture 场景目录名（字典序）。 */
export async function listFixtureScenarios(): Promise<string[]> {
  const entries = await readdir(REPLAY_FIXTURE_ROOT, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

export async function loadExpected(scenario: string): Promise<ReplayFixtureExpected> {
  const raw = await readFile(join(REPLAY_FIXTURE_ROOT, scenario, "expected.json"), "utf8");
  return JSON.parse(raw) as ReplayFixtureExpected;
}

export async function loadEventsBytes(scenario: string): Promise<Buffer> {
  return readFile(join(REPLAY_FIXTURE_ROOT, scenario, "events.jsonl"));
}

/** 双路可比投影：排除 source（入口路径不同是断言前提），其余字段必须逐字段一致。 */
function comparableProjection(replay: ResumeReplay): unknown {
  return {
    epoch: replay.epoch,
    checkpoint: replay.checkpoint,
    messages: replay.messages,
    history: replay.history,
    events: replay.events,
    synthesizedToolResults: replay.synthesizedToolResults,
    danglingTailLines: replay.danglingTailLines,
    messageCount: replay.messageCount,
  };
}

/**
 * 单 fixture 独立验证（纯文件层，不依赖 DB）：凭据扫描 + 确定性（同路复跑）+ 双路收敛 +
 * 投影一致（expected.messages 对齐重放 history；seeded 场景追加悬挂断言）。
 * 返回两次重放结果供 DB 级用例交叉核对。
 */
export async function verifyFixtureStandalone(
  eventsFile: string,
  expected: ReplayFixtureExpected,
): Promise<{ tailScan: ResumeReplay; recorded: ResumeReplay }> {
  const raw = await readFile(eventsFile, "utf8");
  assertCredentialFree(raw, `fixture ${expected.scenario}`);

  // 确定性：同参数复跑必须完全一致（重放为纯读）
  const run1 = await replaySessionFile(eventsFile, { includeHistory: true });
  const run2 = await replaySessionFile(eventsFile, { includeHistory: true });
  deepEqual(run2, run1, "同路复跑不一致：重放非确定性");

  // 双路收敛：自动定位路径 vs recorded O(1) 路径
  ok(run1.checkpoint !== null, "fixture 必须含至少一条完整 checkpoint 行（recorded 路径前提）");
  const tailScan = run1;
  const recorded = await replaySessionFile(eventsFile, {
    includeHistory: true,
    checkpointOffset: tailScan.checkpoint!.offset,
    epoch: tailScan.epoch,
  });
  equal(recorded.source, "recorded", "传入 checkpoint_offset + epoch 应命中 recorded 路径");
  deepEqual(comparableProjection(recorded), comparableProjection(tailScan), "双路重放产出不一致");

  // 投影一致：重放 history ↔ 原会话终态
  if (expected.seeded) {
    equal(tailScan.history.length, expected.messages.length + 1, "种子场景 history = 原会话消息 + 1 条悬挂 assistant");
    deepEqual(tailScan.history.slice(0, -1), expected.messages);
    equal(tailScan.history.at(-1)!.id, expected.seeded.assistantMessageId, "悬挂 assistant 消息位于流尾");
    equal(tailScan.synthesizedToolResults.length, 1, "悬挂 tool_call 恰合成一条恢复结果");
    equal(tailScan.synthesizedToolResults[0]!.toolCallId, expected.seeded.danglingToolCallId);
    equal(tailScan.synthesizedToolResults[0]!.isError, true);
    equal(tailScan.synthesizedToolResults[0]!.content, "进程中断，结果丢失");
    if (expected.seeded.truncatedTail) {
      equal(tailScan.danglingTailLines, 1, "半行截尾在修复前计为 1 条损坏行");
    }
  } else {
    equal(tailScan.synthesizedToolResults.length, 0, "干净会话无悬挂 tool_call");
    deepEqual(tailScan.history, expected.messages, "重放 history 与原会话终态不一致");
    equal(tailScan.messageCount, expected.messages.length, "无压缩场景 messageCount 应与消息总数对账一致");
  }
  return { tailScan, recorded };
}
