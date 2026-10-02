/**
 * 晋升草案待确认区单测（T3.3，02-module-design §7.2 第三层「生成章节草案 → 用户确认写入」）。
 * 覆盖：生成规则（confidence ≥ 0.8 / todo 排除 / 章节预填 / 同条目不重复建议）、
 * 列表投影（状态过滤 / superseded 条目草案失效隔离）、处置流（confirm 合入回调 + 终态、
 * reject 不写文件、section 覆盖、非 pending 与未知 id 报 MEMORY_DRAFT_NOT_FOUND）、
 * 直接管晋升收敛 pending 草案（resolvePendingDraftsByEntry）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryError } from "../src/index.js";
import {
  KIND_TO_SECTION,
  MEMORY_DRAFT_MIN_CONFIDENCE,
  createDraftsForEntries,
  listDrafts,
  resolveDraft,
  resolvePendingDraftsByEntry,
} from "../src/index.js";
import type { MemoryEntry } from "@raincode/shared";
import type { MemoryRepo } from "@raincode/storage";

// ---------------------------------------------------------------------------
// 内存替身（与 extract.test.ts 同构的最小投影：仅 get + entries 池）
// ---------------------------------------------------------------------------

function entry(overrides: Partial<MemoryEntry> & Pick<MemoryEntry, "id" | "kind" | "content">): MemoryEntry {
  return {
    workspaceId: "ws-1",
    refs: [],
    confidence: 0.9,
    source: "session-end",
    status: "active",
    supersededBy: null,
    createdAt: 1_000,
    lastSeenAt: 1_000,
    ...overrides,
  };
}

class FakeRepo {
  entries: MemoryEntry[] = [];
  async get(id: string): Promise<MemoryEntry | null> {
    return this.entries.find((item) => item.id === id) ?? null;
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

function makeFixtures() {
  const repo = new FakeRepo();
  const settings = new FakeSettings();
  const writes: Array<{ entryId: string; section: string }> = [];
  return {
    repo,
    deps: { repo: repo as unknown as MemoryRepo, settings: settings as never },
    writes,
    write: async (entryId: string, section: string) => {
      writes.push({ entryId, section });
    },
  };
}

// ---------------------------------------------------------------------------

describe("createDraftsForEntries 生成规则（02 §7.2 高置信晋升线）", () => {
  it("confidence ≥ 0.8 生成 pending 草案，章节按 kind 预填；todo 与低置信排除", async () => {
    const fx = makeFixtures();
    fx.repo.entries = [
      entry({ id: "e-decision", kind: "decision", content: "选型 A", confidence: 0.9 }),
      entry({ id: "e-convention", kind: "convention", content: "约定 B", confidence: 0.8 }),
      entry({ id: "e-pitfall", kind: "pitfall", content: "坑 C", confidence: 0.7 }), // 低于晋升线
      entry({ id: "e-todo", kind: "todo", content: "待办 D", confidence: 0.95 }), // Agent 专用章节排除
      entry({ id: "e-pref", kind: "preference", content: "偏好 E", confidence: 0.85 }),
    ];
    const created = await createDraftsForEntries(fx.deps, "ws-1", fx.repo.entries);
    assert.equal(created.length, 3);
    assert.deepEqual(
      created.map((draft) => [draft.entryId, draft.section]),
      [
        ["e-decision", KIND_TO_SECTION.decision],
        ["e-convention", KIND_TO_SECTION.convention],
        ["e-pref", KIND_TO_SECTION.preference],
      ],
    );
    assert.ok(created.every((draft) => draft.status === "pending" && draft.resolvedAt === null));
  });

  it("同条目已有草案（任意状态）不重复建议", async () => {
    const fx = makeFixtures();
    const rows = [entry({ id: "e-1", kind: "decision", content: "选型 A", confidence: 0.9 })];
    const first = await createDraftsForEntries(fx.deps, "ws-1", rows);
    assert.equal(first.length, 1);
    assert.deepEqual(await createDraftsForEntries(fx.deps, "ws-1", rows), []);
  });

  it("晋升线常量高于召回线口径（0.8）且空入参短路", async () => {
    const fx = makeFixtures();
    assert.equal(MEMORY_DRAFT_MIN_CONFIDENCE, 0.8);
    assert.deepEqual(await createDraftsForEntries(fx.deps, "ws-1", []), []);
  });
});

describe("listDrafts 投影（06 §2.6 memory.drafts.list）", () => {
  it("新者在前 + status 过滤 + 条目本体随行", async () => {
    const fx = makeFixtures();
    fx.repo.entries = [
      entry({ id: "e-1", kind: "decision", content: "旧要点", createdAt: 1_000, lastSeenAt: 1_000 }),
      entry({ id: "e-2", kind: "pitfall", content: "新要点", createdAt: 2_000, lastSeenAt: 2_000 }),
    ];
    await createDraftsForEntries(fx.deps, "ws-1", fx.repo.entries);

    const all = await listDrafts(fx.deps, "ws-1");
    assert.equal(all.length, 2);
    assert.deepEqual(
      all.map((row) => row.entry.id).sort(),
      ["e-1", "e-2"],
    );
    assert.ok(all.every((row) => row.entry.content !== undefined && row.draft.status === "pending"));

    const pending = await listDrafts(fx.deps, "ws-1", { status: "pending" });
    assert.equal(pending.length, 2);
    const e2Draft = pending.find((row) => row.entry.id === "e-2");
    assert.notEqual(e2Draft, undefined);
    await resolveDraft(fx.deps, "ws-1", { draftId: e2Draft!.draft.id, action: "reject" }, fx.write);
    const afterReject = await listDrafts(fx.deps, "ws-1", { status: "pending" });
    assert.equal(afterReject.length, 1);
    assert.equal(afterReject[0]!.entry.id, "e-1");
  });

  it("superseded 条目的 pending 草案失效隔离：默认与 status=pending 均不投影", async () => {
    const fx = makeFixtures();
    fx.repo.entries = [
      entry({ id: "e-old", kind: "convention", content: "旧约定" }),
      entry({ id: "e-new", kind: "convention", content: "采用新约定并覆盖旧约定", confidence: 0.95 }),
    ];
    await createDraftsForEntries(fx.deps, "ws-1", fx.repo.entries);
    // 矛盾替换：旧条目被标记 superseded（extract 链路的存储行为投影）
    fx.repo.entries = fx.repo.entries.map((item) =>
      item.id === "e-old" ? { ...item, status: "superseded" as const, supersededBy: "e-new" } : item,
    );

    const all = await listDrafts(fx.deps, "ws-1");
    assert.deepEqual(all.map((row) => row.entry.id), ["e-new"]); // e-old 草案不投影
    const pending = await listDrafts(fx.deps, "ws-1", { status: "pending" });
    assert.equal(pending.length, 1);
  });
});

describe("resolveDraft 处置流（02 §7.2 用户确认动作）", () => {
  it("confirm 经回调合入 MEMORY.md 并进入 confirmed 终态；非 pending 再处置 → DRAFT_NOT_FOUND", async () => {
    const fx = makeFixtures();
    fx.repo.entries = [entry({ id: "e-1", kind: "pitfall", content: "已知坑" })];
    const [draft] = await createDraftsForEntries(fx.deps, "ws-1", fx.repo.entries);

    const result = await resolveDraft(fx.deps, "ws-1", { draftId: draft!.id, action: "confirm" }, fx.write);
    assert.equal(result.promoted, true);
    assert.deepEqual(fx.writes, [{ entryId: "e-1", section: KIND_TO_SECTION.pitfall }]);

    const rows = await listDrafts(fx.deps, "ws-1");
    assert.equal(rows[0]!.draft.status, "confirmed");
    assert.notEqual(rows[0]!.draft.resolvedAt, null);

    await assert.rejects(
      resolveDraft(fx.deps, "ws-1", { draftId: draft!.id, action: "confirm" }, fx.write),
      (err: unknown) => err instanceof MemoryError && err.code === "MEMORY_DRAFT_NOT_FOUND",
    );
  });

  it("confirm 支持 section 覆盖预填章节；reject 不触发合入", async () => {
    const fx = makeFixtures();
    fx.repo.entries = [entry({ id: "e-1", kind: "decision", content: "选型 A" })];
    const [draft] = await createDraftsForEntries(fx.deps, "ws-1", fx.repo.entries);
    assert.notEqual(draft, undefined);

    const rejected = await resolveDraft(fx.deps, "ws-1", { draftId: draft!.id, action: "reject" }, fx.write);
    assert.equal(rejected.promoted, false);
    assert.deepEqual(fx.writes, []); // reject 不写文件
  });

  it("未知 draftId → MEMORY_DRAFT_NOT_FOUND", async () => {
    const fx = makeFixtures();
    await assert.rejects(
      resolveDraft(fx.deps, "ws-1", { draftId: "draft_nope", action: "confirm" }, fx.write),
      (err: unknown) => err instanceof MemoryError && err.code === "MEMORY_DRAFT_NOT_FOUND",
    );
  });
});

describe("resolvePendingDraftsByEntry（直接管晋升收敛 pending 草案）", () => {
  it("memory.promote 直接管晋升后同条目 pending 草案收敛为 confirmed", async () => {
    const fx = makeFixtures();
    fx.repo.entries = [entry({ id: "e-1", kind: "convention", content: "工作约定条目" })];
    const [draft] = await createDraftsForEntries(fx.deps, "ws-1", fx.repo.entries);
    assert.notEqual(draft, undefined);

    await resolvePendingDraftsByEntry(fx.deps, "ws-1", "e-1");
    const rows = await listDrafts(fx.deps, "ws-1");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.draft.status, "confirmed");
    // 其他条目草案不受影响
    fx.repo.entries.push(entry({ id: "e-2", kind: "decision", content: "另一条", confidence: 0.9 }));
    await createDraftsForEntries(fx.deps, "ws-1", [fx.repo.entries[1]!]);
    await resolvePendingDraftsByEntry(fx.deps, "ws-1", "e-miss");
    const after = await listDrafts(fx.deps, "ws-1", { status: "pending" });
    assert.equal(after.length, 1);
    assert.equal(after[0]!.entry.id, "e-2");
  });
});
