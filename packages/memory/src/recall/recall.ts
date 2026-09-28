/**
 * 按需召回（02 §7.3 search；05 §5.4 召回语义）：
 * - query 按 code point 数 ≥3 → 先 FTS trigram phrase 查询（bm25 排序，05 §5.4 第一条 SQL）；
 * - FTS 空结果或 <3 字符 → LIKE 兜底（lastSeenAt DESC，05 §5.4 第二条 SQL）；
 * - 无结果返回空数组，不注入占位文本（02 §7.4）。
 * 两条路径都在 repo 层强制 workspaceId 过滤 + 召回默认集（active + confidence≥0.6）。
 */
import type { MemoryEntry, MemoryKind } from "@novacode/shared";
import type { MemoryRepo } from "@novacode/storage";

export interface SearchEntriesOptions {
  kind?: MemoryKind;
  limit?: number;
}

/** FTS match 串安全化：整串包双引号作为 phrase 查询，内部引号双写转义（防 FTS5 语法注入）。 */
function toFtsPhraseQuery(query: string): string {
  return `"${query.replaceAll('"', '""')}"`;
}

/** 召回入口：FTS 优先、LIKE 兜底（limit 缺省 10，02 §7.3 search.opts）。 */
export async function searchEntries(
  repo: MemoryRepo,
  input: { workspaceId: string; query: string } & SearchEntriesOptions,
): Promise<MemoryEntry[]> {
  const limit = input.limit ?? 10;
  if (Array.from(input.query).length >= 3) {
    const hits = await repo.searchFts(input.workspaceId, toFtsPhraseQuery(input.query), input.kind, limit);
    if (hits.length > 0) {
      return hits;
    }
  }
  return repo.searchLike(input.workspaceId, input.query, input.kind, limit);
}
