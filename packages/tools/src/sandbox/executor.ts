/**
 * 沙箱执行域（M3 T3.1 / 02-module-design §5.3 Executor 扩展点）。
 *
 * - Executor 只承载「命令投递到哪个执行域」（local / docker / wsl）；后台任务生命周期
 *   （kill/list/所有权）仍由 BackgroundTaskRegistry 持有（02 §5.3 的 start/kill/list 拆分申报：
 *   registry 单例是所有权与审计的事实源，Executor 保持无状态纯转换）；
 * - DockerExecutor 隔离策略（ES-3）：仅挂载 workspace（fs 隔离，主机其余路径容器内不可见）
 *   + `--network none` 缺省断网（可配 bridge）；容器随 CLI 进程退出 best-effort `rm -f` 清理；
 * - WslExecutor（ES-4）：Linux 环境隔离（完整发行版 fs 可见），非安全边界（02 §5.1 口径）；
 * - resolveSandboxExecutor：不可用（CLI 探测失败）即回退 local 并产出告警（02 §5.4），
 *   kind 标记真实执行环境（UI 展示口径）。
 */
import { execFile } from "node:child_process";
import { relative, resolve } from "node:path";
import type { SandboxConfig } from "@raincode/shared";
import { execLocal, spawnLocal, type ExecRequest, type ExecResult, type SpawnHandle } from "./local-executor.js";

export type ExecutorKind = "local" | "docker" | "wsl";

/** 执行域抽象（02 §5.3 Executor 的命令投递面；run=前台，spawn=后台/流式）。 */
export interface Executor {
  readonly kind: ExecutorKind;
  /** 模型/UI 可见的实际执行命令形态（诊断口径：本地命令串或容器 argv 拼接）。 */
  display(req: ExecRequest): string;
  run(req: ExecRequest): Promise<ExecResult>;
  spawn(req: ExecRequest): SpawnHandle;
}

/** 底层投递原语（可注入替身供单测断言 argv；缺省即本地受控执行）。 */
export interface ExecutorTransport {
  exec(req: ExecRequest): Promise<ExecResult>;
  spawn(req: ExecRequest): SpawnHandle;
}

const localTransport: ExecutorTransport = {
  exec: (req) => execLocal(req),
  spawn: (req) => spawnLocal(req),
};

/** 本地执行域（缺省；P0「约束非隔离」语义不变）。 */
export class LocalExecutor implements Executor {
  readonly kind = "local" as const;
  constructor(private readonly transport: ExecutorTransport = localTransport) {}
  display(req: ExecRequest): string {
    return req.command;
  }
  run(req: ExecRequest): Promise<ExecResult> {
    return this.transport.exec(req);
  }
  spawn(req: ExecRequest): SpawnHandle {
    return this.transport.spawn(req);
  }
}

/** docker 容器内挂载点（POSIX 约定；workspace 根 = 容器内唯一可见的主机目录）。 */
const DOCKER_WORKSPACE_MOUNT = "/workspace";
const DOCKER_IMAGE_DEFAULT = "node:20-bookworm-slim";
const DOCKER_SHELL = "/bin/sh";

function toPosixPath(p: string): string {
  return p.replace(/\\/g, "/");
}

function joinPosix(...parts: string[]): string {
  return parts.join("/").replace(/\/+/g, "/");
}

/** workspace 内 cwd → 容器内 -w 路径（bash 层 guardPath 已保证 cwd ∈ workspaceRoot；防御性收敛到挂载根）。 */
function dockerWorkdir(workspaceRoot: string, cwd: string): string {
  const rel = relative(resolve(workspaceRoot), resolve(cwd));
  if (rel.length === 0 || rel.startsWith("..")) {
    return DOCKER_WORKSPACE_MOUNT;
  }
  const relPosix = toPosixPath(rel);
  return relPosix === "." ? DOCKER_WORKSPACE_MOUNT : joinPosix(DOCKER_WORKSPACE_MOUNT, relPosix);
}

/** 注入项 → 容器 -e 参数（沙箱内无主机凭据，env 只含显式注入项 + 最小集，见 local-executor）。 */
function dockerEnvArgs(env: Record<string, string> | undefined): string[] {
  if (env === undefined) return [];
  const args: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    args.push("-e", `${key}=${value}`);
  }
  return args;
}

export class DockerExecutor implements Executor {
  readonly kind = "docker" as const;
  private readonly image: string;
  private readonly network: "none" | "bridge";
  private readonly transport: ExecutorTransport;

  constructor(
    options: { image?: string; network?: "none" | "bridge" } = {},
    transport: ExecutorTransport = localTransport,
  ) {
    this.image = options.image ?? DOCKER_IMAGE_DEFAULT;
    this.network = options.network ?? "none";
    this.transport = transport;
  }

  /** docker run argv（测试断言面：mount/网络/env/workdir 策略可见）。 */
  buildArgv(req: ExecRequest, name: string): { file: string; args: string[] } {
    const workspaceRoot = resolve(req.workspaceRoot ?? req.cwd);
    return {
      file: "docker",
      args: [
        "run",
        "--rm",
        `--name=${name}`,
        `--network=${this.network}`,
        "-v", `${workspaceRoot}:${DOCKER_WORKSPACE_MOUNT}`,
        "-w", dockerWorkdir(workspaceRoot, req.cwd),
        ...dockerEnvArgs(req.env),
        this.image,
        DOCKER_SHELL,
        "-c",
        req.command,
      ],
    };
  }

