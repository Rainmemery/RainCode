/**
 * LoopEvents flush-then-close 复现回归（T4.2，legacy-items L-06）。
 * 复现原缺陷（PROGRESS §4 2026-09-29）：CLI run 回合收尾——done/phase 事件发布（同步）后
 * 持有方立即关库，serialWrite 队列中迟到的持久化任务撞上已关闭的流 → EBADF / 丢事件。
 * 修复语义两层：flush() 排空单写者链后再 close（零告警零丢失）；未 flush 即 close 时
 * Storage 栅栏将竞态产物转为类型化 STORAGE_CLOSED 告警（响亮可诊，不 EBADF 不静默）。
 * 用真实 Storage（临时 dataRoot）驱动 appendEvent 全链路；flush 契约 = 生产方停发后调用。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { LoopEvents } from "../src/index.js";
import { Storage, StorageError } from "@raincode/storage";

describe("LoopEvents flush-then-close（T4.2 / L-06）", () => {
  const dirs: string[] = [];
  after(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  interface Harness {
    storage: Storage;
    eventsFile: string;
    sessionId: string;
    diags: Array<{ message: string; err: unknown }>;
    makeEvents: () => LoopEvents;
  }

  async function setup(): Promise<Harness> {
    const dataRoot = await mkdtemp(join(tmpdir(), "raincode-loopflush-"));
    dirs.push(dataRoot);
    const storage = await Storage.open({ dataRoot });
    const ws = await storage.ensureWorkspace(dataRoot);
    const meta = await storage.createSession({ workspaceHash: ws.hash, title: "t4.2" });
    const eventsFile = await storage.sessionEventsFile(meta.id);
    const diags: Array<{ message: string; err: unknown }> = [];
    const makeEvents = () =>
      new LoopEvents({
        sessionId: meta.id,
        storage, // 结构化满足 StoragePort（appendMessage/appendEvent/writeCheckpoint）
        publish: () => {},
        onDiagnostic: (message, err) => diags.push({ message, err }),
      }, 1); // 头行占 seq 1（与 createSessionLoop / 子会话同口径）
    return { storage, eventsFile, sessionId: meta.id, diags, makeEvents };
  }

  it("emit 后立即 flush→close：全部事件落盘、seq 连续、零 diag（修复路径）", async () => {
    const h = await setup();
    const events = h.makeEvents();
    // 复现窗口：发布即返回（写链在途），「迟到的 phase 变更」即原缺陷主角
    events.emitTurnPhaseChanged("turn_1", "ModelRequest", "ToolExecution");
    events.emitDone("turn_1", { outcome: "completed", rounds: 1 });
    events.emitTurnPhaseChanged("turn_1", "ToolExecution", "TurnComplete");
    await events.flush();
    await h.storage.close();
    assert.equal(h.diags.length, 0, `不应有任何持久化告警：${JSON.stringify(h.diags)}`);
    const rows = (await readFile(h.eventsFile, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { seq: number; name: string });
    assert.deepEqual(
      rows.filter((r) => r.seq > 1).map((r) => r.name),
      ["turn.phase_changed", "done", "turn.phase_changed"],
      "迟到的 phase_changed 不得丢失",
    );
    assert.deepEqual(rows.map((r) => r.seq), [1, 2, 3, 4], "seq 连续无重号");
  });

  it("flush 幂等：空闲链上重复调用立即收敛", async () => {
    const h = await setup();
    const events = h.makeEvents();
    events.emitDone("turn_2", { outcome: "completed" });
    await events.flush();
    await Promise.all([events.flush(), events.flush()]);
    await h.storage.close();
    assert.equal(h.diags.length, 0);
  });

  it("未 flush 即 close（旧缺陷路径）：队尾任务被 STORAGE_CLOSED 栅栏拒绝并告警（不 EBADF 不静默）", async () => {
    const h = await setup();
    const events = h.makeEvents();
    events.emitDone("turn_3", { outcome: "completed" });
    await h.storage.close(); // 未 flush——close 先行设置栅栏
    await new Promise((resolve) => setImmediate(resolve)); // 让写链任务执行
    assert.equal(h.diags.length, 1, "应产恰好一条 failed-to-persist 告警");
    assert.ok(h.diags[0]!.message.includes("failed to persist event"), h.diags[0]!.message);
    assert.ok(h.diags[0]!.err instanceof StorageError, "拒绝应为类型化 StorageError");
    assert.equal((h.diags[0]!.err as StorageError).code, "STORAGE_CLOSED", "不应是 EBADF");
  });
});
