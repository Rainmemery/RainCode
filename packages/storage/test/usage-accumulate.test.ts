/**
 * sessions-repo accumulateUsage 原子累计单测（T4.5 回归：turns_count 此前恒为 0——
 * CLI「turns N」/ 桌面「N 轮」/ session.usage.turnsCount 读数失真）。
 * 覆盖：token 累计 + turns_count 同语句自增（completed turn 每回合恰一次 recordUsage）。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Storage } from "../src/index.js";

describe("sessions accumulateUsage（T4.5 turns_count 回归）", () => {
  const dirs: string[] = [];
  after(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  it("token 累计且 turns_count 同语句自增（并发语义保持 SQL 侧原子）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "raincode-usage-"));
    dirs.push(dir);
    const storage = await Storage.open(dir);
    try {
      const ws = await storage.ensureWorkspace(dir);
      const session = await storage.createSession({ workspaceHash: ws.hash, title: "usage-regression" });
      assert.equal(session.turnsCount, 0, "初始 turns_count 为 0");
      await storage.sessions.accumulateUsage(session.id, 20, 8);
      await storage.sessions.accumulateUsage(session.id, 30, 12);
      const meta = await storage.sessions.get(session.id);
      assert.ok(meta !== undefined);
      assert.equal(meta.inputTokens, 50, "inputTokens 累计");
      assert.equal(meta.outputTokens, 20, "outputTokens 累计");
      assert.equal(meta.turnsCount, 2, "turns_count 每回合自增一次");
    } finally {
      await storage.close();
    }
  });
});
