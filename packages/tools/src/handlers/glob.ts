/**
 * glob 工具（02 §2.3 清单）：文件名模式匹配（** / * / ? 语义）。
 * node:fs 自实现（零三方依赖；注释标注后续可替换 fast-glob 原生实现）。
 * 元数据：readOnly=true / scope=none / risk=low。
 */
import { z } from "zod";
import { TOOL_ERROR_CODES } from "@novacode/shared";
import type { Tool, ToolOutput, ToolExecutionContext } from "../tool.js";
import { ToolExecutionError } from "../executor.js";
import { guardPath } from "../path-guard.js";
import { walkFiles } from "./walk.js";

const MAX_RESULTS = 200;

export const globTool: Tool<{ pattern: string; path?: string }> = {
  name: "glob",
  description:
    "Match workspace files by glob pattern (** crosses directories, * stays within one, ? matches one char). " +
    "node_modules/.git are ignored by default. Returns matching paths sorted.",
  parametersSchema: z.object({
    pattern: z.string().min(1).describe("Glob pattern relative to the search root, e.g. src/**/*.ts"),
    path: z.string().optional().describe("Search root directory (default: workspace root)"),
  }),
  metadata: {
    readOnly: true,
    destructive: false,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  async execute(
    input: { pattern: string; path?: string },
    ctx: ToolExecutionContext,
  ): Promise<ToolOutput<{ matches: string[]; truncated: boolean }>> {
    const verdict = guardPath(ctx.workspaceRoot, input.path ?? ".", ctx.pathPolicy);
    if (!verdict.ok) {
      throw new ToolExecutionError(
        TOOL_ERROR_CODES.PATH_ESCAPED,
        `path escapes workspace: ${input.path ?? "."}`,
        verdict.absolutePath,
      );
    }
    const matcher = compileGlob(input.pattern);
    const entries = await walkFiles(verdict.absolutePath);
    const matches = entries
      .filter((entry) => matcher(entry.relativePath))
      .map((entry) => entry.relativePath)
      .sort();
    const truncated = matches.length > MAX_RESULTS;
    const kept = truncated ? matches.slice(0, MAX_RESULTS) : matches;
    return {
      data: { matches: kept, truncated },
      content:
        kept.length === 0
          ? "no matches"
          : `${kept.join("\n")}${truncated ? `\n\n[showing first ${String(MAX_RESULTS)} of ${String(matches.length)} matches]` : ""}`,
    };
  },
};

/** glob → RegExp：** 跨目录、* 单段、? 单字符；其余字符字面量。 */
export function compileGlob(pattern: string): (relativePath: string) => boolean {
  let regexSource = "^";
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index]!;
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        // `**/` 或裸 `**`：跨任意层级（含零层）
        const rest = pattern.slice(index, index + 3);
        if (rest === "**/") {
          regexSource += "(?:.*/)?";
          index += 3;
        } else {
          regexSource += ".*";
          index += 2;
        }
        continue;
      }
      regexSource += "[^/]*";
      index += 1;
      continue;
    }
    if (char === "?") {
      regexSource += "[^/]";
      index += 1;
      continue;
    }
    regexSource += escapeRegExp(char);
    index += 1;
  }
  regexSource += "$";
  const regex = new RegExp(regexSource);
  return (relativePath) => regex.test(relativePath);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
