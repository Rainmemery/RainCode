/**
 * SessionStream 关闭排空与栅栏 + Storage.close 幂等单测（T4.2，legacy-items L-06 复现回归）。
 * 覆盖：
 * - close 排空在途写：未 await 的 append 与 close 并发（复现 CLI run 回合收尾的 close 窗口），
 *   全部落盘且 seq 唯一递增（不 EBADF 不丢行）；
 * - close 后追加类型化拒绝 STORAGE_CLOSED（旧行为经 openSessionStream 重开句柄泄漏）；
 * - close 幂等（重复调用复用同一 promise）；
 * - 并发 append 不重号（流内单写者链独立保证，不依赖调用方串行）；
 * - Storage.close 后 appendEvent 经 openSessionStream 栅栏同码拒绝 + Storage.close 幂等。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { SessionStream, Storage, StorageError } from "../src/index.js";

describe("SessionStream close 排空与栅栏（T4.2）", () => {
  const dirs: string[] = [];
  after(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  async function tempStream(): Promise<{ file: string; stream: SessionStream }> {
    const dir = await mkdtemp(join(tmpdir(), "raincode-stream-"));
    dirs.push(dir);
    const file = join(dir, "events.jsonl");
    const stream = await SessionStream.open(file);
    return { file, stream };
  }

  it("close 排空在途写：未 await 的 append 与 close 并发，全部落盘且 seq 唯一递增", async () => {
    const { file, stream } = await tempStream();
    const pending = Promise.all([
      stream.appendEvent("turn.phase_changed", { i: 1 }),
      stream.appendEvent("message.completed", { i: 2 }),
      stream.appendEvent("done", { i: 3 }),
    ]);
    await stream.close(); // 与在途写并发发起（复现 close 窗口）
    const results = await pending;
    assert.ok(results.every((r) => r.accepted), "三个在途 append 都应成功");
    const rows = (await readFile(file, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { seq: number });
    assert.equal(rows.length, 3, "三行全部落盘（不丢行）");
    assert.deepEqual(rows.map((r) => r.seq), [1, 2, 3]);
  });

  it("close 后追加类型化拒绝 STORAGE_CLOSED（不 EBADF、不重开句柄）", async () => {
    const { file, stream } = await tempStream();
    await stream.appendEvent("a", {});
    await stream.close();
    await assert.rejects(
      stream.appendEvent("b", {}),
      (err: unknown) => err instanceof StorageError && err.code === "STORAGE_CLOSED",
    );
    const rows = (await readFile(file, "utf8")).trim().split("\n");
    assert.equal(rows.length, 1, "close 后无新增行");
  });

  it("close 幂等：重复调用复用同一 promise，不抛 EBADF", async () => {
    const { stream } = await tempStream();
    const p1 = stream.close();
    const p2 = stream.close();
    assert.equal(p1, p2);
    await Promise.all([p1, p2]);
  });

  it("并发 append 不重号：N 个未 await 的 append seq 严格递增", async () => {
    const { stream } = await tempStream();
    const pending = Promise.all(Array.from({ length: 8 }, (_, i) => stream.appendEvent(`e${i}`, { i })));
    await stream.close();
    const results = await pending;
    const seqs: number[] = [];
    for (const r of results) {
      if (!r.accepted) assert.fail(`append 不应被拒：${JSON.stringify(r)}`);
      seqs.push(r.seq);
    }
    assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe("Storage close 栅栏与幂等（T4.2）", () => {
  const dirs: string[] = [];
  after(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  it("Storage.close 后 appendEvent 经 openSessionStream 栅栏拒绝 STORAGE_CLOSED", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "raincode-storage-close-"));
    dirs.push(dataRoot);
    const storage = await Storage.open({ dataRoot });
    const ws = await storage.ensureWorkspace(dataRoot);
    const meta = await storage.createSession({ workspaceHash: ws.hash, title: "t4.2" });
    await storage.appendEvent(meta.id, "before-close", {});
    await storage.close();
    await assert.rejects(
      storage.appendEvent(meta.id, "after-close", {}),
      (err: unknown) => err instanceof StorageError && err.code === "STORAGE_CLOSED",
    );
  });

  it("Storage.close 幂等：重复调用不抛错", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "raincode-storage-close2-"));
    dirs.push(dataRoot);
    const storage = await Storage.open({ dataRoot });
    await storage.close();
    await storage.close();
  });
});
