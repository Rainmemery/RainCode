/**
 * permission 包类型化错误：server 捕获后转换为 RpcCallError（06 §4.3 业务码）。
 * 错误码取值 = shared PC_ERROR_CODES（PC_* 前缀，任务交付约定）。
 */
import { PC_ERROR_CODES } from "@novacode/shared";
import type { PcErrorCode } from "@novacode/shared";

export class PermissionError extends Error {
  readonly code: PcErrorCode;
  readonly details?: unknown;

  constructor(code: PcErrorCode, message: string, details?: unknown) {
    super(`[${code}] ${message}`);
    this.name = "PermissionError";
    this.code = code;
    this.details = details;
  }
}

export { PC_ERROR_CODES };
