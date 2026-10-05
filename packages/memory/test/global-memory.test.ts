/**
 * 全局记忆层单测（T5.3 双层注入的文件面）：
 * - 缺失 → {content:"", exists:false}（无模板骨架，注入侧整块跳过）；
 * - 文件存在 → 原文读回 exists:true；
 * - 空白文件（仅空白字符）→ exists:false（注入侧跳过）；
 * - globalMemoryPath 落位：数据根直下 MEMORY.md（05 §2.1）。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { globalMemoryPath, loadGlobalMemory } from "../src/index.js";

describe("loadGlobalMemory（T5.3 全局记忆层）", () => {
  const dirs: string[] = [];
  after(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  async function tempRoot(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "raincode-globalmem-"));
    dirs.push(dir);
    return dir;
  }

  it("缺失 → exists:false，无模板骨架", async () => {
    const root = await tempRoot();
    assert.deepEqual(await loadGlobalMemory(root), { content: "", exists: false });
  });

  it("存在 → 原文读回；路径落位数据根直下", async () => {
    const root = await tempRoot();
    await writeFile(globalMemoryPath(root), "# 全局约定\n\n回复使用中文\n", "utf8");
    const snap = await loadGlobalMemory(root);
    assert.equal(snap.exists, true);
    assert.ok(snap.content.includes("# 全局约定"));
    assert.ok(snap.content.includes("回复使用中文"));
    assert.equal(globalMemoryPath(root), join(root, "MEMORY.md"));
  });

  it("空白文件 → exists:false（注入侧整块跳过）", async () => {
    const root = await tempRoot();
    await mkdir(root, { recursive: true });
    await writeFile(globalMemoryPath(root), "   \n\n  ", "utf8");
    assert.deepEqual(await loadGlobalMemory(root), { content: "   \n\n  ", exists: false });
  });
});
