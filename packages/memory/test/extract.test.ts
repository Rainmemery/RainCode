/**
 * 会话记忆抽取单测（T3.3 验收项：抽取幂等 / 去重 / 矛盾标记，02-module-design §7.4）。
 * 覆盖：settings 幂等键（同会话只抽一次、失败不写键可重试）、归一化精确去重 touch、
 * 同 kind 互含矛盾判定（新强 supersede 旧者 / 旧强丢弃新者）、候选清洗
 * （kind 校验 / 空内容 / confidence 截断夹取 / 200 字截断 / 缺省 0.8）。
 * MemoryRepo / SettingsRepo 以内存替身注入（行为与 SQL 语义对齐，不落盘）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractFromSession, normalizeMemoryContent } from "../src/index.js";
import type { ExtractedCandidate, MemoryExtractPort } from "../src/index.js";
import type { MemoryEntry } from "@raincode/shared";
import type { MemoryRepo, NewMemoryEntry } from "@raincode/storage";

// ---------------------------------------------------------------------------
// 内存替身：MemoryRepo（findByContent/findSimilar/insert/supersede/touch/get）
// ---------------------------------------------------------------------------

class FakeMemoryRepo {
  entries: MemoryEntry[] = [];
  touched: Array<{ id: string; at: number }> = [];
  private seq = 0;

  private make(entry: NewMemoryEntry, ts: number): MemoryEntry {
    this.seq += 1;
    return {
      id: `entry_test_${String(this.seq).padStart(4, "0")}`,
      workspaceId: entry.workspaceId,
      kind: entry.kind,
      content: entry.content,
      refs: entry.refs ?? [],
      confidence: entry.confidence ?? 1.0,
      source: entry.source,
      status: "active",
      supersededBy: null,
      createdAt: ts,
      lastSeenAt: ts,
    };
  }

  async insert(entry: NewMemoryEntry): Promise<MemoryEntry> {
    const created = this.make(entry, entry.ts ?? Date.now());
    this.entries.push(created);
    return created;
  }

  async get(id: string): Promise<MemoryEntry | null> {
    return this.entries.find((entry) => entry.id === id) ?? null;
  }

  async touch(id: string, lastSeenAt: number): Promise<void> {
    const entry = this.entries.find((item) => item.id === id);
    if (entry !== undefined) {
      entry.lastSeenAt = lastSeenAt;
    }
    this.touched.push({ id, at: lastSeenAt });
  }

  async supersede(oldId: string, byId: string): Promise<void> {
    const entry = this.entries.find((item) => item.id === oldId);
    if (entry !== undefined) {
      entry.status = "superseded";
      entry.supersededBy = byId;
    }
  }

  async findByContent(workspaceId: string, normalizedContent: string): Promise<MemoryEntry | null> {
    return (
      this.entries.find(
        (entry) => entry.workspaceId === workspaceId && normalizeMemoryContent(entry.content) === normalizedContent,
      ) ?? null
    );
  }

  async findSimilar(workspaceId: string, kind: MemoryEntry["kind"], _content: string): Promise<MemoryEntry[]> {
    // SQL 粗筛的同域近似：同 workspace 同 kind 的 active 条目全量交出，互含精判在 extract 内
    return this.entries.filter(
      (entry) => entry.workspaceId === workspaceId && entry.kind === kind && entry.status === "active",
    );
  }
}

class FakeSettings {
  private map = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
}

function portWith(candidates: ExtractedCandidate[] | null): MemoryExtractPort {
  return { async extract() { return candidates; } };
}

const TRANSCRIPT = [{ role: "user" as const, content: "把要点抽出来" }];

function baseInput(overrides: Partial<Parameters<typeof extractFromSession>[1]> = {}) {
  return {
    sessionId: "sess-1",
    workspaceId: "ws-1",
    transcript: TRANSCRIPT,
    source: "session-end" as const,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe("extractFromSession 幂等（05 §5.4 settings 键）", () => {
  it("同会话二次抽取返回 [] 且不重复落盘", async () => {
    const repo = new FakeMemoryRepo();
    const settings = new FakeSettings();
    const port = portWith([
      { kind: "decision", content: "采用 pnpm workspace 管理依赖" },
      { kind: "convention", content: "提交信息使用 conventional commits" },
    ]);
    const deps = { repo: repo as unknown as MemoryRepo, settings: settings as never, extractPort: port };

    const first = await extractFromSession(deps, baseInput());
    assert.equal(first.length, 2);
    const second = await extractFromSession(deps, baseInput());
    assert.deepEqual(second, []);
    assert.equal(repo.entries.length, 2);
  });

  it("抽取失败（port → null）不写幂等键，下个周期可重试", async () => {
    const repo = new FakeMemoryRepo();
    const settings = new FakeSettings();
    const deps = {
      repo: repo as unknown as MemoryRepo,
      settings: settings as never,
      extractPort: portWith(null),
    };

    assert.deepEqual(await extractFromSession(deps, baseInput()), []);
    deps.extractPort = portWith([{ kind: "pitfall", content: "Windows 路径大小写不敏感" }]);
    const retried = await extractFromSession(deps, baseInput());
    assert.equal(retried.length, 1);
    assert.equal(repo.entries.length, 1);
  });

  it("无有效落盘（候选全被清洗）不写幂等键", async () => {
    const repo = new FakeMemoryRepo();
    const settings = new FakeSettings();
    const deps = {
      repo: repo as unknown as MemoryRepo,
      settings: settings as never,
      // 全部候选非法 → 无落盘 → 键不写 → 换合法候选后同会话仍可抽
      extractPort: portWith([{ kind: "unknown-kind" as never, content: "x" }]),
    };

    assert.deepEqual(await extractFromSession(deps, baseInput()), []);
    deps.extractPort = portWith([{ kind: "decision", content: "合法要点" }]);
    assert.equal((await extractFromSession(deps, baseInput())).length, 1);
  });
});

describe("extractFromSession 去重与矛盾（02 §7.4）", () => {
  it("归一化后完全相等 → touch 旧条目不新插", async () => {
    const repo = new FakeMemoryRepo();
    const deps = {
      repo: repo as unknown as MemoryRepo,
      settings: new FakeSettings() as never,
      extractPort: portWith([{ kind: "decision", content: "采用 pnpm workspace 管理依赖", confidence: 0.9 }]),
    };
    const [first] = await extractFromSession(deps, baseInput());
    assert.ok(first);

    deps.extractPort = portWith([
      { kind: "decision", content: "  采用 pnpm  workspace   管理依赖 \n", confidence: 0.5 },
    ]);
    const second = await extractFromSession(deps, baseInput({ sessionId: "sess-2" }));
    assert.deepEqual(second, []); // touch 不计入返回
    assert.equal(repo.entries.length, 1);
    assert.deepEqual(repo.touched.map((row) => row.id), [first!.id]);
  });

  it("同 kind 互含且新者置信更高 → 插入新条目并 supersede 全部旧者", async () => {
    const repo = new FakeMemoryRepo();
    const deps = {
      repo: repo as unknown as MemoryRepo,
      settings: new FakeSettings() as never,
      extractPort: portWith([{ kind: "convention", content: "pnpm workspace", confidence: 0.7 }]),
    };
    const [old] = await extractFromSession(deps, baseInput());
    assert.ok(old);

    deps.extractPort = portWith([
      { kind: "convention", content: "采用 pnpm workspace 管理本仓库全部依赖", confidence: 0.95 },
    ]);
    const inserted = await extractFromSession(deps, baseInput({ sessionId: "sess-2" }));
    assert.equal(inserted.length, 1);
    assert.equal(repo.entries.length, 2);
    assert.equal(old!.status, "superseded");
    assert.equal(old!.supersededBy, inserted[0]!.id);
  });

  it("同 kind 互含但存在置信更高的旧者 → 丢弃新条目、touch 最高置信旧者", async () => {
    const repo = new FakeMemoryRepo();
    const deps = {
      repo: repo as unknown as MemoryRepo,
      settings: new FakeSettings() as never,
      extractPort: portWith([{ kind: "pitfall", content: "Windows 下 rename 可能 EPERM", confidence: 0.95 }]),
    };
    const [old] = await extractFromSession(deps, baseInput());
    assert.ok(old);

    deps.extractPort = portWith([
      { kind: "pitfall", content: "Windows 下 rename 可能 EPERM 导致写入失败", confidence: 0.8 },
    ]);
    const inserted = await extractFromSession(deps, baseInput({ sessionId: "sess-2" }));
    assert.deepEqual(inserted, []);
    assert.equal(repo.entries.length, 1);
    assert.equal(old!.status, "active");
    assert.deepEqual(repo.touched.map((row) => row.id), [old!.id]); // touch 即「新者保留」
  });
});

describe("extractFromSession 候选清洗（LLM 产出不可信）", () => {
  it("kind 非法 / 空内容丢弃；confidence 夹取 [0,1]；缺省 0.8；超长截断 200 字", async () => {
    const repo = new FakeMemoryRepo();
    const deps = {
      repo: repo as unknown as MemoryRepo,
      settings: new FakeSettings() as never,
      extractPort: portWith([
        { kind: "nope" as never, content: "非法 kind" },
        { kind: "decision", content: "   " },
        { kind: "preference", content: "回答使用中文", confidence: 7 },
        { kind: "todo", content: "补齐回归基线" },
        { kind: "pitfall", content: "很".repeat(500), confidence: -3 },
      ]),
    };

    const inserted = await extractFromSession(deps, baseInput());
    assert.equal(inserted.length, 3);
    const byKind = new Map(inserted.map((entry) => [entry.kind, entry]));
    assert.equal(byKind.get("preference")!.confidence, 1); // 7 → 1
    assert.equal(byKind.get("todo")!.confidence, 0.8); // 缺省
    assert.equal(byKind.get("pitfall")!.confidence, 0); // -3 → 0
    assert.equal(Array.from(byKind.get("pitfall")!.content).length, 200);
  });
});
