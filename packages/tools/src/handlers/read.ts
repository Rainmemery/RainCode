/**
 * read 工具（02 §2.3 清单）：文本读取，行号可选，大小上限。
 * 元数据：readOnly=true / scope=none / risk=low —— 权限快速通道（02 §6.2）。
 */
import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { TOOL_ERROR_CODES } from "@novacode/shared";
import type { Tool, ToolOutput, ToolExecutionContext } from "../tool.js";
import { ToolExecutionError } from "../executor.js";
import { guardPath } from "../path-guard.js";
import { truncateToByteBudget } from "../truncate.js";

const MAX_READ_BYTES = 256 * 1024; // 单次读取上限（超出提示用 offset/limit 分页）

export const readTool: Tool<{
  path: string;
  offset?: number;
  limit?: number;
  lineNumbers?: boolean;
}> = {
  name: "read",
  description:
    "Read a text file inside the workspace. Returns file content (optionally with line numbers). " +
    "Use offset/limit to page through large files.",
  parametersSchema: z.object({
    path: z.string().min(1).describe("File path, relative to the workspace root"),
    offset: z.number().int().min(1).optional().describe("1-based start line"),
    limit: z.number().int().min(1).max(2000).optional().describe("Max lines to return"),
    lineNumbers: z.boolean().optional().describe("Prefix each line with its number (default false)"),
  }),
  metadata: {
    readOnly: true,
    destructive: false,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  async execute(
    input: { path: string; offset?: number; limit?: number; lineNumbers?: boolean },
    ctx: ToolExecutionContext,
  ): Promise<ToolOutput<{ path: string; truncated: boolean }>> {
    const verdict = guardPath(ctx.workspaceRoot, input.path, ctx.pathPolicy);
    if (!verdict.ok) {
      throw new ToolExecutionError(
        TOOL_ERROR_CODES.PATH_ESCAPED,
        `path escapes workspace: ${input.path}`,
        verdict.absolutePath,
      );
    }
    let info;
    try {
      info = await stat(verdict.absolutePath);
    } catch (reason: unknown) {
      throw new ToolExecutionError(
        TOOL_ERROR_CODES.EXEC_FAILED,
        `cannot stat ${input.path}: ${reason instanceof Error ? reason.message : String(reason)}`,
      );
    }
    if (info.isDirectory()) {
      throw new ToolExecutionError(TOOL_ERROR_CODES.EXEC_FAILED, `${input.path} is a directory`);
    }

    const raw = await readFile(verdict.absolutePath, "utf8");
    const sizeCapped = Buffer.byteLength(raw, "utf8") > MAX_READ_BYTES;
    let text = sizeCapped ? Buffer.from(raw, "utf8").subarray(0, MAX_READ_BYTES).toString("utf8") : raw;
    let lines = text.split("\n");
    if (sizeCapped) {
      lines = lines.slice(0, -1); // 截断产生的残行丢弃
    }

    const offset = input.offset ?? 1;
    const limit = input.limit ?? 2000;
    const start = Math.max(offset - 1, 0);
    const slice = lines.slice(start, start + limit);
    const numbered = input.lineNumbers === true;
    const body = slice.map((line, index) => (numbered ? `${String(start + index + 1)}→${line}` : line)).join("\n");
    const { text: content, truncated: budgetTruncated } = truncateToByteBudget(body, 128 * 1024);

    const pagesRemaining = start + slice.length < lines.length;
    const notes: string[] = [];
    if (sizeCapped) notes.push(`file exceeds ${String(MAX_READ_BYTES)} bytes; content capped`);
    if (pagesRemaining || budgetTruncated) {
      notes.push(
        `showing lines ${String(start + 1)}-${String(start + slice.length)} of ${String(lines.length)}; use offset/limit to page`,
      );
    }
    return {
      data: { path: input.path, truncated: sizeCapped || pagesRemaining },
      content: notes.length > 0 ? `${content}\n\n[${notes.join("; ")}]` : content,
    };
  },
};
