/**
 * bash 工具（02 §2.3 清单 / §5 沙箱）：执行 shell 命令（经受控执行层）。
 * - Windows 优先 bash.exe（where 探测），缺失回退 PowerShell（见 sandbox/local-executor.ts）；
 * - 超时默认 120s（上限 600s）；输出环形截断；AbortSignal 取消 → 进程树终止（taskkill /T）；
 * - runInBackground：登记 BackgroundTaskRegistry（start/kill/list/output 最小实现）。
 * 元数据：scope=machine / risk=high / needsApproval=true（02 §6.2 高危根命令逐次审批）。
 */
import { z } from "zod";
import { TOOL_ERROR_CODES } from "@novacode/shared";
import type { Tool, ToolOutput, ToolExecutionContext } from "../tool.js";
import { ToolExecutionError } from "../executor.js";
import { guardPath } from "../path-guard.js";
import { execLocal } from "../sandbox/local-executor.js";

export const bashTool: Tool<{
  command: string;
  timeoutMs?: number;
  runInBackground?: boolean;
}> = {
  name: "bash",
  description:
    "Run a shell command inside the workspace (bash on Windows when available, PowerShell fallback). " +
    "Output is truncated to a budget. Use runInBackground for long-running processes; " +
    "the returned taskId can be used with background output queries.",
  parametersSchema: z.object({
    command: z.string().min(1).describe("Shell command to execute"),
    timeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(600_000)
      .optional()
      .describe("Timeout in ms (default 120000, max 600000)"),
    runInBackground: z.boolean().optional().describe("Start as background task and return immediately"),
  }),
  metadata: {
    readOnly: false,
    destructive: false,
    sideEffectScope: "machine",
    riskLevel: "high",
    needsApproval: true,
    timeoutMs: 120_000,
    maxOutputBytes: 256 * 1024,
  },
  async execute(
    input: { command: string; timeoutMs?: number; runInBackground?: boolean },
    ctx: ToolExecutionContext,
  ): Promise<ToolOutput<{ exitCode: number | null; taskId?: string }>> {
    const cwdVerdict = guardPath(ctx.workspaceRoot, ctx.cwd, ctx.pathPolicy);
    if (!cwdVerdict.ok) {
      throw new ToolExecutionError(
        TOOL_ERROR_CODES.PATH_ESCAPED,
        `cwd escapes workspace: ${ctx.cwd}`,
        cwdVerdict.absolutePath,
      );
    }

    if (input.runInBackground === true) {
      const task = ctx.background.start({
        command: input.command,
        cwd: cwdVerdict.absolutePath,
        ...(input.timeoutMs !== undefined && { timeoutMs: input.timeoutMs }),
        signal: ctx.signal,
      });
      return {
        data: { exitCode: null, taskId: task.info.taskId },
        content: `started background task ${task.info.taskId}: ${input.command}`,
      };
    }

    const result = await execLocal({
      command: input.command,
      cwd: cwdVerdict.absolutePath,
      ...(input.timeoutMs !== undefined && { timeoutMs: input.timeoutMs }),
      signal: ctx.signal,
    });

    const header = `exit code: ${result.exitCode === null ? "killed" : String(result.exitCode)}${
      result.timedOut ? " (timed out)" : ""
    }`;
    const sections: string[] = [header];
    if (result.stdout.length > 0) sections.push(`--- stdout ---\n${result.stdout}`);
    if (result.stderr.length > 0) sections.push(`--- stderr ---\n${result.stderr}`);
    if (result.truncated) sections.push("[output truncated by budget]");

    if (result.timedOut) {
      throw new ToolExecutionError(
        TOOL_ERROR_CODES.TIMEOUT,
        `command timed out after ${String(input.timeoutMs ?? 120_000)}ms`,
        sections.join("\n").slice(0, 4000),
      );
    }
    return {
      data: { exitCode: result.exitCode },
      content: sections.join("\n"),
    };
  },
};
