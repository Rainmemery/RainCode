/**
 * AgentHost 单测（T2.9）：stdio 帧桥转发 / sendLine 写入 / 优雅 stop / 崩溃守护重启。
 * 子进程用 node fixture 脚本（echo / 自退出），无 electron 依赖。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentHost } from "../src/main/agent-host.js";

async function withFixture(body: string): Promise<{ path: string; dispose: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "raincode-agent-host-"));
  const path = join(dir, "fixture.mjs");
  await writeFile(path, body, "utf8");
  return { path, dispose: () => rm(dir, { recursive: true, force: true }) };
}

test("AgentHost: stdout 帧行转发 + sendLine 写入（echo fixture）", async () => {
  const fx = await withFixture(
    `process.stdin.on("data", (c) => process.stdout.write(c));\n` +
      `process.stdin.on("end", () => process.exit(0));\n` +
      `process.stdout.write("hello\\nworld\\n");\n`,
  );
  const host = new AgentHost({ command: process.execPath, args: [fx.path] });
  const lines: string[] = [];
  host.onFrameLine((line) => lines.push(line));
  host.start();
  const started = Date.now();
  while (lines.length < 2 && Date.now() - started < 3000) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.deepEqual(lines.slice(0, 2), ["hello", "world"]);
  host.sendLine(`{"kind":"request","id":"r1"}`);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(lines.length >= 3, true, "echo fixture 应回显 sendLine 写入的帧");
  await host.stop();
  await fx.dispose();
});

test("AgentHost: stop() → exit 事件 intentional=true；isRunning 翻转", async () => {
  const fx = await withFixture(
    `let buf="";\n` +
      `process.stdin.on("data", (c) => { buf += c.toString(); });\n` +
      `process.stdin.on("end", () => { process.stdout.write("bye\\n"); process.exit(0); });\n`,
  );
  const host = new AgentHost({ command: process.execPath, args: [fx.path] });
  const exits: Array<{ intentional: boolean; code: number | null }> = [];
  host.onExit((info) => exits.push({ intentional: info.intentional, code: info.code }));
  host.start();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(host.isRunning, true);
  await host.stop(3000);
  assert.equal(host.isRunning, false);
  assert.equal(exits.length, 1);
  assert.equal(exits[0]!.intentional, true);
  await fx.dispose();
});

test("AgentHost: 意外崩溃 → 自动重启（新进程恢复帧交互）", async () => {
  const fx = await withFixture(
    `import { existsSync, writeFileSync } from "node:fs";\n` +
      `const marker = process.env["FIXTURE_STATE"];\n` +
      `if (!existsSync(marker)) {\n` +
      `  process.stdout.write("round1\\n");\n` +
      `  writeFileSync(marker, "1");\n` +
      `  setTimeout(() => process.exit(1), 30);\n` +
      `} else {\n` +
      `  process.stdout.write("round2\\n");\n` +
      `}\n`,
  );
  const stateFile = join(fx.path, "..", "state.marker");
  const host = new AgentHost({
    command: process.execPath,
    args: [fx.path],
    env: { ...process.env, FIXTURE_STATE: stateFile },
    restartDelayMs: 30,
  });
  const lines: string[] = [];
  const exits: Array<{ intentional: boolean }> = [];
  host.onFrameLine((line) => lines.push(line));
  host.onExit((info) => exits.push({ intentional: info.intentional }));
  host.start();
  const started = Date.now();
  while (!lines.includes("round2") && Date.now() - started < 5000) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(lines.includes("round1"), true, "首轮帧应到达");
  assert.equal(lines.includes("round2"), true, "崩溃后应自动重启并再次产出帧");
  assert.equal(exits.some((e) => !e.intentional), true, "应有一次非主动退出事件");
  await host.stop();
  await fx.dispose();
});
