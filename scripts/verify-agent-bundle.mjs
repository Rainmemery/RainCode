// 打包形态 agent 入口冒烟：echo ping 帧 → 期待 pong response（node ABI 直跑 bundle）
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "desktop", "dist-electron", "agent", "entry.cjs");
const child = spawn(process.execPath, [entry], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
  env: {
    ...process.env,
    RAINCODE_MIGRATIONS_DIR: join(dirname(entry), "migrations"),
    RAINCODE_APP_VERSION: "0.1.0",
  },
});
let buffer = "";
const failures = [];
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let idx = buffer.indexOf("\n");
  while (idx !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line.length > 0) {
      try {
        const frame = JSON.parse(line);
        if (frame.kind === "response" && frame.id === "r1" && frame.ok === true) {
          console.log("PASS packaged agent entry ping/pong");
          child.kill();
          process.exit(0);
        }
      } catch (err) {
        failures.push(String(err));
      }
    }
    idx = buffer.indexOf("\n");
  }
});
child.stderr.on("data", (chunk) => process.stderr.write(`[agent stderr] ${chunk.toString("utf8")}`));
child.on("exit", (code) => {
  console.error(`FAIL packaged agent entry exited code=${String(code)}`);
  process.exit(1);
});
child.stdin.write('{"kind":"request","id":"r1","method":"system.ping","params":{}}\n');
setTimeout(() => {
  console.error("FAIL timeout waiting pong");
  child.kill();
  process.exit(1);
}, 15_000);
