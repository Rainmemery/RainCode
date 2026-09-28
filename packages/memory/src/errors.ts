/**
 * memory 包类型化错误：server 捕获后转换为 RpcCallError（06 §4.3 段 6 业务码）。
 * 错误码取值 = shared MEMORY_ERROR_CODES（MEMORY_* 前缀）；形态照 permission/src/errors.ts。
 */
import { MEMORY_ERROR_CODES } from "@novacode/shared";
import type { MemoryErrorCode } from "@novacode/shared";

export class MemoryError extends Error {
  readonly code: MemoryErrorCode;
  readonly details?: unknown;

  constructor(code: MemoryErrorCode, message: string, details?: unknown) {
    super(`[${code}] ${message}`);
    this.name = "MemoryError";
    this.code = code;
    this.details = details;
  }
}

export { MEMORY_ERROR_CODES };
