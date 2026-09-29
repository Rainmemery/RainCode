/**
 * agent 子进程宿主（04-architecture §3.2/§3.3，T2.9）：spawn headless Agent Service
 * （raincode serve 同形态）并在 main 与子进程间做 stdio JSONL 帧桥。
 *
 * 职责边界（04 §3.2 泳道铁律）：main 只做字节转发与子进程生命周期守护——
 * 不解析 method/params，不保存会话/审批事实。纯 Node 实现（不 import electron），
 * 便于无 GUI 冒烟验证；事件经回调上抛，由 main.ts 桥到 renderer IPC。
 *
 * 守护策略（06 §6.2）：子进程意外退出 → onExit 上抛 + 自动重启（1.5s 退避，上限 5 次连续崩溃后停机）；
 * renderer 侧以 session.resume 补推快照恢复（NFR-7 数据零丢失）。
 */
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export interface AgentHostOptions {
  /** 子进程命令与参数（dev: node --import tsx … serve；packaged: ELECTRON_RUN_AS_NODE bundle）。 */
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** 意外退出后的重启退避毫秒（缺省 1500；测试注入短延迟）。 */
  restartDelayMs?: number;
  onDiagnostic?: (message: string, err?: unknown) => void;
}

export interface AgentExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** 本次存活期内是否发生过帧交互（区分「启动即崩」与「运行中崩溃」）。 */
  hadTraffic: boolean;
  /** true = 宿主已主动 stop（非意外退出，不触发自动重启）。 */
  intentional: boolean;
}

const RESTART_DELAY_MS = 1_500;
const MAX_CONSECUTIVE_CRASHES = 5;

export class AgentHost {
  private child: ReturnType<typeof spawn> | null = null;
  private readonly decoder = new StringDecoder("utf8");
  private lineBuffer = "";
  private exitListeners = new Set<(info: AgentExitInfo) => void>();
  private frameListeners = new Set<(line: string) => void>();
  private diagnostics: string[] = [];
  private consecutiveCrashes = 0;
  private restarting = false;
  private stopping = false;
  private hadTraffic = false;
  private readonly restartDelayMs: number;

  constructor(private readonly options: AgentHostOptions) {
    this.restartDelayMs = options.restartDelayMs ?? RESTART_DELAY_MS;
  }

  /** stderr 尾部诊断（崩溃报告用，上限 8KB）。 */
  stderrTail(max = 8_192): string {
    return this.diagnostics.join("").slice(-max);
  }

  get isRunning(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  onExit(listener: (info: AgentExitInfo) => void): () => void {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  /** 订阅子进程 stdout 帧行（已按 \n 切分、UTF-8 安全解码；空行不投递）。 */
  onFrameLine(listener: (line: string) => void): () => void {
    this.frameListeners.add(listener);
    return () => {
      this.frameListeners.delete(listener);
    };
  }

  start(): void {
    this.stopping = false;
    this.spawnChild();
  }

  /** 面向 renderer 的发送口：原样写入 stdin（main 不解析内容）。 */
  sendLine(line: string): void {
    const child = this.child;
    if (child === null || child.stdin === null || child.exitCode !== null) {
      throw new Error("TRANSPORT_CLOSED: agent child process is not running");
    }
    child.stdin.write(`${line}\n`);
  }

  /** 优雅停机：关 stdin（子进程收到 end 自行收尾退出）→ 兜底 kill。 */
  async stop(timeoutMs = 5_000): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (child === null) return;
    if (child.stdin !== null && child.exitCode === null) child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill();
        resolve();
      }, timeoutMs);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  // ---------------------------------------------------------------------------

  private spawnChild(): void {
    const diag = this.options.onDiagnostic;
    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.lineBuffer = "";
    diag?.(`agent child spawned pid=${String(child.pid)}`);
    child.stdout!.on("data", (chunk: Buffer) => this.onStdout(chunk));
    child.stderr!.on("data", (chunk: Buffer) => {
      this.diagnostics.push(chunk.toString("utf8"));
      this.diagnostics = this.diagnostics.slice(-64); // 环形保留最近块
    });
    child.on("error", (err: Error) => diag?.("agent child spawn error", err));
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      this.child = null;
      this.handleExit(code, signal);
    });
  }

  private onStdout(chunk: Buffer): void {
    this.hadTraffic = true;
    this.lineBuffer += this.decoder.write(chunk);
    let idx = this.lineBuffer.indexOf("\n");
    while (idx !== -1) {
      const line = this.lineBuffer.slice(0, idx).trim();
      this.lineBuffer = this.lineBuffer.slice(idx + 1);
      if (line.length > 0) {
        for (const listener of [...this.frameListeners]) listener(line);
      }
      idx = this.lineBuffer.indexOf("\n");
    }
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    const info: AgentExitInfo = {
      code,
      signal,
      hadTraffic: this.hadTraffic,
      intentional: this.stopping,
    };
    this.hadTraffic = false;
    for (const listener of [...this.exitListeners]) {
      try {
        listener(info);
      } catch (err) {
        this.options.onDiagnostic?.("agent exit listener threw", err);
      }
    }
    // 守护重启（04 §3.3）：非主动停机 → 退避重启；连续崩溃超限 → 停机交由 renderer 呈现
    if (this.stopping || this.restarting) return;
    this.consecutiveCrashes = info.hadTraffic ? 0 : this.consecutiveCrashes + 1;
    if (this.consecutiveCrashes >= MAX_CONSECUTIVE_CRASHES) {
      this.options.onDiagnostic?.(
        `agent child crashed ${String(this.consecutiveCrashes)}x consecutively, giving up`,
      );
      return;
    }
    this.restarting = true;
    setTimeout(() => {
      this.restarting = false;
      if (!this.stopping && this.child === null) this.spawnChild();
    }, this.restartDelayMs);
  }
}
