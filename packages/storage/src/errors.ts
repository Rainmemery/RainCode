/**
 * storage 包类型化错误：端口层 fail-fast，不吞错误（04 §2.4：storage 是唯一持久化出口）。
 */

export type StorageErrorCode =
  | "SESSION_NOT_FOUND"
  | "WORKSPACE_NOT_FOUND"
  | "MIGRATION_FAILED"
  | "PERM_RULE_CONFLICT";

export class StorageError extends Error {
  readonly code: StorageErrorCode;

  constructor(code: StorageErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "StorageError";
    this.code = code;
  }
}
