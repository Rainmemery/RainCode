/** 开发态启动器：并发拉起 vite dev server 与 electron（RAINCODE_DESKTOP_VITE_URL 注入）。 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vitePort = 5173;
const viteUrl = `http://localhost:${String(vitePort)}`;

const vite = spawn("npx", ["vite", "--port", String(vitePort), "--strictPort"], {
  cwd: root,
  shell: true,
  stdio: "inherit",
});

async function waitForVite(timeoutMs = 30_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      const res = await fetch(viteUrl);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    if (Date.now() - started > timeoutMs) throw new Error("vite dev server did not start in time");
    await new Promise((r) => setTimeout(r, 300));
  }
}

try {
  await waitForVite();
  const electron = spawn("npx", ["electron", "."], {
    cwd: root,
    shell: true,
    stdio: "inherit",
    env: { ...process.env, RAINCODE_DESKTOP_VITE_URL: viteUrl },
  });
  let exitCode = 0;
  await new Promise((resolve) => {
    electron.on("exit", (code) => {
      exitCode = code ?? 0;
      resolve(null);
    });
  });
  vite.kill();
  process.exitCode = exitCode;
} catch (err) {
  console.error(err);
  vite.kill();
  process.exitCode = 1;
}