  display(req: ExecRequest): string {
    const { args } = this.buildArgv(req, "raincode");
    return `docker ${args.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}`;
  }

  private spawnDocker(req: ExecRequest): SpawnHandle {
    const name = `raincode-${process.pid}-${Date.now().toString(36)}`;
    const { file, args } = this.buildArgv(req, name);
    // 超时/取消由底层 spawnLocal 对 docker CLI 进程树终止；容器清理在 exit 后补 rm -f（best-effort，
    // 防 attached CLI 被硬杀后的容器孤儿——taskkill 不经 SIG 代理，信号无法转发）
    const handle = this.transport.spawn({ ...req, command: [file, ...args].join(" ") });
    void handle.exit.then(() => {
      // 非零退出码/输出不关心（.catch 兜底；避免 shell 方言差异——bash/powershell 回退下重定向语义不同）
      void this.transport
        .exec({ command: `docker rm -f ${name}`, cwd: process.cwd(), timeoutMs: 10_000 })
        .catch(() => undefined);
    });
    return handle;
  }

  run(req: ExecRequest): Promise<ExecResult> {
    const handle = this.spawnDocker(req);
    return (async () => {
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
    })();
  }

  spawn(req: ExecRequest): SpawnHandle {
    return this.spawnDocker(req);
  }
}

/**
 * WSL 执行域（ES-4）：Windows 路径经 `wsl --cd` 自动翻译（D:\a\b → /mnt/d/a/b）；
 * 完整发行版 fs 可见——环境隔离而非安全边界（02 §5.1，交付口径申报）。
 */
export class WslExecutor implements Executor {
  readonly kind = "wsl" as const;
  private readonly distro: string | undefined;
  private readonly transport: ExecutorTransport;

  constructor(options: { wslDistro?: string } = {}, transport: ExecutorTransport = localTransport) {
    this.distro = options.wslDistro;
    this.transport = transport;
  }

  /** env 注入：`env K=V ... /bin/sh -c`（POSIX env 前缀；继承发行版默认环境，不搬主机环境）。 */
  buildCommand(req: ExecRequest): string {
    const prefix = this.distro !== undefined ? `wsl -d ${this.distro}` : "wsl";
    const envEntries = Object.entries(req.env ?? {});
    const envPrefix = envEntries.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ");
    const shell = envPrefix.length > 0
      ? `env ${envPrefix} /bin/sh -c ${JSON.stringify(req.command)}`
      : `/bin/sh -c ${JSON.stringify(req.command)}`;
    return `${prefix} --cd ${JSON.stringify(req.cwd)} -e ${shell}`;
  }

  display(req: ExecRequest): string {
    return this.buildCommand(req);
  }

  run(req: ExecRequest): Promise<ExecResult> {
    return this.transport.exec({ ...req, command: this.buildCommand(req) });
  }

  spawn(req: ExecRequest): SpawnHandle {
    return this.transport.spawn({ ...req, command: this.buildCommand(req) });
  }
}

// ---------------------------------------------------------------------------
// 可用性探测与工厂（02 §5.4：不可用回退 local 并告警）
// ---------------------------------------------------------------------------

function probeByCli(command: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    execFile("cmd.exe", ["/d", "/s", "/c", command], { timeout: timeoutMs, windowsHide: true }, (err) => {
      resolvePromise(err === null);
    });
  });
}

/** CLI 探测（可注入替身；docker version / wsl --status 可执行即视为可用）。 */
export interface SandboxProbes {
  docker(): Promise<boolean>;
  wsl(): Promise<boolean>;
}

const defaultProbes: SandboxProbes = {
  docker: () => probeByCli("docker version --format ok", 8_000),
  wsl: () => probeByCli("wsl --status", 8_000),
};

export interface ResolvedSandboxExecutor {
  /** 实际生效执行域（配置期望不可用时 = local 回退）。 */
  executor: Executor;
  /** 期望执行域（配置值；诊断对照用）。 */
  requested: ExecutorKind;
  /** 回退/降级告警（diag 通道输出；空数组 = 按配置生效）。 */
  warnings: string[];
}

/** 解析沙箱执行域：未配置 → local（零探测开销）；docker/wsl 不可用 → 回退 local + 告警。 */
export async function resolveSandboxExecutor(
  config: SandboxConfig | undefined,
  probes: SandboxProbes = defaultProbes,
): Promise<ResolvedSandboxExecutor> {
  const requested = config?.executor ?? "local";
  if (requested === "docker") {
    if (await probes.docker()) {
      return {
        executor: new DockerExecutor({
          ...(config?.image !== undefined && { image: config.image }),
          ...(config?.network !== undefined && { network: config.network }),
        }),
        requested,
        warnings: [],
      };
    }
    return {
      executor: new LocalExecutor(),
      requested,
      warnings: [`sandbox.executor=docker 不可用（docker CLI 探测失败），回退 local（02 §5.4）`],
    };
  }
  if (requested === "wsl") {
    if (await probes.wsl()) {
      return {
        executor: new WslExecutor(config?.wslDistro !== undefined ? { wslDistro: config.wslDistro } : {}),
        requested,
        warnings: [],
      };
    }
    return {
      executor: new LocalExecutor(),
      requested,
      warnings: [`sandbox.executor=wsl 不可用（wsl 探测失败/无发行版），回退 local（02 §5.4）`],
    };
  }
  return { executor: new LocalExecutor(), requested, warnings: [] };
}
