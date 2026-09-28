/**
 * grep 工具（02 §2.3 清单）：内容正则搜索（ripgrep 语义子集）。
 * node:fs 自实现（零三方依赖；注释标注后续可替换 ripgrep 原生实现提升性能）。
 * 输出 file:line:text，行内与总匹配数均有截断上限。
 * 元数据：readOnly=true / scope=none / risk=low。
 */
import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { TOOL_ERROR_CODES } from "@novacode/shared";
import type { Tool, ToolOutput, ToolExecutionContext } from "../tool.js";
import { ToolExecutionError } from "../executor.js";
import { guardPath } from "../path-guard.js";
import { walkFiles } from "./walk.js";
import { compileGlob } from "./glob.js";

const MAX_MATCHES = 200;
const MAX_LINE_LENGTH = 300;
const MAX_FILE_BYTES = 1024 * 1024; // 跳过超大文件（二进制/产物）

export const grepTool: Tool<{
  pattern: string;
  path?: string;
  glob?: string;
  literal?: boolean;
  outputMode?: "content" | "files_with_matches";
}> = {
  name: "grep",
  description:
    "Search file contents inside the workspace with a regular expression (or literal text). " +
    "Output is file:line:text. Optionally filter files by glob pattern.",
  parametersSchema: z.object({
    pattern: z.string().min(1).describe("Regular expression (or literal when literal=true)"),
    path: z.string().optional().describe("Search root directory (default: workspace root)"),
    glob: z.string().optional().describe("File name glob filter, e.g. *.ts"),
    literal: z.boolean().optional().describe("Treat pattern as literal text (default false)"),
    outputMode: z.enum(["content", "files_with_matches"]).optional().describe("Default: content"),
  }),
  metadata: {
    readOnly: true,
    destructive: false,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  async execute(
    input: {
      pattern: string;
      path?: string;
      glob?: string;
      literal?: boolean;
      outputMode?: "content" | "files_with_matches";
    },
    ctx: ToolExecutionContext,
  ): Promise<ToolOutput<{ matches: number }>> {
    const verdict = guardPath(ctx.workspaceRoot, input.path ?? ".", ctx.pathPolicy);
    if (!verdict.ok) {
      throw new ToolExecutionError(
        TOOL_ERROR_CODES.PATH_ESCAPED,
        `path escapes workspace: ${input.path ?? "."}`,
        verdict.absolutePath,
      );
    }
    let regex: RegExp;
    try {
      const source = input.literal === true ? input.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : input.pattern;
      regex = new RegExp(source, "i");
    } catch (reason: unknown) {
      throw new ToolExecutionError(
        TOOL_ERROR_CODES.INVALID_INPUT,
        `invalid regular expression: ${reason instanceof Error ? reason.message : String(reason)}`,
      );
    }
    const fileFilter = input.glob !== undefined ? compileGlob(input.glob) : null;
    const outputMode = input.outputMode ?? "content";

    const entries = (await walkFiles(verdict.absolutePath)).filter(
      (entry) => fileFilter === null || fileFilter(entry.relativePath),
    );
    const lines: string[] = [];
    const matchedFiles: string[] = [];
    let totalMatches = 0;
    let hitCap = false;

    for (const entry of entries) {
      if (totalMatches >= MAX_MATCHES) {
        hitCap = true;
        break;
      }
      let info;
      try {
        info = await stat(entry.absolutePath);
      } catch {
        continue;
      }
      if (info.size > MAX_FILE_BYTES) {
        continue;
      }
      let text: string;
      try {
        text = await readFile(entry.absolutePath, "utf8");
      } catch {
        continue; // 二进制/无权限：跳过
      }
      if (text.includes("\u0000")) {
        continue; // 二进制文件启发式跳过
      }
      const fileLines = text.split("\n");
      let fileMatched = false;
      for (let index = 0; index < fileLines.length; index += 1) {
        const line = fileLines[index] ?? "";
        if (!regex.test(line)) {
          continue;
        }
        fileMatched = true;
        if (outputMode === "content") {
          const trimmed = line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line;
          lines.push(`${entry.relativePath}:${String(index + 1)}:${trimmed}`);
        }
        totalMatches += 1;
        if (totalMatches >= MAX_MATCHES) {
          hitCap = true;
          break;
        }
      }
      if (fileMatched) {
        matchedFiles.push(entry.relativePath);
      }
    }

    const notes = hitCap ? `\n\n[match cap reached: ${String(MAX_MATCHES)}; refine the pattern]` : "";
    if (outputMode === "files_with_matches") {
      const body = matchedFiles.length === 0 ? "no matches" : matchedFiles.join("\n");
      return {
        data: { matches: matchedFiles.length },
        content: `${body}${notes}`,
      };
    }
    return {
      data: { matches: totalMatches },
      content: `${lines.length === 0 ? "no matches" : lines.join("\n")}${notes}`,
    };
  },
};
