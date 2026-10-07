/**
 * T6.2 会话录制回放 lane（07 §12.2）：真实录制 events.jsonl fixture 的重放断言 harness。
 *
 * - 全集独立验证（replay-lane-lib 同一实现，录制工具录制期 fail-fast 用同一口径）：
 *   凭据扫描（04 §5.3）+ 确定性（同路复跑一致）+ 双路重放收敛（tail-scan vs recorded O(1)）
 *   + 投影一致（重放 history ↔ 录制期原会话终态逐字段）；
 * - DB 级 resume：fixture 字节经真实 Storage.resumeSession 两次冷恢复收敛 + 对账回写
 *   （checkpoint_offset / epoch / message_count，05 §4.4 第 6 步）；
 * - 崩溃种子 fixture：残尾修复（05 §4.5）后重放干净、悬挂 tool_call 合成保持（§4.4）。
 * 断言操作全部发生在临时副本，绝不改写已归档 fixture 字节。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Storage, repairDanglingTail, replaySessionFile, sessionPaths } from "../src/index.js";
import {
  listFixtureScenarios,
  loadEventsBytes,
  loadExpected,
  verifyFixtureStandalone,
} from "./replay-lane-lib.js";

const dirs: string[] = [];
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

describe("T6.2 会话录制回放 lane", () => {
  it("录制 fixture 全集：凭据扫描 + 确定性 + 双路重放收敛 + 投影逐字段一致", async () => {
    const scenarios = await listFixtureScenarios();
    assert.ok(scenarios.length >= 3, `验收要求 ≥3 个录制 fixture，实际 ${String(scenarios.length)} 个`);
    for (const scenario of scenarios) {
      const expected = await loadExpected(scenario);
      const eventsFile = join(await stagingDir(scenario), "events.jsonl");
      await writeFile(eventsFile, await loadEventsBytes(scenario));
      await verifyFixtureStandalone(eventsFile, expected);
    }
  });

  it("DB 级 resume：fixture 经 Storage.resumeSession 两次冷恢复收敛 + 对账回写", async () => {
    for (const scenario of await listFixtureScenarios()) {
      const expected = await loadExpected(scenario);
      const home = await stagingDir(scenario);
      const storage = await Storage.open({ dataRoot: home });
      try {
        const workspace = await storage.ensureWorkspace(join(home, "ws"));
        const meta = await storage.createSession({ workspaceHash: workspace.hash, title: `replay-lane-${scenario}` });
        const paths = sessionPaths(storage.dataRoot, workspace.hash, meta.id);
        await mkdir(paths.dir, { recursive: true });
        await writeFile(paths.eventsFile, await loadEventsBytes(scenario)); // fixture 字节覆盖自动头行

        const first = await storage.resumeSession(meta.id);
        const second = await storage.resumeSession(meta.id);
        assert.equal(second.source, "recorded", `${scenario}: 二次 resume 应命中 checkpoint_offset O(1) 定位`);
        // 两次冷恢复的重建投影逐字段一致（source/sessionId 为入口差异，不入比较）
        const comparable = (replay: typeof first) => ({
          epoch: replay.epoch,
          checkpoint: replay.checkpoint,
          messages: replay.messages,
          history: replay.history,
          events: replay.events,
          synthesizedToolResults: replay.synthesizedToolResults,
          danglingTailLines: replay.danglingTailLines,
          messageCount: replay.messageCount,
        });
        assert.deepEqual(comparable(second), comparable(first), `${scenario}: 两次 resume 重建不一致`);

        // 投影一致（对齐独立验证的同一 expected 口径）
        if (expected.seeded) {
          assert.equal(first.history.length, expected.messages.length + 1, `${scenario}: 种子悬挂行入重建`);
          assert.deepEqual(first.history.slice(0, -1), expected.messages);
          assert.equal(first.history.at(-1)!.id, expected.seeded.assistantMessageId);
        } else {
          assert.deepEqual(first.history, expected.messages, `${scenario}: 重放投影与原会话终态不一致`);
        }

        // 对账回写（05 §4.4 第 6 步）：checkpoint_offset / epoch / message_count
        const after = await storage.sessions.get(meta.id);
        assert.ok(after !== null);
        assert.equal(after.checkpointOffset, first.checkpoint?.offset ?? 0, `${scenario}: checkpoint_offset 回写`);
        assert.equal(after.epoch, first.epoch, `${scenario}: epoch 回写`);
        assert.equal(after.messageCount, first.messageCount, `${scenario}: message_count 回写`);
      } finally {
        await storage.close();
      }
    }
  });

  it("崩溃种子 fixture：残尾修复后重放干净且悬挂 tool_call 合成保持", async () => {
    const scenario = "crash-seed";
    const expected = await loadExpected(scenario);
    assert.ok(expected.seeded, "crash-seed fixture 必须申报种子悬挂");
    const stage = await stagingDir(scenario);
    const eventsFile = join(stage, "events.jsonl");
    await writeFile(eventsFile, await loadEventsBytes(scenario));

    const repaired = await repairDanglingTail(eventsFile);
    assert.equal(repaired, true, "半行截尾应触发修复");
    const siblings = await readdir(stage);
    assert.equal(siblings.filter((name) => name.startsWith("events.jsonl.tail-")).length, 1, "残尾另存 .tail-<ts> 副本恰一份");

    const replay = await replaySessionFile(eventsFile, { includeHistory: true });
    assert.equal(replay.danglingTailLines, 0, "修复后重放无损坏行");
    assert.equal(replay.synthesizedToolResults.length, 1, "悬挂 tool_call 是完整行，修复不吞掉合成");
    assert.equal(replay.synthesizedToolResults[0]!.toolCallId, expected.seeded.danglingToolCallId);
    assert.equal(replay.synthesizedToolResults[0]!.isError, true);
    assert.deepEqual(replay.history.slice(0, -1), expected.messages);
    assert.equal(replay.history.at(-1)!.id, expected.seeded.assistantMessageId);
  });
});

/** 每用例独立临时目录（fixture 字节副本的工作区，绝不触碰归档原件）。 */
async function stagingDir(scenario: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `raincode-replay-lane-${scenario}-`));
  dirs.push(dir);
  return dir;
}
