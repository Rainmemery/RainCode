/**
 * 路径守卫（02-module-design §5.1：workspace cwd 限定、越界路径检测）。
 *
 * - 相对路径以 workspaceRoot 为基准解析；绝对路径规范化后做前缀包含校验
 *   （win32 大小写不敏感，02 §5.3「规范化比对（大小写不敏感）」）；
 * - 越界路径默认拒绝（TOOL_PATH_ESCAPED）；`PathPolicyHook.allowEscaped` 是留给权限层的
 *   放行钩子（02 §5.4「审批通过后放行并记录审计」——本波仅留接口，未接权限链）。
 */
import { resolve, sep } from "node:path";

export interface PathPolicyHook {
  /**
   * 越界路径放行钩子（权限层接入点）：返回 true 放行该绝对路径。
   * 缺省（未注入）一律不放行 —— fail-safe（02 §6.2 判定链兜底 default ask/deny）。
   */
  allowEscaped?(absolutePath: string): boolean;
}

export type PathGuardVerdict =
  | { ok: true; absolutePath: string }
  | { ok: false; absolutePath: string; reason: "escaped" };

function normalizeForCompare(path: string): string {
  const normalized = resolve(path);
  const withSlashes = normalized.split(sep).join("/").replace(/\/+$/, "");
  return process.platform === "win32" ? withSlashes.toLowerCase() : withSlashes;
}

/**
 * 解析并校验目标路径是否位于 workspaceRoot 内。
 * target 为空/“.”时返回 workspaceRoot 本身（目录型工具的基准）。
 */
export function guardPath(
  workspaceRoot: string,
  target: string,
  hook?: PathPolicyHook,
): PathGuardVerdict {
  const rootNormalized = normalizeForCompare(workspaceRoot);
  const absolutePath = resolve(workspaceRoot, target);
  const targetNormalized = normalizeForCompare(absolutePath);
  const inside =
    targetNormalized === rootNormalized || targetNormalized.startsWith(`${rootNormalized}/`);
  if (inside) {
    return { ok: true, absolutePath };
  }
  const allowEscaped = hook?.allowEscaped;
  if (allowEscaped !== undefined && allowEscaped(absolutePath) === true) {
    return { ok: true, absolutePath }; // 权限层显式放行（钩子留接口，本波默认无人放行）
  }
  return { ok: false, absolutePath, reason: "escaped" };
}
