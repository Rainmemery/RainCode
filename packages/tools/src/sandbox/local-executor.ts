/**
 * 本地受控执行（02-module-design §5 Execution Sandbox · P0 本地约束层）。
 *
 * - shell 选择（Windows 优先）：`where bash.exe` 探测 Git-Bash / MSYS bash；缺失回退
 *   PowerShell（powershell.exe -NoProfile -NonInteractive -Command）并在交付报告申报；
 *   posix 回退 /bin/sh -c（注释：后续可抽 Executor 接口接入 WSL/Docker，02 §5.3 P2 扩展点）；
 * - 输出经 OutputRingBuffer 环形缓冲封顶（maxOutputBytes，头 70% / 尾 30%）；
 * - 超时默认 120s、上限 600s；超时/取消经进程树终止（Windows: taskkill /T /F）；
 * - 环境变量最小集继承（02 §5.3），凭据类变量由注入方过滤，本层不读任何密钥。
 */
import { spawn, exec } from "node:child_process";
import { OutputRingBuffer } from "../truncate.js";

export interface ExecRequest {
  /** 平台 shell 命令串。 */
  command: string;
  /** 必须位于 workspaceRoot 内（调用方经 guardPath 校验）。 */
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  onOutput?: (stream: "stdout" | "stderr", text: string) => void;
}

export interface ExecResult {
  exitCode: number | null;
  /** 环形缓冲裁剪后的 stdout。 */
  stdout: string;
  /** 环形缓冲裁剪后的 stderr。 */
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
  killed: boolean;
}

export type ShellKind = "bash" | "powershell" | "sh";

export interface ResolvedShell {
  kind: ShellKind;
  file: string;
  prefixArgs: string[];
}

/** spawnLocal 句柄：前台 await exit 收敛；后台持续持有读取产出与 pid。 */
export interface SpawnHandle {
  pid: number | null;
  exit: Promise<{
    exitCode: number | null;
    timedOut: boolean;
    killed: boolean;
    durationMs: number;
  }>;
  stdout(): string;
  stderr(): string;
  truncated(): boolean;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;

let shellCache: Promise<ResolvedShell> | null = null;

/** 平台 shell 探测（进程内缓存一次；Windows 优先 bash.exe，缺失回退 PowerShell）。 */
export function resolveShell(): Promise<ResolvedShell> {
  if (shellCache !== null) {
    return shellCache;
  }
  shellCache = new Promise((resolvePromise) => {
    if (process.platform !== "win32") {
      resolvePromise({ kind: "sh", file: "/bin/sh", prefixArgs: ["-c"] });
      return;
    }
    exec("where bash.exe", { timeout: 5_000 }, (err, stdout) => {
      if (!err && typeof stdout === "string") {
        const firstLine = stdout.split(/\r?\n/).find((line) => line.trim().length > 0);
        if (firstLine !== undefined) {
          resolvePromise({ kind: "bash", file: firstLine.trim(), prefixArgs: ["-c"] });
          return;
        }
      }
      // bash.exe 缺失：回退 PowerShell（交付报告已申报的行为差异）
      resolvePromise({
        kind: "powershell",
        file: `${process.env["SystemRoot"] ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
        prefixArgs: ["-NoProfile", "-NonInteractive", "-Command"],
      });
    });
  });
  return shellCache;
}

/** 环境变量最小集（02 §5.3：平台必需项 + 显式注入项）。 */
function minimalEnv(): NodeJS.ProcessEnv {
  const keep = [
    "PATH",
    "PATHEXT",
    "COMSPEC",
    "SystemRoot",
    "SYSTEMDRIVE",
    "windir",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMFILES",
    "NUMBER_OF_PROCESSORS",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keep) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

async function killProcessTreeWindows(pid: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    exec(`taskkill /PID ${String(pid)} /T /F`, { timeout: 10_000 }, () => resolvePromise(true));
  });
}

/** 进程树安全终止（02 §5.3 ProcessTreeTerminator 最小实现；posix 走进程组）。 */
export async function killProcessTree(pid: number): Promise<boolean> {
  if (process.platform === "win32") {
    return killProcessTreeWindows(pid);
  }
  try {
    process.kill(-pid, "SIGKILL"); // detached + 进程组
    return true;
  } catch {
    try {
      process.kill(pid, "SIGKILL");
      return true;
    } catch {
      return false;
    }
  }
}

/** 受控 spawn（前台/后台共用原语）：环形缓冲输出 + 超时/取消进程树终止。 */
export function spawnLocal(req: ExecRequest): SpawnHandle {
  const timeoutMs = Math.min(req.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const maxOutputBytes = req.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const startedAt = Date.now();

  const stdout = new OutputRingBuffer(maxOutputBytes);
  const stderr = new OutputRingBuffer(maxOutputBytes);
  let timedOut = false;
  let killed = false;

  type ExitInfo = { exitCode: number | null; timedOut: boolean; killed: boolean; durationMs: number };
  let exitResolve!: (v: ExitInfo) => void;
  const exit = new Promise<ExitInfo>((resolvePromise) => {
    exitResolve = resolvePromise;
  });

  const handle: SpawnHandle = {
    pid: null,
    exit,
    stdout: () => stdout.text(),
    stderr: () => stderr.text(),
    truncated: () => stdout.truncated || stderr.truncated,
  };

  void resolveShell().then((shell) => {
    const proc = spawn(shell.file, [...shell.prefixArgs, req.command], {
      cwd: req.cwd,
      env: { ...minimalEnv(), ...(req.env ?? {}) },
      detached: process.platform !== "win32", // posix：独立进程组，便于整树终止
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    handle.pid = proc.pid ?? null;

    const settle = (exitCode: number | null): void => {
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", onAbort);
      exitResolve({
        exitCode,
        timedOut,
        killed,
        durationMs: Date.now() - startedAt,
      });
    };

    const abortIfNeeded = (isTimeout: boolean): void => {
      if (isTimeout) timedOut = true;
      killed = true;
      void killProcessTree(proc.pid ?? -1);
    };

    const timer = setTimeout(() => {
      abortIfNeeded(true);
    }, timeoutMs);
    const onAbort = (): void => {
      abortIfNeeded(false);
    };
    req.signal?.addEventListener("abort", onAbort, { once: true });

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      req.onOutput?.("stdout", chunk.toString("utf8"));
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
      req.onOutput?.("stderr", chunk.toString("utf8"));
    });
    proc.once("exit", (code) => {
      settle(code);
    });
    proc.once("error", () => {
      settle(null); // spawn 失败（如 shell 不存在）：exitCode null，stderr 带诊断
      stderr.push(Buffer.from(`[novacode] failed to spawn ${shell.file}\n`, "utf8"));
    });
  });

  return handle;
}

/** 前台受控执行（02 §5.3 ExecRequest/ExecResult 最小落地）。 */
export async function execLocal(req: ExecRequest): Promise<ExecResult> {
  const handle = spawnLocal(req);
  const exit = await handle.exit;
  return {
    exitCode: exit.exitCode,
    stdout: handle.stdout(),
    stderr: handle.stderr(),
    timedOut: exit.timedOut,
    truncated: handle.truncated(),
    durationMs: exit.durationMs,
    killed: exit.killed,
  };
}
