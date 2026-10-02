/**
 * 晋升草案待确认区（02-module-design §7.2 第三层：记忆 Agent 循环「生成章节草案 → 用户确认写入」）。
 *
 * - 载体：settings KV（05 §3.11 运行期非配置状态，键 `memory.drafts.<workspaceId>` → JSON 数组），
 *   不为 memory_entries 发明字段（05 §5.1：晋升不改条目行）；草案是「建议」不是真源，可随时重建；
 * - 生成规则：抽取新落盘条目 confidence ≥ DRAFT_MIN_CONFIDENCE（高置信晋升线，高于召回线 0.6）
 *   且 kind ≠ todo（「当前进行」为 Agent 专用章节，循环已直写，无需晋升确认）→ pending 草案，
 *   章节按 KIND_TO_SECTION 预填（确认时可改）；
 * - 确认流：pending → confirm（合入 MEMORY.md，即 02 §7.2「用户确认」动作）/ reject（忽略）；
 *   用户经 memory.promote 直接管晋升某条目时，其 pending 草案同步收敛为 confirmed（不悬挂）；
 * - 失效隔离：条目被矛盾标记 superseded 后其 pending 草案视为过期，list 投影跳过（升位条目另有草案）。
 */
import { randomUUID } from "node:crypto";
import { memorySectionSchema } from "@raincode/shared";
import type { MemoryEntry, MemoryKind, MemorySection } from "@raincode/shared";
import type { MemoryRepo, SettingsRepo } from "@raincode/storage";
import { MemoryError } from "../errors.js";
import { MEMORY_ERROR_CODES } from "../errors.js";

/** 草案 settings 键前缀（按 workspace 分键，05 §5.4 KV 惯例同 memory.extracted.）。 */
export const MEMORY_DRAFTS_KEY_PREFIX = "memory.drafts.";

/** 高置信晋升线：抽取条目 confidence ≥ 此值才生成晋升草案（02 §7.2「高置信长期条目」）。 */
export const MEMORY_DRAFT_MIN_CONFIDENCE = 0.8;

/** 草案状态（pending 待确认；终态 confirmed/rejected 不可再变更）。 */
export type MemoryDraftStatus = "pending" | "confirmed" | "rejected";

export interface MemoryDraft {
  id: string;
  entryId: string;
  /** 建议合入的 MEMORY.md 章节（KIND_TO_SECTION 预填，确认时可覆盖）。 */
  section: MemorySection;
  status: MemoryDraftStatus;
  createdAt: number;
  /** 用户处置时间（pending 时为 null）。 */
  resolvedAt: number | null;
}

/** 草案投影：附带条目本体（UI 一次取全，免逐条 get 往返）。 */
export interface MemoryDraftWithEntry {
  draft: MemoryDraft;
  entry: MemoryEntry;
}

/** kind → 建议章节预填（02 §7.3 六章节语义对应）。 */
export const KIND_TO_SECTION: Readonly<Record<MemoryKind, MemorySection>> = {
  decision: "项目概览",
  convention: "工作约定",
  pitfall: "已知坑",
  preference: "工作约定",
  todo: "当前进行",
};

export interface DraftStoreDeps {
  repo: MemoryRepo;
  settings: SettingsRepo;
}

function draftsKey(workspaceId: string): string {
  return `${MEMORY_DRAFTS_KEY_PREFIX}${workspaceId}`;
}

function parseDrafts(raw: string | null): MemoryDraft[] {
  if (raw === null) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return []; // 载体损坏按空处理：草案是建议不是真源，重建成本低
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter((item): item is MemoryDraft => {
    if (typeof item !== "object" || item === null) {
      return false;
    }
    const record = item as Record<string, unknown>;
    return (
      typeof record["id"] === "string" &&
      typeof record["entryId"] === "string" &&
      memorySectionSchema.safeParse(record["section"]).success &&
      (record["status"] === "pending" || record["status"] === "confirmed" || record["status"] === "rejected") &&
      typeof record["createdAt"] === "number"
    );
  });
}

/**
 * 为新落盘条目生成晋升草案（抽取后调用；02 §7.2 LOOP → DRAFT）。
 * 规则：confidence ≥ 0.8 且 kind ≠ todo 且该条目无既有草案（任意状态，防重复建议）。
 * 返回本次新建草案。
 */
