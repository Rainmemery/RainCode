/**
 * CLI bundle 产物冒烟（T5.7 / L-16 验收：esbuild 前置编译产物 = 命令集与协议断言）。
 * 运行：pnpm smoke:bundle（脚本自跑 apps/cli/scripts/build.mjs 先行构建，产物断言一体化）。
 *
 * 形态：dist/raincode.mjs 单文件 bundle 以 node 直跑（非 tsx 源码路径）——
 *   A  命令集：help 输出六命令用法（ping/run/chat/serve/web/config）
 *   B  命令集负例：未知命令 exit 2
 *   C  配置管线：config dump --default-only exit 0（bundle 内配置归并装配）
 *   D  协议握手门禁：serve 下 ping 前 session.list → VERSION_MISMATCH（06 §1.4）
 *   E  协议握手：system.ping → protocolVersion/capabilities
 *   F  协议面：tool.tools.list → 13 内置工具 + agent 子代理派发工具（serve 装配面与源码运行一致）
 *   G  存储面：session.create → sessionId（bundle 自举 RAINCODE_MIGRATIONS_DIR 迁移执行证据）
 *   H  优雅退出：stdin end → exit 0
 *
 * 全程临时 RAINCODE_HOME；无外呼、无密钥。
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = join(REPO_ROOT, "apps", "cli", "dist", "raincode.mjs");
const BUILD_SCRIPT = join(REPO_ROOT, "apps", "cli", "scripts", "build.mjs");

const CLI_COMMANDS = ["ping", "run", "chat", "serve", "web", "config"];
const BUILTIN_TOOL_NAMES = [
  "read",
  "write",
  "edit",
  "glob",
  "grep",
  "bash",
  "web_fetch",
  "ask_user_question",
  "skill",
  "session_search",
  "mcp_tool_search",
  "todo_write",
  "todo_read",
  "agent",
];

interface Frame {
  kind: string;
  id?: string;
  ok?: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

class ServeChild {
  readonly frames: Frame[] = [];
  readonly stderrText: string;
  private readonly child: ReturnType<typeof spawn>;
  private exitCode: number | null | undefined = undefined;
  private buffer = "";

  constructor(home: string, workspace: string) {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (!key.startsWith("RAINCODE_PROVIDER_")) env[key] = value; // 无 Provider 形态
    }
    env["RAINCODE_HOME"] = home;
    this.stderrText = "";
    this.child = spawn(process.execPath, [BUNDLE, "serve"], {
      cwd: workspace,
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
      this.stderrText += chunk.toString("utf8");
    });
    this.child.on("exit", (code: number | null) => {
      this.exitCode = code;
    });
  }

  sendFrame(id: string, method: string, params: unknown = {}): void {
    this.child.stdin!.write(`${JSON.stringify({ kind: "request", id, method, params })}\n`);
  }

  async waitFor(id: string, timeoutMs = 15_000): Promise<Frame> {
    const started = Date.now();
    for (;;) {
      const hit = this.frames.find((frame) => frame.kind === "response" && frame.id === id);
      if (hit !== undefined) return hit;
      if (this.exitCode !== undefined) throw new Error(`serve exited early (code ${String(this.exitCode)})`);
      if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting response id=${id}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  async waitExit(timeoutMs = 15_000): Promise<number | null | undefined> {
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

async function main(): Promise<void> {
  // Step 0：构建（产物断言一体化；metafile 重复依赖校验在构建脚本内强制）
  const built = spawnSync(process.execPath, [BUILD_SCRIPT], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(built.status, 0, `bundle 构建失败: ${built.stderr?.slice(-500) ?? built.stdout?.slice(-500)}`);
  assert.ok(built.stdout!.includes("metafile 重复依赖校验通过"), "构建应执行 metafile 重复依赖校验");
  console.log("step 0: bundle 构建 + metafile 重复依赖校验 ✓");

  const home = mkdtempSync(join(tmpdir(), "raincode-smoke-bundle-home-"));
  const workspace = mkdtempSync(join(tmpdir(), "raincode-smoke-bundle-ws-"));
  let child: ServeChild | undefined;
  try {
    const run = (args: string[]): { status: number | null; stdout: string; stderr: string } =>
      spawnSync(process.execPath, [BUNDLE, ...args], { cwd: workspace, encoding: "utf8", env: { ...process.env, RAINCODE_HOME: home } });

    // A：命令集（help 六命令）
    const help = run(["help"]);
    assert.equal(help.status, 0, "help 应 exit 0");
    for (const command of CLI_COMMANDS) {
      assert.ok(help.stdout.includes(`raincode ${command}`), `help 应含命令 ${command}`);
    }
    console.log("A 命令集：help 六命令齐备 ✓");

    // B：命令集负例（未知命令 exit 2）
    const bogus = run(["bogus"]);
    assert.equal(bogus.status, 2, "未知命令应 exit 2");
    assert.ok(bogus.stderr.includes("unknown command: bogus"));
    console.log("B 命令集负例：未知命令 exit 2 ✓");

    // C：配置管线（config dump --default-only）
    const dump = run(["config", "dump", "--default-only"]);
    assert.equal(dump.status, 0, `config dump 应 exit 0: ${dump.stderr.slice(-200)}`);
    console.log("C 配置管线：config dump --default-only exit 0 ✓");

    // D~H：serve 协议断言
    child = new ServeChild(home, workspace);
    child.sendFrame("r1", "session.list", {});
    const r1 = await child.waitFor("r1");
    assert.equal(r1.error?.code, "VERSION_MISMATCH", "D. ping 前 session.list → VERSION_MISMATCH");
    console.log("D 协议握手门禁：ping 前 session.list → VERSION_MISMATCH ✓");

    child.sendFrame("r2", "system.ping");
    const r2 = await child.waitFor("r2");
    const ping = (r2.result ?? {}) as { protocolVersion?: string; capabilities?: string[] };
    assert.equal(r2.ok, true, "system.ping 应 ok");
    assert.ok(typeof ping.protocolVersion === "string" && ping.protocolVersion.length > 0);
    assert.ok(Array.isArray(ping.capabilities) && ping.capabilities.length > 0);
    console.log(`E 协议握手：system.ping（protocolVersion=${String(ping.protocolVersion)}）✓`);

    child.sendFrame("r3", "tool.tools.list", {});
    const r3 = await child.waitFor("r3");
    const tools = ((r3.result ?? {}) as { tools?: Array<{ name: string; source: string }> }).tools ?? [];
    assert.equal(tools.length, BUILTIN_TOOL_NAMES.length, `tool.tools.list 应返回 ${String(BUILTIN_TOOL_NAMES.length)} 内置工具`);
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      [...BUILTIN_TOOL_NAMES].sort(),
      "bundle 装配面内置工具名应与源码口径逐项一致",
    );
    assert.ok(tools.every((tool) => tool.source === "builtin"));
    console.log(`F 协议面：tool.tools.list ${String(tools.length)} 内置工具逐项一致 ✓`);

    child.sendFrame("r4", "session.create", { workspaceRoot: workspace, title: "smoke-bundle" });
    const r4 = await child.waitFor("r4");
    const created = (r4.result ?? {}) as { sessionId?: string };
    assert.equal(r4.ok, true, `session.create 应 ok（stderr: ${child.stderrText.slice(-200)}）`);
    assert.ok(typeof created.sessionId === "string" && created.sessionId.length > 0, "G. session.create 应返回 sessionId（bundle 迁移自举生效证据）");
    console.log(`G 存储面：session.create（migrations 自举生效）✓`);

    child.end();
    const code = await child.waitExit();
    assert.equal(code, 0, "H. stdin end → 优雅退出 exit 0");
    console.log("H 优雅退出：stdin end → exit 0 ✓");

    console.log("");
    console.log("SMOKE BUNDLE OK");
  } finally {
    // 先杀子进程释放 SQLite/文件句柄再清理；Windows 句柄释放存在竞态，清理失败不掩盖断言结论
    child?.kill();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    try {
      rmSync(home, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    } catch {
      // 临时目录清理失败仅留痕，不影响冒烟结论
    }
  }
}

main().catch((reason: unknown) => {
  console.error("SMOKE BUNDLE FAILED:", reason instanceof Error ? reason.message : String(reason));
  process.exitCode = 1;
});
