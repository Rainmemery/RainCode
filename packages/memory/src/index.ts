/**
 * @novacode/memory —— 项目记忆系统（02-module-design §7 / 04-architecture §2.1）。
 *
 * 本包唯一 publicEntrypoint（architecture/policy.yaml）：跨包只允许从这里导入，禁止深导入。
 * 三层记忆：MEMORY.md 文件真源（project-file）+ 会话记忆抽取落盘（session-memory）
 * + 按需召回（recall）；抽取的模型调用经 MemoryExtractPort 端口注入（04 §2.2）。
 */

// 错误（错误码常量 MEMORY_ERROR_CODES 真源在 @novacode/shared，此处 re-export 便于同域消费）
export { MemoryError } from "./errors.js";
export { MEMORY_ERROR_CODES } from "./errors.js";

// 第一层：MEMORY.md 文件真源（02 §7.3；05 §5.1）
export {
  MEMORY_FILE_DIR,
  MEMORY_FILE_NAME,
  MEMORY_TEMPLATE,
  appendToSection,
  loadProjectMemory,
  projectMemoryPath,
  updateAgentSection,
} from "./project-file/project-file.js";

// 第二层：会话记忆抽取（02 §7.2/§7.4；05 §5.4 末行幂等键）
export {
  MEMORY_EXTRACT_IDEMPOTENCY_PREFIX,
  extractFromSession,
  normalizeMemoryContent,
} from "./session-memory/extract.js";
export type { ExtractFromSessionDeps, ExtractFromSessionInput, ExtractedCandidate, MemoryExtractPort } from "./session-memory/extract.js";

// 召回（02 §7.3 search；05 §5.4）
export { searchEntries } from "./recall/recall.js";
export type { SearchEntriesOptions } from "./recall/recall.js";

// 门面（02 §7.3 ProjectMemoryService 契约 + 06 §2.6 协议对齐）
export { ProjectMemoryService, createProjectMemoryService } from "./service.js";
export type { ListEntriesFilter, ProjectMemoryServiceOptions } from "./service.js";
