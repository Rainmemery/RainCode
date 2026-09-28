/**
 * write 工具（02 §2.3 清单）：写文件（整文件覆盖），目录自动创建。
 * 元数据：destructive=true / scope=workspace / risk=medium / needsApproval=true。
 * 「先读后写」快照校验（read-file state）随 read 状态跟踪波次补齐（02 §2.3 注）。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { TOOL_ERROR_CODES } from "@novacode/shared";
import type { Tool, ToolOutput, ToolExecutionContext } from "../tool.js";
import { ToolExecutionError } from "../executor.js";
import { guardPath } from "../path-guard.js";

export const writeTool: Tool<{ path: string; content: string }> = {
  name: "write",
  description:
    "Write (overwrite) a text file inside the workspace. Parent directories are created automatically. " +
    "The whole file content is replaced.",
  parametersSchema: z.object({
    path: z.string().min(1).describe("File path, relative to the workspace root"),
    content: z.string().describe("Full file content to write"),
  }),
  metadata: {
    readOnly: false,
    destructive: true,
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: true,
  },
  async execute(
    input: { path: string; content: string },
    ctx: ToolExecutionContext,
  ): Promise<ToolOutput<{ path: string; bytes: number }>> {
    const verdict = guardPath(ctx.workspaceRoot, input.path, ctx.pathPolicy);
    if (!verdict.ok) {
      throw new ToolExecutionError(
        TOOL_ERROR_CODES.PATH_ESCAPED,
        `path escapes workspace: ${input.path}`,
        verdict.absolutePath,
      );
    }
    const bytes = Buffer.byteLength(input.content, "utf8");
    try {
      await mkdir(dirname(verdict.absolutePath), { recursive: true });
      await writeFile(verdict.absolutePath, input.content, "utf8");
    } catch (reason: unknown) {
      throw new ToolExecutionError(
        TOOL_ERROR_CODES.EXEC_FAILED,
        `write failed for ${input.path}: ${reason instanceof Error ? reason.message : String(reason)}`,
      );
    }
    return {
      data: { path: input.path, bytes },
      content: `wrote ${input.path} (${String(bytes)} bytes)`,
    };
  },
};
