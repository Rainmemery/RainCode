/**
 * ToolPhaseRunner 独立工具函数（从 tool-phase.ts 拆出，单文件 ≤500 行治理）。
 * 纯函数：路径预检 / 宽松 JSON / 未知名元数据 / 预览截断。
 */
import { guardPath, type ToolMetadata } from "@raincode/tools";

/** 显式路径工具集合（02 §5.4 预检对象；bash 不做命令内路径解析，cwd 已有校验）。 */
const PATH_FIELD_TOOLS = new Set(["read", "grep", "glob", "write", "edit"]);

/**
 * 越界路径预检（02 §5.4「命令读写 workspace 外路径 → 权限层 ask」）：
 * 对显式路径工具提取 input.path（grep/glob 缺省 "."，缺省不会越界故仅校验显式提供值），
 * 复用 tools 的 guardPath 判定；越界时返回绝对路径供权限强制 ask 与获批后精确放行。
 */
export function detectPathEscape(
  toolName: string,
  input: unknown,
  workspaceRoot: string,
): { absolutePath: string } | undefined {
  if (!PATH_FIELD_TOOLS.has(toolName)) {
    return undefined;
  }
  if (typeof input !== "object" || input === null) {
    return undefined;
  }
  const raw = (input as { path?: unknown }).path;
  if (typeof raw !== "string" || raw.length === 0) {
    return undefined;
  }
  const verdict = guardPath(workspaceRoot, raw);
  return verdict.ok ? undefined : { absolutePath: verdict.absolutePath };
}

export function parseLoose(argsJSON: string): unknown {
  try {
    return JSON.parse(argsJSON);
  } catch {
    return argsJSON;
  }
}

export function unknownToolMetadata(): ToolMetadata {
  return {
    readOnly: false,
    destructive: false,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  };
}

const CONTENT_PREVIEW_MAX_CHARS = 120;

export function previewOf(content: string): string {
  const firstLine = content.split("\n", 1)[0] ?? "";
  return firstLine.length > CONTENT_PREVIEW_MAX_CHARS
    ? `${firstLine.slice(0, CONTENT_PREVIEW_MAX_CHARS)}…`
    : firstLine;
}
