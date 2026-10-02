/**
 * ProjectMemoryService 门面（02 §7.3 契约 + 06 §2.6 协议对齐）。
 * 三层记忆的单一入口：MEMORY.md 文件真源（第一层）+ memory_entries 抽取/召回（第二层）。
 * - 抽取的模型调用经 MemoryExtractPort 端口注入（04 §2.2：memory 不可直接依赖 llm）；
 * - Agent 写入范围收窄为「工作约定」/「当前进行」两个专用章节，越界 → MEMORY_SECTION_FORBIDDEN
 *   （02 §7.1：用户章节的合入只能经 promote 由用户确认动作触发）；
 * - promote 只改 MEMORY.md，不改 memory_entries 行（05 §5.1：不为存储层发明字段）；
 * - 晋升草案待确认区（02 §7.2 第三层）：抽取高置信新条目自动生成草案，confirm/reject 由用户处置，
 *   直接管 promote 同步收敛该条目 pending 草案（promotion/drafts.ts）。
 */
import { MEMORY_ERROR_CODES, memoryAgentSectionSchema } from "@raincode/shared";
import type { MemoryEntry, MemoryKind, MemorySection, MemorySource } from "@raincode/shared";
import { StorageError } from "@raincode/storage";
import type { MemoryRepo, SettingsRepo, Storage } from "@raincode/storage";
import { MemoryError } from "./errors.js";
import { appendToSection, loadProjectMemory, updateAgentSection } from "./project-file/project-file.js";
import type { SectionEditHooks } from "./project-file/project-file.js";
import { searchEntries } from "./recall/recall.js";
import type { SearchEntriesOptions } from "./recall/recall.js";
import {
  extractFromSession as runExtraction,
  type ExtractFromSessionInput,
  type MemoryExtractPort,
} from "./session-memory/extract.js";
import {
  createDraftsForEntries,
  listDrafts as listDraftsStore,
  resolveDraft as resolveDraftStore,
  resolvePendingDraftsByEntry,
} from "./promotion/drafts.js";
import type { MemoryDraftStatus, MemoryDraftWithEntry } from "./promotion/drafts.js";

export interface ProjectMemoryServiceOptions {
  storage: Storage;
  extractPort: MemoryExtractPort;
  /** 实例绑定 workspace 的根路径（02 §7.4 服务实例按 workspace 缓存隔离）；缺省时 promote 经 storage 反查。 */
  workspaceRoot?: string;
  /** 章节写路径注入点（宿主/测试确定性并发窗口；prod 缺省不传，见 project-file.ts）。 */
  sectionEditHooks?: SectionEditHooks;
}

/** memory.entries.list 过滤（06 §2.6 params 投影；page 的 cursor/limit 拆平）。 */
export interface ListEntriesFilter {
  kind?: MemoryKind;
  source?: MemorySource;
  /** lastSeenAt 起始（含）。 */
  since?: number;
  cursor?: string;
  limit?: number;
}

export class ProjectMemoryService {
  private readonly storage: Storage;
  private readonly repo: MemoryRepo;
  private readonly settings: SettingsRepo;
  private readonly extractPort: MemoryExtractPort;
  private readonly workspaceRoot?: string;
  private readonly sectionEditHooks: SectionEditHooks;

  constructor(options: ProjectMemoryServiceOptions) {
    this.storage = options.storage;
    this.repo = options.storage.memory;
    this.settings = options.storage.settings;
    this.extractPort = options.extractPort;
    this.workspaceRoot = options.workspaceRoot;
    this.sectionEditHooks = options.sectionEditHooks ?? {};
  }

  /** memory.read（06 §2.6）：启动注入数据源；只读不落盘，不存在→模板骨架 + exists:false。 */
  async loadProjectMemory(workspaceRoot: string): Promise<{ content: string; exists: boolean }> {
    return loadProjectMemory(workspaceRoot);
  }