export async function createDraftsForEntries(
  deps: DraftStoreDeps,
  workspaceId: string,
  entries: MemoryEntry[],
): Promise<MemoryDraft[]> {
  if (entries.length === 0) {
    return [];
  }
  const key = draftsKey(workspaceId);
  const existing = parseDrafts(await deps.settings.get(key));
  const knownEntryIds = new Set(existing.map((draft) => draft.entryId));
  const created: MemoryDraft[] = [];
  for (const entry of entries) {
    if (entry.confidence < MEMORY_DRAFT_MIN_CONFIDENCE || entry.kind === "todo" || knownEntryIds.has(entry.id)) {
      continue;
    }
    const draft: MemoryDraft = {
      id: `draft_${randomUUID()}`,
      entryId: entry.id,
      section: KIND_TO_SECTION[entry.kind],
      status: "pending",
      createdAt: Date.now(),
      resolvedAt: null,
    };
    existing.push(draft);
    knownEntryIds.add(entry.id);
    created.push(draft);
  }
  if (created.length > 0) {
    await deps.settings.set(key, JSON.stringify(existing));
  }
  return created;
}

/** 草案列表（新者在前）；superseded 条目的 pending 草案视为过期不投影（失效隔离）。 */
export async function listDrafts(
  deps: DraftStoreDeps,
  workspaceId: string,
  filter: { status?: MemoryDraftStatus } = {},
): Promise<MemoryDraftWithEntry[]> {
  const drafts = parseDrafts(await deps.settings.get(draftsKey(workspaceId)));
  const projected: MemoryDraftWithEntry[] = [];
  for (const draft of [...drafts].sort((a, b) => b.createdAt - a.createdAt)) {
    if (filter.status !== undefined && draft.status !== filter.status) {
      continue;
    }
    const entry = await deps.repo.get(draft.entryId);
    if (entry === null) {
      continue; // 条目缺失（异常载体）：草案无意义，跳过
    }
    if (draft.status === "pending" && entry.status !== "active") {
      continue; // 矛盾被换：过期建议不投影（升位条目另有草案）
    }
    projected.push({ draft, entry });
  }
  return projected;
}

/**
 * 处置草案（02 §7.2 DRAFT -- 用户确认 --> MD）：confirm 经 write 回调合入 MEMORY.md
 * （回调 = ProjectMemoryService.promote 链），reject 仅标记。非 pending → MEMORY_DRAFT_NOT_FOUND。
 */
export async function resolveDraft(
  deps: DraftStoreDeps,
  workspaceId: string,
  input: {
    draftId: string;
    action: "confirm" | "reject";
    /** confirm 时覆盖建议章节（默认 KIND_TO_SECTION 预填值）。 */
    section?: MemorySection;
  },
  write: (entryId: string, section: MemorySection) => Promise<void>,
): Promise<{ draft: MemoryDraft; promoted: boolean }> {
  const key = draftsKey(workspaceId);
  const drafts = parseDrafts(await deps.settings.get(key));
  const index = drafts.findIndex((draft) => draft.id === input.draftId);
  if (index < 0 || drafts[index]!.status !== "pending") {
    throw new MemoryError(
      MEMORY_ERROR_CODES.DRAFT_NOT_FOUND,
      `memory draft not found or not pending: ${input.draftId}`,
    );
  }
  const draft = drafts[index]!;
  if (input.action === "confirm") {
    const section = input.section ?? draft.section;
    if (!memorySectionSchema.safeParse(section).success) {
      throw new MemoryError(MEMORY_ERROR_CODES.SECTION_FORBIDDEN, `invalid memory section: ${String(section)}`);
    }
    await write(draft.entryId, section);
    draft.status = "confirmed";
  } else {
    draft.status = "rejected";
  }
  draft.resolvedAt = Date.now();
  await deps.settings.set(key, JSON.stringify(drafts));
  return { draft, promoted: input.action === "confirm" };
}

/** 直接管晋升（memory.promote）后收敛该条目的 pending 草案为 confirmed（不悬挂过期建议）。 */
export async function resolvePendingDraftsByEntry(
  deps: DraftStoreDeps,
  workspaceId: string,
  entryId: string,
): Promise<void> {
  const key = draftsKey(workspaceId);
  const drafts = parseDrafts(await deps.settings.get(key));
  let changed = false;
  const now = Date.now();
  for (const draft of drafts) {
    if (draft.entryId === entryId && draft.status === "pending") {
      draft.status = "confirmed";
      draft.resolvedAt = now;
      changed = true;
    }
  }
  if (changed) {
    await deps.settings.set(key, JSON.stringify(drafts));
  }
}
