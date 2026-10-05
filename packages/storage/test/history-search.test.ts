/**
 * 会话历史检索单测（T5.3，05-database §3.12/§5.4）：
 * - part 级索引语义：文本块 + tool_call 名入索引；tool_result 正文 / reasoning 不入（02 §7 口径）；
 * - 中英文 trigram 检索 + workspace 隔离（跨项目不串味）；
 * - phrase 转义：查询含引号 / FTS5 语法字面量按字面量匹配不抛错；
 * - 相对分数地板：OR 多词召回下 3x 过取样 + |bm25| ≥ top×0.15 裁剪（超长弱相关文档被截掉）；
 * - versioned 增量迁移：追加增量续扫不重复、INDEX_VERSION 漂移整会话重扫不重复、
 *   进度损坏自 0 重扫、半行尾不推进偏移且补齐后恰好索引一次；
 * - LIKE 兜底：短查询（<3 code point）走 LIKE（score null）。
 */
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Storage } from "../src/index.js";
import type { MessageRecord } from "@raincode/shared";

describe("HistorySearchRepo（T5.3 会话历史检索）", () => {
  let dataRoot: string;
  let storage: Storage;
  let wsMain: string;
  let wsMainHash: string;
  let s1: string;
  const cleanup: string[] = [];

  before(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "raincode-histsearch-"));
    cleanup.push(dataRoot);
    storage = await Storage.open({ dataRoot });
    wsMain = join(dataRoot, "ws-main");
    wsMainHash = (await storage.ensureWorkspace(wsMain)).hash;
    s1 = await storage.createSession({ workspaceHash: wsMainHash, title: "main" }).then((m) => m.id);
    await seed(s1, [
      { id: "m1", role: "user", content: "修复 renderer 冷启动问题" },
      { id: "m2", role: "assistant", content: "采用 pnpm workspace 管理 monorepo" },
      {
        id: "m3",
        role: "assistant",
        content: [{ type: "tool_call", toolCallId: "c1", name: "bash", arguments: { command: "pnpm test" } }],
      },
      {
        id: "m4",
        role: "assistant",
        reasoning: "机密推理过程XYZZY",
        content: [
          { type: "text", text: "正常文本结论" },
          { type: "tool_result", toolUseId: "c1", content: "工具输出 secretOUTPUT", isError: false },
        ],
      },
    ]);
  });

  after(async () => {
    await storage.close();
    for (const dir of cleanup) await rm(dir, { recursive: true, force: true });
  });

  async function seed(sessionId: string, messages: MessageRecord[]): Promise<void> {
    for (const message of messages) {
      await storage.appendMessage(sessionId, message);
    }
  }

  it("中英文 part 级检索：文本块 / 工具名命中", async () => {
    const zh = await storage.searchHistory(wsMainHash, "冷启动");
    assert.ok(zh.some((h) => h.sessionId === s1 && h.kind === "text" && h.role === "user"), "中文子串命中");
    const en = await storage.searchHistory(wsMainHash, "pnpm");
    assert.ok(en.some((h) => h.content.includes("pnpm")), "英文命中");
    const tool = await storage.searchHistory(wsMainHash, "bash");
    assert.ok(tool.some((h) => h.kind === "tool" && h.content === "bash"), "工具名命中（part 级）");
  });

  it("tool_result 正文与 reasoning 不入索引（02 §7 口径）", async () => {
    assert.deepEqual(await storage.searchHistory(wsMainHash, "secretOUTPUT"), [], "工具输出不入索引");
    assert.deepEqual(await storage.searchHistory(wsMainHash, "XYZZY"), [], "reasoning 不入索引");
    assert.ok((await storage.searchHistory(wsMainHash, "正常文本结论")).length === 1, "文本块入索引");
  });

  it("workspace 隔离：跨项目不串味", async () => {
    const wsOther = join(dataRoot, "ws-other");
    const otherHash = (await storage.ensureWorkspace(wsOther)).hash;
    const s2 = await storage.createSession({ workspaceHash: otherHash, title: "other" }).then((m) => m.id);
    await seed(s2, [{ id: "n1", role: "user", content: "另一个项目的冷启动记录" }]);
    const hits = await storage.searchHistory(wsMainHash, "冷启动");
    assert.ok(hits.every((h) => h.sessionId === s1), "只返回本 workspace 会话");
    assert.ok(hits.length === 1, "不串味");
  });

  it("phrase 转义：查询含引号 / FTS5 语法字面量按字面量匹配不抛错", async () => {
    await seed(s1, [
      { id: "m5", role: "user", content: '查询 a" OR b 语法' },
      { id: "m6", role: "user", content: "定位 NEAR(x y) 表达式" },
    ]);
    const quoted = await storage.searchHistory(wsMainHash, 'a" OR b');
    assert.ok(quoted.some((h) => h.content.includes('a" OR b')), '引号按字面量匹配');
    const near = await storage.searchHistory(wsMainHash, "NEAR(x y)");
    assert.ok(near.some((h) => h.content.includes("NEAR(x y)")), "FTS5 语法字面量匹配");
  });

  it("相对分数地板：超长弱相关文档被 top×0.15 裁剪", async () => {
    const wsFloor = join(dataRoot, "ws-floor");
    const floorHash = (await storage.ensureWorkspace(wsFloor)).hash;
    const sFloor = await storage.createSession({ workspaceHash: floorHash, title: "floor" }).then((m) => m.id);
    await seed(sFloor, [
      { id: "f1", role: "user", content: "renderer 冷启动问题修复方案讨论" },
      { id: "f2", role: "assistant", content: `renderer ${"zzz ".repeat(8000)}` },
    ]);
    const hits = await storage.searchHistory(floorHash, "renderer 冷启动");
    assert.ok(hits.length === 1, `仅保留紧致强相关命中，实得 ${String(hits.length)}`);
    assert.equal(hits[0]!.score, 1, "top 命中相对分 1.0");
    assert.ok(hits[0]!.content.includes("冷启动"), "保留的是强相关文档");
  });

  it("versioned 增量迁移：追加续扫不重复", async () => {
    const s3 = await storage.createSession({ workspaceHash: wsMainHash, title: "incr" }).then((m) => m.id);
    await seed(s3, [{ id: "i1", role: "user", content: "第一版本文本AAA" }]);
    assert.ok((await storage.searchHistory(wsMainHash, "AAA")).length >= 1, "首次检索回填命中");
    const baseCount = await storage.history.partCount(s3);
    assert.equal(baseCount, 1);

    await seed(s3, [{ id: "i2", role: "user", content: "第二版本文本BBB" }]);
    assert.ok((await storage.searchHistory(wsMainHash, "BBB")).some((h) => h.sessionId === s3), "增量续扫命中新文本");
    assert.equal(await storage.history.partCount(s3), 2, "增量无重复");
    assert.ok((await storage.searchHistory(wsMainHash, "AAA")).length >= 1, "旧命中仍在");
  });

  it("INDEX_VERSION 漂移 → 整会话重扫不重复；进度损坏自 0 重扫", async () => {
    const s4 = await storage.createSession({ workspaceHash: wsMainHash, title: "ver" }).then((m) => m.id);
    await seed(s4, [
      { id: "v1", role: "user", content: "重扫样本文本CCC" },
      { id: "v2", role: "user", content: "重扫样本文本DDD" },
    ]);
    await storage.searchHistory(wsMainHash, "CCC");
    assert.equal(await storage.history.partCount(s4), 2);

    // 手写进度行模拟版本漂移（offset 也故意越过 EOF → 重扫钳制自 0）
    await storage.settings.set(`history.idx.${s4}`, JSON.stringify({ v: 99, offset: 999999 }));
    assert.ok((await storage.searchHistory(wsMainHash, "DDD")).some((h) => h.sessionId === s4));
    assert.equal(await storage.history.partCount(s4), 2, "重扫幂等无重复");

    await storage.settings.set(`history.idx.${s4}`, "not-json{{{");
    assert.ok((await storage.searchHistory(wsMainHash, "CCC")).some((h) => h.sessionId === s4));
    assert.equal(await storage.history.partCount(s4), 2, "损坏进度重扫幂等");
  });

  it("半行尾不推进偏移：补齐后恰好索引一次（多字节安全）", async () => {
    const s5 = await storage.createSession({ workspaceHash: wsMainHash, title: "tail" }).then((m) => m.id);
    await seed(s5, [{ id: "t1", role: "user", content: "完行文本EEE" }]);
    await storage.searchHistory(wsMainHash, "EEE");
    const eventsFile = await storage.sessionEventsFile(s5);

    // 手工追加半行（无换行收尾，含多字节中文）：不应被索引、偏移不推进
    appendFileSync(eventsFile, '{"v":1,"type":"message","seq":90,"ts":1,"message":{"id":"t9","role":"user","content":"半行文本FFF",', "utf8");
    assert.deepEqual(await storage.searchHistory(wsMainHash, "半行文本FFF"), [], "半行不索引");
    const countBefore = await storage.history.partCount(s5);

    appendFileSync(eventsFile, '"ok":true}}\n', "utf8");
    const hits = await storage.searchHistory(wsMainHash, "半行文本FFF");
    assert.ok(hits.some((h) => h.sessionId === s5), "补齐后命中");
    assert.equal(await storage.history.partCount(s5), countBefore + 1, "恰好索引一次");
  });

  it("LIKE 兜底：短查询（<3 code point）score null；空查询空结果", async () => {
    const like = await storage.searchHistory(wsMainHash, "冷");
    assert.ok(like.some((h) => h.content.includes("冷启动")), "LIKE 兜底命中");
    assert.equal(like[0]!.score, null, "LIKE 命中无相对分");
    assert.deepEqual(await storage.searchHistory(wsMainHash, "   "), [], "空白查询空数组");
  });

  it("excludeSessionId：当前会话排除（session_search 自指噪声防线）", async () => {
    const withCurrent = await storage.searchHistory(wsMainHash, "冷启动");
    assert.ok(withCurrent.length >= 1, "不含排除时命中");
    const excluded = await storage.searchHistory(wsMainHash, "冷启动", { excludeSessionId: s1 });
    assert.ok(excluded.every((h) => h.sessionId !== s1), "FTS 路径排除当前会话");
    const likeExcluded = await storage.searchHistory(wsMainHash, "冷", { excludeSessionId: s1 });
    assert.ok(likeExcluded.every((h) => h.sessionId !== s1), "LIKE 路径排除当前会话");
  });
});