  /** memory.write（06 §2.6）：MEMORY.md 增量更新；章节白名单越界 → MEMORY_SECTION_FORBIDDEN。 */
  async writeAgentSection(workspaceRoot: string, section: MemorySection, content: string): Promise<void> {
    if (!memoryAgentSectionSchema.safeParse(section).success) {
      throw new MemoryError(
        MEMORY_ERROR_CODES.SECTION_FORBIDDEN,
        `section is not agent-writable: ${section}`,
      );
    }
    await updateAgentSection(workspaceRoot, section, content, this.sectionEditHooks);
  }

  /** memory.search（06 §2.6）：按需召回；无结果返回空数组（02 §7.4）。 */
  async search(workspaceId: string, query: string, opts: SearchEntriesOptions = {}): Promise<MemoryEntry[]> {
    return searchEntries(this.repo, { workspaceId, query, kind: opts.kind, limit: opts.limit });
  }

  /** memory.entries.list（06 §2.6）：管理分页视图；workspaceId 缺省 = 跨 workspace 全量。 */
  async listEntries(
    workspaceId: string | undefined,
    filter: ListEntriesFilter = {},
  ): Promise<{ items: MemoryEntry[]; nextCursor?: string }> {
    return this.repo.list(workspaceId, filter);
  }

  /**
   * memory.promote（06 §2.6）：条目合入 MEMORY.md 指定章节；调用本身即用户确认动作
   * （三层单向晋升，02 §7.2）。entryId 不存在 → MEMORY_ENTRY_NOT_FOUND。
   */
  async promote(entryId: string, section: MemorySection): Promise<void> {
    const entry = await this.repo.get(entryId);
    if (entry === null) {
      throw new MemoryError(MEMORY_ERROR_CODES.ENTRY_NOT_FOUND, `memory entry not found: ${entryId}`);
    }
    const root = this.workspaceRoot ?? (await this.storage.workspaceRootByHash(entry.workspaceId));
    if (root === null) {
      throw new StorageError("WORKSPACE_NOT_FOUND", `workspace not registered: ${entry.workspaceId}`);
    }
    await appendToSection(root, section, entry.content, this.sectionEditHooks);
    // 直接管晋升即用户确认动作：收敛该条目的 pending 草案（不悬挂过期建议）
    await resolvePendingDraftsByEntry({ repo: this.repo, settings: this.settings }, entry.workspaceId, entry.id);
  }

  /**
   * 会话结束 / compact 抽取（02 §7.3）；供 server 钩子调用，幂等键见 session-memory/extract.ts。
   * 抽取落盘后为高置信新条目生成晋升草案（02 §7.2 第三层，promotion/drafts.ts）。
   */
  async extractFromSession(input: ExtractFromSessionInput): Promise<MemoryEntry[]> {
    const inserted = await runExtraction(
      { repo: this.repo, settings: this.settings, extractPort: this.extractPort },
      input,
    );
    await createDraftsForEntries(
      { repo: this.repo, settings: this.settings },
      input.workspaceId,
      inserted,
    );
    return inserted;
  }

  /** memory.drafts.list（06 §2.6）：晋升草案待确认区投影（条目本体随行）。 */
  async listDrafts(workspaceId: string, filter: { status?: MemoryDraftStatus } = {}): Promise<MemoryDraftWithEntry[]> {
    return listDraftsStore({ repo: this.repo, settings: this.settings }, workspaceId, filter);
  }

  /**
   * memory.drafts.resolve（06 §2.6）：用户处置草案——confirm 合入 MEMORY.md（调用本身即用户
   * 确认动作，同 promote）、reject 仅标记；处置后草案进入终态不可再变更。
   */
  async resolveDraft(
    workspaceId: string,
    input: { draftId: string; action: "confirm" | "reject"; section?: MemorySection },
  ): Promise<{ resolved: true; promoted: boolean }> {
    const result = await resolveDraftStore(
      { repo: this.repo, settings: this.settings },
      workspaceId,
      input,
      (entryId, section) => this.promote(entryId, section),
    );
    return { resolved: true, promoted: result.promoted };
  }
}

/** 工厂（server 装配入口；llm 能力经 extractPort 注入，04 §2.2 端口惯例）。 */
export function createProjectMemoryService(options: ProjectMemoryServiceOptions): ProjectMemoryService {
  return new ProjectMemoryService(options);
}
