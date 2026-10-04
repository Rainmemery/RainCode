/**
 * HookRunner：command 类型 hook 进程执行器（T5.1，06-api-spec §2.12）。
 *
 * - argv 执行（child_process.spawn，不经 shell，参数不进命令行拼接——无注入面）；
 * - stdin 写入一个 JSON hook 输入后关闭；stdout/stderr 捕获有字节上限（防超长输出撑爆内存）；
 * - 收敛口径（ZCode 蓝本 + CC 兼容）：stdout 空 = no-op success；exit code 2 = 显式 block；
 *   stdout 非 JSON / schema 不符（strict）= failed；超时 = timed_out；其余非零退出 = failed；
 *   failed/timed_out 告警不阻塞主流程（T5.1 验收口径）；
 * - block 判定：decision:"block" | continue:false | hookSpecificOutput.permissionDecision:"deny" | exit 2；
 * - 引擎永不抛出（内部收敛，02 §2.4 execute 永不抛同口径）。
 */
import { spawn } from "node:child_process";
import { hookOutputSchema, type HookCommand, type HookEvent } from "@raincode/shared";
import type { HookRunResult } from "./types.js";

/** stdout/stderr 捕获字节上限（ZCode hooks.maxOutputBytes 缺省口径 32768）。 */
const MAX_OUTPUT_BYTES = 32_768;
/** timeoutMs 缺省（ZCode hooks.timeoutMs 口径 60s）。 */
export const DEFAULT_HOOK_TIMEOUT_MS = 60_000;
/** 超时后宽限 kill 窗口（进程组终止收尾）。 */
const KILL_GRACE_MS = 1_000;

/** 单 hook 执行（引擎永不抛；返回内部收敛结果）。 */
export async function runHook(options: {
  hook: HookCommand;
  hookId: string;
  event: HookEvent;
  /** stdin JSON 输入（对象；序列化失败按 failed 收敛）。 */
  input: unknown;
  signal?: AbortSignal;
  onDiagnostic?: (message: string, err?: unknown) => void;
}): Promise<HookRunResult> {
  const startedAt = Date.now();
  const hook = options.hook;
  const base = { hookId: options.hookId, event: options.event };

  let stdinText: string;
  try {
    stdinText = JSON.stringify(options.input);
  } catch (reason: unknown) {
    options.onDiagnostic?.("hook input serialization failed", reason);
    return {
      ...base,
      outcome: "failed",
      exitCode: null,
      durationMs: Date.now() - startedAt,
      stderr: "",
      stdout: "",
      reason: "hook input is not JSON-serializable",
    };
  }

  const timeoutMs = hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  const spawnResult = await new Promise<HookRunResult>((resolvePromise) => {
    // shell:false 显式声明：argv 直执行，环境继承宿主（hook 与用户同信任域，不额外清洗）
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(hook.command, hook.args ?? [], {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (reason: unknown) {
      options.onDiagnostic?.(`hook spawn failed: ${hook.command}`, reason);
      resolvePromise({
        ...base,
        outcome: "failed",
        exitCode: null,
        durationMs: Date.now() - startedAt,
        stderr: "",
        stdout: "",
        reason: `spawn failed: ${reason instanceof Error ? reason.message : String(reason)}`,
      });
      return;
    }

    const chunks: { stdout: Buffer[]; stderr: Buffer[] } = { stdout: [], stderr: [] };
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const out = {
      stdout: () => Buffer.concat(chunks.stdout).toString("utf8"),
      stderr: () => Buffer.concat(chunks.stderr).toString("utf8"),
    };

    const collect = (slot: "stdout" | "stderr", chunk: Buffer): void => {
      const slotBytes = slot === "stdout" ? stdoutBytes : stderrBytes;
      if (slotBytes >= MAX_OUTPUT_BYTES) return;
      const remaining = MAX_OUTPUT_BYTES - slotBytes;
      const clipped = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      if (slot === "stdout") stdoutBytes += clipped.length;
      else stderrBytes += clipped.length;
      chunks[slot].push(clipped);
    };
    child.stdout?.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => collect("stderr", chunk));

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // 进程树终止（windowsHide + taskkill 不可移植；kill 信号对单进程 hook 足够——v1 hook 不再派生约束入文档）
      child.kill("SIGKILL");
      setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref?.();
      resolvePromise({
        ...base,
        outcome: "timed_out",
        exitCode: null,
        durationMs: Date.now() - startedAt,
        stderr: out.stderr(),
        stdout: out.stdout(),
        reason: `hook timed out after ${String(timeoutMs)}ms`,
      });
    }, timeoutMs);

    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolvePromise({
        ...base,
        outcome: "failed",
        exitCode: null,
        durationMs: Date.now() - startedAt,
        stderr: out.stderr(),
        stdout: out.stdout(),
        reason: "hook aborted (turn cancelled)",
      });
    };
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        ...base,
        outcome: "failed",
        exitCode: null,
        durationMs: Date.now() - startedAt,
        stderr: out.stderr(),
        stdout: out.stdout(),
        reason: `spawn error: ${err.message}`,
      });
    });

    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = out.stdout();
      const stderr = out.stderr();
      // 空 stdout = no-op（CC/ZCode 口径）；exit 2 = 显式 block（CC 兼容）
      if (stdout.trim().length === 0) {
        resolvePromise({
          ...base,
          outcome: code === 0 ? "success" : code === 2 ? "blocked" : "failed",
          exitCode: code,
          durationMs: Date.now() - startedAt,
          stderr,
          stdout,
          ...(code !== 0 && { reason: `hook exited with code ${String(code)} (empty stdout)` }),
        });
        return;
      }
      const parsed = hookOutputSchema.safeParse(parseJsonLoose(stdout));
      if (!parsed.success) {
        resolvePromise({
          ...base,
          outcome: "failed",
          exitCode: code,
          durationMs: Date.now() - startedAt,
          stderr,
          stdout,
          reason: "hook stdout is not valid hook-output JSON (strict schema)",
        });
        return;
      }
      const output = parsed.data;
      const hookDecision = output.hookSpecificOutput?.permissionDecision;
      const blocked =
        output.decision === "block" ||
        output.continue === false ||
        hookDecision === "deny" ||
        code === 2;
      const reason =
        output.reason ??
        output.hookSpecificOutput?.permissionDecisionReason ??
        (blocked ? `blocked by hook (exit ${String(code ?? "null")})` : undefined);
      resolvePromise({
        ...base,
        outcome: blocked ? "blocked" : code === 0 ? "success" : "failed",
        exitCode: code,
        durationMs: Date.now() - startedAt,
        stderr,
        stdout,
        ...(reason !== undefined && { reason }),
        ...(output.decision !== undefined && { decision: output.decision }),
        ...(output.additionalContext !== undefined && { additionalContext: output.additionalContext }),
        ...(output.hookSpecificOutput?.additionalContext !== undefined && {
          additionalContext: output.hookSpecificOutput.additionalContext,
        }),
        ...(output.systemMessage !== undefined && { systemMessage: output.systemMessage }),
        ...(output.suppressOutput !== undefined && { suppressOutput: output.suppressOutput }),
      });
    });

    // stdin 写入后关闭；EPIPE（进程提前退出）不构成失败——close 按退出码收敛
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(stdinText, "utf8");
  });
  return spawnResult;
}

/**
 * 单 hook 输出对外的投影（内部收敛 → 稳定枚举；block 语义带 reason）。
 * HookOutcome = success | blocked | failed | timed_out（与 shared hookOutcomeSchema 对齐）。
 */

function parseJsonLoose(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
