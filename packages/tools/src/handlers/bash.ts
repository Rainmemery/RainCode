/**
 * bash 工具（02 §2.3 清单 / §5 沙箱）：执行 shell 命令（经执行域 Executor 投递）。
 * - M3 T3.1：执行域由装配方注入（local/docker/wsl，config.json sandbox.executor 解析 + 回退），
 *   缺省 LocalExecutor（P0 约束语义不变）；工作目录仍经 path-guard 校验后才投递；
 * - 超时默认 120s（上限 600s）；输出环形截断；AbortSignal 取消 → 进程树终止（docker 附 rm -f 清理）；
 * - runInBackground：登记 BackgroundTaskRegistry（start/kill/list/output，registry 绑定同一执行域）；
 * - 结果 data 带 sandbox/enforcement 字段（T5.2：执行域与边界强度自报，每次调用持续携带，
 *   非一次性告警）；非 local 执行域在内容头行标注（02 §5.4：kind 保证 UI 展示真实执行环境）；
 *   约束面拒绝（PATH_ESCAPED）由 ToolExecutor 中央追加模型可见拒绝标记（sandbox/enforcement.ts）。
 * 元数据：scope=machine / risk=high / needsApproval=true（02 §6.2 高危根命令逐次审批）。
 */
import { z } from "zod";
import { TOOL_ERROR_CODES } from "@raincode/shared";
import type { Tool, ToolExecutionContext, ToolOutput } from "../tool.js";
import { ToolExecutionError } from "../executor.js";
import { guardPath } from "../path-guard.js";
import { LocalExecutor, type Executor } from "../sandbox/executor.js";

const parametersSchema = z.object({
  command: z.string().min(1).describe("Shell command to execute"),
  timeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(600_000)
    .optional()
    .describe("Timeout in ms (default 120000, max 600000)"),
  runInBackground: z.boolean().optional().describe("Start as background task and return immediately"),
});

type BashInput = z.infer<typeof parametersSchema>;
type BashData = {
  exitCode: number | null;
  taskId?: string;
  sandbox: Executor["kind"];
  /** 边界强度自报（T5.2）：随每次调用持续携带（full=绝对边界；partial=约束/环境隔离）。 */
  enforcement: Executor["enforcement"];
};

export function createBashTool(options: { executor?: Executor } = {}): Tool<BashInput, BashData> {
  const fallbackExecutor = options.executor ?? new LocalExecutor();
  return {
    name: "bash",
    description:
      "Run a shell command inside the workspace (executor kind may be local, docker, wsl or ssh per sandbox config; " +
      "results carry sandbox/enforcement metadata describing the real execution domain and its boundary strength). " +
      "Output is truncated to a budget. Use runInBackground for long-running processes; " +
      "the returned taskId can be used with background output queries.",
    parametersSchema,
    metadata: {
      readOnly: false,
      destructive: false,
      sideEffectScope: "machine",
      riskLevel: "high",
      needsApproval: true,
      timeoutMs: 120_000,
      maxOutputBytes: 256 * 1024,
    },
    async execute(input: BashInput, ctx: ToolExecutionContext): Promise<ToolOutput<BashData>> {
      const cwdVerdict = guardPath(ctx.workspaceRoot, ctx.cwd, ctx.pathPolicy);
      if (!cwdVerdict.ok) {
        throw new ToolExecutionError(
          TOOL_ERROR_CODES.PATH_ESCAPED,
          `cwd escapes workspace: ${ctx.cwd}`,
          cwdVerdict.absolutePath,
        );
      }

      const executor = fallbackExecutor;
      const execRequest = {
        command: input.command,
        cwd: cwdVerdict.absolutePath,
        workspaceRoot: ctx.workspaceRoot,
        ...(input.timeoutMs !== undefined && { timeoutMs: input.timeoutMs }),
        signal: ctx.signal,
      };

      if (input.runInBackground === true) {
        const task = ctx.background.start(execRequest);
        return {
          data: {
            exitCode: null,
            taskId: task.info.taskId,
            sandbox: executor.kind,
            enforcement: executor.enforcement,
          },
          content: `started background task ${task.info.taskId}: ${input.command}`,
        };
      }

      const result = await executor.run(execRequest);

      const header = `exit code: ${result.exitCode === null ? "killed" : String(result.exitCode)}${
        result.timedOut ? " (timed out)" : ""
      }`;
      const sections: string[] = [
        // 非 local 执行域标注真实执行环境与边界强度（02 §5.4 / T5.2）；local 缺省不标注（输出与 P0 语义字节兼容）
        ...(executor.kind !== "local"
          ? [`sandbox: ${executor.kind} (enforcement: ${executor.enforcement})`]
          : []),
        header,
      ];
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
        data: { exitCode: result.exitCode, sandbox: executor.kind, enforcement: executor.enforcement },
        content: sections.join("\n"),
      };
    },
  };
}

/** 本地缺省实例（未配置 sandbox 时与 P0 行为一致；具名导出兼容既有引用）。 */
export const bashTool: Tool<BashInput, BashData> = createBashTool();
