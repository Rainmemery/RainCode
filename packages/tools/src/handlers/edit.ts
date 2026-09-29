/**
 * edit 工具（02 §2.3 清单）：精确字符串替换编辑，唯一性校验。
 * oldString 多处匹配 → ambiguous_match 拒绝（02 §2.4）；无匹配 → no_match。
 * 元数据：destructive=true / scope=workspace / risk=medium / needsApproval=true。
 */
import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { TOOL_ERROR_CODES } from "@raincode/shared";
import type { Tool, ToolOutput, ToolExecutionContext } from "../tool.js";
import { ToolExecutionError } from "../executor.js";
import { guardPath } from "../path-guard.js";

export const editTool: Tool<{
  path: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}> = {
  name: "edit",
  description:
    "Replace an exact string inside a text file. oldString must match exactly once unless replaceAll is true.",
  parametersSchema: z.object({
    path: z.string().min(1).describe("File path, relative to the workspace root"),
    oldString: z.string().min(1).describe("Exact text to replace"),
    newString: z.string().describe("Replacement text"),
    replaceAll: z.boolean().optional().describe("Replace every occurrence (default false)"),
  }),
  metadata: {
    readOnly: false,
    destructive: true,
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: true,
  },
  async execute(
    input: { path: string; oldString: string; newString: string; replaceAll?: boolean },
    ctx: ToolExecutionContext,
  ): Promise<ToolOutput<{ path: string; replacements: number }>> {
    const verdict = guardPath(ctx.workspaceRoot, input.path, ctx.pathPolicy);
    if (!verdict.ok) {
      throw new ToolExecutionError(
        TOOL_ERROR_CODES.PATH_ESCAPED,
        `path escapes workspace: ${input.path}`,
        verdict.absolutePath,
      );
    }
    let content: string;
    try {
      content = await readFile(verdict.absolutePath, "utf8");
    } catch (reason: unknown) {
      throw new ToolExecutionError(
        TOOL_ERROR_CODES.EXEC_FAILED,
        `cannot read ${input.path}: ${reason instanceof Error ? reason.message : String(reason)}`,
      );
    }

    const occurrences = countOccurrences(content, input.oldString);
    if (occurrences === 0) {
      throw new ToolExecutionError(
        TOOL_ERROR_CODES.NO_MATCH,
        `oldString not found in ${input.path}; include more surrounding context to make it unique`,
      );
    }
    if (occurrences > 1 && input.replaceAll !== true) {
      throw new ToolExecutionError(
        TOOL_ERROR_CODES.AMBIGUOUS_MATCH,
        `oldString matches ${String(occurrences)} locations in ${input.path}; expand the context or pass replaceAll`,
        `occurrences=${String(occurrences)}`,
      );
    }

    const replaced =
      input.replaceAll === true
        ? content.split(input.oldString).join(input.newString)
        : content.replace(input.oldString, input.newString);
    const replacements = input.replaceAll === true ? occurrences : 1;
    try {
      await writeFile(verdict.absolutePath, replaced, "utf8");
    } catch (reason: unknown) {
      throw new ToolExecutionError(
        TOOL_ERROR_CODES.EXEC_FAILED,
        `write failed for ${input.path}: ${reason instanceof Error ? reason.message : String(reason)}`,
      );
    }
    return {
      data: { path: input.path, replacements },
      content: `edited ${input.path}: replaced ${String(replacements)} occurrence(s)`,
    };
  },
};

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}
