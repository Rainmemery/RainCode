/**
 * T2.8 stdio 绑定 + headless 入口冒烟（07-dev-plan T2.8 验收：stdio 帧人工 cat 调试等价路径）。
 *
 * 以子进程 spawn `raincode serve`（无 Provider，ping/list/create/resume 均可用），逐场景断言：
 *   A  握手门禁：ping 前发 session.list → VERSION_MISMATCH（06 §1.4）
 *   B  system.ping → ok + protocolVersion/capabilities（帧可人工 cat 重放的等价形态）
 *   C  畸形行带 id → PARSE_ERROR response（06 §1.2）
 *   D  畸形行无 id → 丢弃 + stderr 告警，连接不断开
 *   E  session.create → session.resume 幂等快照：snapshot 字段齐全（messages 尾增量 / pendingApprovals 补推位）
 *   F  stdin end → 进程优雅退出（exit 0）
 * 全程仅本机回环与临时目录：无外呼、无真实密钥。
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI_ENTRY = join(REPO_ROOT, "apps", "cli", "src", "index.ts");

interface Frame {
  kind: string;
  id?: string;
  ok?: boolean;
  result?: unknown;
  error?: { code: string; message: string };
  name?: string;
  payload?: unknown;
}

class ServeChild {
  readonly frames: Frame[] = [];
  readonly stderrText: string;
  private readonly child: ReturnType<typeof spawn>;
  private exitCode: number | null | undefined = undefined;
  private buffer = "";

  constructor(home: string) {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (!key.startsWith("RAINCODE_PROVIDER_")) env[key] = value; // 无 Provider 形态
    }
    env["RAINCODE_HOME"] = home;
    this.stderrText = "";
    this.child = spawn(process.execPath, ["--import", "tsx", CLI_ENTRY, "serve"], {
      cwd: REPO_ROOT,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout!.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      let idx = this.buffer.indexOf("\n");
      while (idx !== -1) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (line.length > 0) this.frames.push(JSON.parse(line) as Frame);
        idx = this.buffer.indexOf("\n");
      }
    });
    this.child.stderr!.on("data", (chunk: Buffer) => {
      this.stderrText += chunk.toString("utf8"); // 诊断日志走 stderr（02 §3.4）
    });
    this.child.on("exit", (code: number | null) => {
      this.exitCode = code;
    });
  }

  send(line: string): void {
    this.child.stdin!.write(`${line}\n`);
  }

  sendFrame(id: string, method: string, params: unknown = {}): void {
    this.send(JSON.stringify({ kind: "request", id, method, params }));
  }

  /** 等待指定 id 的 response 到达（06 §1.2 id 关联）。 */
  async waitFor(id: string, timeoutMs = 10_000): Promise<Frame> {
    const started = Date.now();
    for (;;) {
      const hit = this.frames.find((frame) => frame.kind === "response" && frame.id === id);
      if (hit !== undefined) return hit;
      if (this.exitCode !== undefined) throw new Error(`serve exited early (code ${String(this.exitCode)})`);
      if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting response id=${id}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  async waitExit(timeoutMs = 10_000): Promise<number> {
    const started = Date.now();
    while (this.exitCode === undefined) {
      if (Date.now() - started > timeoutMs) throw new Error("serve did not exit after stdin end");
      await new Promise((r) => setTimeout(r, 20));
    }
    return this.exitCode;
  }

  end(): void {
    this.child.stdin!.end();
  }

  kill(): void {
    this.child.kill();
  }
}

let failures = 0;
function check(cond: boolean, label: string): void {
  if (cond) {
    console.log(`  PASS ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}`);
  }
}

async function main(): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "raincode-smoke-stdio-"));
  const child = new ServeChild(home);
  try {
    // A. 握手门禁：ping 前发 session.list → VERSION_MISMATCH
    child.sendFrame("r1", "session.list", {});
    const r1 = await child.waitFor("r1");
    check(r1.ok === false && r1.error?.code === "VERSION_MISMATCH", "A. 握手门禁（ping 前 session.list → VERSION_MISMATCH）");

    // B. system.ping → ok
    child.sendFrame("r2", "system.ping");
    const r2 = await child.waitFor("r2");
    const ping = (r2.result ?? {}) as { protocolVersion?: string; capabilities?: string[] };
    check(r2.ok === true && typeof ping.protocolVersion === "string" && Array.isArray(ping.capabilities), `B. system.ping 握手（protocolVersion=${String(ping.protocolVersion)} capabilities=${String(ping.capabilities?.length)} 项）`);

    // C. 畸形行带 id → PARSE_ERROR（非 JSON 行 + 结构残缺行各一）
    child.send(`{"kind":"request","id":"r3","method":"session.list","params":`);
    child.send(`totally-not-json {"id":"r3b"`);
    const r3 = await child.waitFor("r3");
    await child.waitFor("r3b");
    check(r3.ok === false && r3.error?.code === "PARSE_ERROR", "C. 畸形行带 id → PARSE_ERROR response（不断开）");

    // D. 畸形行无 id → 丢弃（无出站帧）+ stderr 告警，连接继续可用
    const before = child.frames.length;
    child.send(`}{ broken`);
    child.sendFrame("r4", "system.ping");
    const r4 = await child.waitFor("r4");
    check(r4.ok === true && child.frames.length === before + 1, "D. 畸形行无 id → 丢弃且连接继续（stderr 告警）");
    check(child.stderrText.length > 0, `D2. 诊断日志走 stderr（${String(child.stderrText.split("\n").length - 1)} 行）`);

    // E. session.create → session.resume 幂等快照（补推位字段齐全）
    child.sendFrame("r5", "session.create", { workspaceRoot: process.cwd(), title: "smoke-stdio" });
    const r5 = await child.waitFor("r5", 15_000);
    const created = (r5.result ?? {}) as { sessionId?: string };
    check(r5.ok === true && typeof created.sessionId === "string", `E1. session.create（id=${String(created.sessionId)}）`);
    child.sendFrame("r6", "session.resume", { sessionId: created.sessionId });
    const r6 = await child.waitFor("r6", 15_000);
    const snapshot = ((r6.result ?? {}) as { snapshot?: Record<string, unknown> }).snapshot ?? {};
    check(
      r6.ok === true &&
        typeof snapshot["lastSeq"] === "number" &&
        typeof snapshot["phase"] === "string" &&
        typeof snapshot["model"] === "string" &&
        typeof snapshot["contextUsage"] === "object" &&
        Array.isArray(snapshot["messages"]) &&
        Array.isArray(snapshot["pendingApprovals"]),
      `E2. session.resume 幂等快照字段齐全（lastSeq=${String(snapshot["lastSeq"])} phase=${String(snapshot["phase"])} messages=${String((snapshot["messages"] as unknown[]).length)} pendingApprovals=${String((snapshot["pendingApprovals"] as unknown[]).length)}）`,
    );

    // F. stdin end → 优雅退出
    child.end();
    const code = await child.waitExit();
    check(code === 0, `F. stdin end → 进程退出 code=0（实际 ${String(code)}）`);

    console.log(failures === 0 ? "\nsmoke:stdio ALL PASS" : `\nsmoke:stdio FAILED (${String(failures)})`);
  } catch (err: unknown) {
    failures += 1;
    console.error("\nsmoke:stdio ERROR:", err instanceof Error ? err.message : err);
    console.error("stderr tail:", child.stderrText.slice(-800));
    child.kill();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
  if (failures > 0) process.exitCode = 1;
}

await main();
