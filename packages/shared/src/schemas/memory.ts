import { z } from "zod";
import { pageParamsSchema } from "./common.js";

/**
 * memory 域（06-api-spec §2.6 / §4.3 段 6）：项目记忆系统（02-module-design §7）。
 * 区分「文件真源」（MEMORY.md，写受章节权限约束）与「条目库」（memory_entries，只读检索）。
 * 只放 schema、纯类型与常量，禁止业务行为（04 §2.4 铁律 2）。
 */

// ---------------------------------------------------------------------------
// 错误码常量（06 §4.3 段 6；域内 const 对象惯例同 PC_ERROR_CODES）
// ---------------------------------------------------------------------------

export const MEMORY_ERROR_CODES = {
  /** entryId 不存在（06 §4.3 MEMORY_ENTRY_NOT_FOUND）。 */
  ENTRY_NOT_FOUND: "MEMORY_ENTRY_NOT_FOUND",
  /** 试图写用户专属章节（02 §7.1 边界；06 §4.3 MEMORY_SECTION_FORBIDDEN）。 */
  SECTION_FORBIDDEN: "MEMORY_SECTION_FORBIDDEN",
  /** 并发修改检测，写入放弃（02 §7.4；06 §4.3 MEMORY_WRITE_CONFLICT）。 */
  WRITE_CONFLICT: "MEMORY_WRITE_CONFLICT",
} as const;
export type MemoryErrorCode = (typeof MEMORY_ERROR_CODES)[keyof typeof MEMORY_ERROR_CODES];

// ---------------------------------------------------------------------------
// 核心结构（02 §7.3 MemoryEntry / MemorySection；05 §3.9 CHECK 同枚举）
// ---------------------------------------------------------------------------

/** MEMORY.md 章节（02 §7.3 六章节模板）。 */
export const memorySectionSchema = z.enum([
  "项目概览",
  "技术栈与命令",
  "工作约定",
  "当前进行",
  "已知坑",
  "Agent 备忘",
]);
export type MemorySection = z.infer<typeof memorySectionSchema>;

/** Agent 专用可写章节（02 §7.1：用户章节的合入只能经 memory.promote 由用户确认触发）。 */
export const memoryAgentSectionSchema = z.enum(["工作约定", "当前进行"]);
export type MemoryAgentSection = z.infer<typeof memoryAgentSectionSchema>;

/** 条目类别（02 §7.3 kind；05 §3.9 CHECK 同枚举）。 */
export const memoryKindSchema = z.enum(["decision", "convention", "pitfall", "preference", "todo"]);
export type MemoryKind = z.infer<typeof memoryKindSchema>;

/** 条目来源（02 §7.3 source；05 §3.9 CHECK 同枚举）。 */
export const memorySourceSchema = z.enum(["session-end", "compact", "manual", "memory-agent"]);
export type MemorySource = z.infer<typeof memorySourceSchema>;

/** 条目状态（05 §3.9：矛盾条目旧者标记 superseded，不入召回）。 */
export const memoryEntryStatusSchema = z.enum(["active", "superseded"]);
export type MemoryEntryStatus = z.infer<typeof memoryEntryStatusSchema>;

/**
 * 会话记忆条目（02 §7.3 MemoryEntry；05 §3.9 memory_entries 投影）。
 * content 单句要点 ≤200 字；confidence < 0.6 不入召回默认集（02 §7.4 幻觉防线）。
 */
export const memoryEntrySchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  kind: memoryKindSchema,
  content: z.string().min(1).max(200),
  /** 关联文件路径 / 会话 id；缺省 []。 */
  refs: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
  source: memorySourceSchema,
  status: memoryEntryStatusSchema.default("active"),
  /** 矛盾条目旧者回链新者（02 §7.4；05 §3.9 superseded_by）。 */
  supersededBy: z.string().nullable().default(null),
  createdAt: z.number().int(),
  /** 重复确认时间（淘汰依据，02 §7.3）。 */
  lastSeenAt: z.number().int(),
});
export type MemoryEntry = z.infer<typeof memoryEntrySchema>;

// ---------------------------------------------------------------------------
// memory.read / memory.write（06 §2.6）
// ---------------------------------------------------------------------------

export const memoryReadParamsSchema = z.strictObject({
  workspaceRoot: z.string().min(1),
});
export type MemoryReadParams = z.infer<typeof memoryReadParamsSchema>;

export const memoryReadResultSchema = z.object({
  content: z.string(),
  exists: z.boolean(),
});
export type MemoryReadResult = z.infer<typeof memoryReadResultSchema>;

export const memoryWriteParamsSchema = z.strictObject({
  workspaceRoot: z.string().min(1),
  section: memoryAgentSectionSchema,
  content: z.string().min(1),
});
export type MemoryWriteParams = z.infer<typeof memoryWriteParamsSchema>;

export const memoryWriteResultSchema = z.object({
  updated: z.boolean(),
});
export type MemoryWriteResult = z.infer<typeof memoryWriteResultSchema>;

// ---------------------------------------------------------------------------
// memory.search（06 §2.6：关键词/标签检索；无结果返回空数组，不注入占位文本）
// ---------------------------------------------------------------------------

export const memorySearchParamsSchema = z.strictObject({
  query: z.string().min(1),
  kind: memoryKindSchema.optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
export type MemorySearchParams = z.infer<typeof memorySearchParamsSchema>;

export const memorySearchResultSchema = z.object({
  entries: z.array(memoryEntrySchema),
});
export type MemorySearchResult = z.infer<typeof memorySearchResultSchema>;

// ---------------------------------------------------------------------------
// memory.entries.list（06 §2.6：SQLite memory_entries 只读分页查询）
// ---------------------------------------------------------------------------

export const memoryEntriesListParamsSchema = z.strictObject({
  kind: memoryKindSchema.optional(),
  source: memorySourceSchema.optional(),
  /** lastSeenAt 起始（含）。 */
  since: z.number().int().optional(),
  page: pageParamsSchema.optional(),
});
export type MemoryEntriesListParams = z.infer<typeof memoryEntriesListParamsSchema>;

export const memoryEntriesListResultSchema = z.object({
  items: z.array(memoryEntrySchema),
  nextCursor: z.string().optional(),
});
export type MemoryEntriesListResult = z.infer<typeof memoryEntriesListResultSchema>;

// ---------------------------------------------------------------------------
// memory.promote（06 §2.6：调用本身即用户确认动作，三层单向晋升）
// ---------------------------------------------------------------------------

export const memoryPromoteParamsSchema = z.strictObject({
  entryId: z.string().min(1),
  section: memorySectionSchema,
});
export type MemoryPromoteParams = z.infer<typeof memoryPromoteParamsSchema>;

export const memoryPromoteResultSchema = z.object({
  promoted: z.boolean(),
});
export type MemoryPromoteResult = z.infer<typeof memoryPromoteResultSchema>;
