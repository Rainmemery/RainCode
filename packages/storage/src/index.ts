/**
 * @novacode/storage —— SQLite（better-sqlite3, WAL）+ JSONL 会话事件流（05-database）。
 *
 * 本包唯一 publicEntrypoint（architecture/policy.yaml）：跨包只允许从这里导入，禁止深导入。
 * 只依赖 @novacode/shared；storage 之外禁止直接触碰 fs/sqlite（04 §2.4 铁律 2）。
 * 波次裁剪：迁移 001_init 仅建 schema_migrations / workspaces / sessions 三表；
 * SessionsRepo + 会话 JSONL 流（append / checkpoint fsync / resume 增量重放 / epoch 单调合并）。
 */

export { Storage } from "./storage.js";
export type { AppendOptions, CheckpointOptions, SessionResume, StorageOpenOptions, WorkspaceInfo } from "./storage.js";

export { SessionsRepo } from "./sessions-repo.js";
export type {
  SessionCreateInput,
  SessionKind,
  SessionListFilter,
  SessionMeta,
  SessionMetaPatch,
  SessionStatus,
} from "./sessions-repo.js";

export { RulesRepo } from "./rules-repo.js";
export type {
  PermissionRuleRow,
  PersistedRuleScope,
  RuleAddInput,
  RuleListFilter,
  RuleSource,
} from "./rules-repo.js";

export { DecisionsRepo } from "./decisions-repo.js";
export type {
  AuditMode,
  DecisionAppendInput,
  DecisionListFilter,
  PermissionDecisionRow,
} from "./decisions-repo.js";

export { ApprovalsRepo } from "./approvals-repo.js";
export type {
  ApprovalCreateInput,
  ApprovalResolveInput,
  ApprovalRow,
  ApprovalStatus,
  ApprovalResponse,
} from "./approvals-repo.js";

export { SessionStream } from "./jsonl-stream.js";
export type { AppendResult, CheckpointResult, SessionStreamOptions } from "./jsonl-stream.js";

export {
  HEADER_EVENT_NAME,
  JSONL_SCHEMA_VERSION,
  NOVACODE_VERSION,
  parseLine,
  serializeLine,
} from "./jsonl-lines.js";
export type { CheckpointLine, CheckpointState, EventLine, JsonlLine, MessageLine, ParsedLine } from "./jsonl-lines.js";

export { replaySessionFile, repairDanglingTail, scanTailState } from "./jsonl-resume.js";
export type { CheckpointSource, ResumeReplay, ResumeReadOptions, TailState } from "./jsonl-resume.js";

export {
  canonicalWorkspacePath,
  computeWorkspaceHash,
  resolveDataRoot,
  sessionPaths,
} from "./paths.js";
export type { SessionPaths } from "./paths.js";

export { loadMigrationScripts, openDatabase, runMigrations } from "./db.js";
export type { MigrationScript, SqliteDatabase } from "./db.js";

export { StorageError } from "./errors.js";
export type { StorageErrorCode } from "./errors.js";

export { ulid } from "./ulid.js";
