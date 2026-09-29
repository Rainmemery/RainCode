/**
 * NFR-4 桌面端空载内存基准（M2 T2.10 / 01-PRD §6.1：三进程内存汇总，空载 5 分钟，≤ 500MB）。
 * 运行：pnpm build:desktop 后 `pnpm bench:mem:desktop`（electron 窗口会真实弹出，属测量必需）。
 *
 * 口径申报：以进程树 WorkingSet64 汇总（Get-Process，与任务管理器「内存」列同源 Win32 数据，
 * 即口径中的「任务管理器交叉验证」通道）；process.memoryUsage 的进程内 rss 打点需三进程各自
 * 内嵌采样端点，Alpha 阶段以同源外部采样等价替代（含共享页重复计账，口径偏保守）。
 * 进程树 = electron main + renderer/GPU 子进程 + agent 子进程（ELECTRON_RUN_AS_NODE bundle）。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP = join(REPO_ROOT, "apps", "desktop");
const ELECTRON = join(DESKTOP, "node_modules", "electron", "dist", "electron.exe");
const MAIN_CJS = join(DESKTOP, "dist-electron", "main", "main.cjs");
const RENDERER_HTML = join(DESKTOP, "dist", "renderer", "index.html");
const AGENT_CJS = join(DESKTOP, "dist-electron", "agent", "entry.cjs");
const TARGET_MB = 500;
const WARMUP_MS = 60_000;
const SAMPLE_INTERVAL_MS = 30_000;
const SAMPLE_COUNT = 10; // 60s 预热 + 10×30s = 5 分钟空载窗口

function assertPrebuilt(): void {
  for (const artifact of [ELECTRON, MAIN_CJS, RENDERER_HTML, AGENT_CJS]) {
    if (!existsSync(artifact)) {
      throw new Error(`缺少构建产物 ${artifact} —— 先执行 pnpm --filter @raincode/desktop build`);
    }
  }
}

/** 进程树 WorkingSet 快照（MB）：rootPid 为根，BFS ParentProcessId；进程消失按 0 计（容忍瞬态）。 */
function sampleTreeWorkingSetMb(rootPid: number): { totalMb: number; processes: Array<{ pid: number; name: string; mb: number }> } {
  const csv = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize | ConvertTo-Csv -NoTypeInformation",
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  const lines = (csv.stdout ?? "").split(/\r?\n/).filter((l) => l.trim().length > 0);
  interface Row {
    pid: number;
    parent: number;
    name: string;
    ws: number;
  }
  const rows: Row[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cols = lines[i]!.split('","').map((c) => c.replace(/^"|"$/g, ""));
    rows.push({
      pid: Number(cols[0]),
      parent: Number(cols[1]),
      name: cols[2] ?? "",
      ws: Number(cols[3] ?? 0),
    });
  }
  const byPid = new Map<number, Row>();
  for (const row of rows) byPid.set(row.pid, row);
  const tree: Row[] = [];
  const queue = [rootPid];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const row = byPid.get(pid);
    if (row === undefined) continue;
    tree.push(row);
    for (const candidate of rows) {
      if (candidate.parent === pid) queue.push(candidate.pid);
    }
  }
  const processes = tree.map((row) => ({
    pid: row.pid,
    name: row.name,
    mb: Math.round((row.ws / 1024 / 1024) * 10) / 10,
  }));
  const totalMb = Math.round(processes.reduce((sum, p) => sum + p.mb, 0) * 10) / 10;
  return { totalMb, processes };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round(((sorted[mid - 1]! + sorted[mid]!) / 2) * 10) / 10;
}

async function main(): Promise<void> {
  assertPrebuilt();
  console.log("NFR-4 桌面端空载内存基准启动（electron 窗口将弹出；预热 60s + 采样 10×30s = 5 分钟窗口）");
  const child = spawn(ELECTRON, [DESKTOP], {
    cwd: DESKTOP,
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: "0" },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: false,
  });
  let stderrTail = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-4000);
  });
  const started = Date.now();
  const samples: Array<{ at: string; totalMb: number }> = [];
  let exitCode: number | null | undefined = undefined;
  child.on("exit", (code) => {
    exitCode = code;
  });

  try {
    await new Promise((r) => setTimeout(r, WARMUP_MS));
    if (exitCode !== undefined) throw new Error(`electron 提前退出 code=${String(exitCode)}\n${stderrTail}`);
    for (let i = 0; i < SAMPLE_COUNT; i += 1) {
      if (exitCode !== undefined) throw new Error(`electron 提前退出 code=${String(exitCode)}\n${stderrTail}`);
      const { totalMb, processes } = sampleTreeWorkingSetMb(child.pid!);
      const at = `${String(Math.round((Date.now() - started) / 1000))}s`;
      samples.push({ at, totalMb });
      const detail = processes.map((p) => `${p.name}#${String(p.pid)}=${String(p.mb)}MB`).join(" + ");
      console.log(`  sample ${String(i + 1)}/${String(SAMPLE_COUNT)} @${at} → ${String(totalMb)}MB（${detail}）`);
      if (i < SAMPLE_COUNT - 1) await new Promise((r) => setTimeout(r, SAMPLE_INTERVAL_MS));
    }
    const values = samples.map((s) => s.totalMb);
    const med = median(values);
    const max = Math.max(...values);
    const pass = max <= TARGET_MB;
    console.log("\n—— NFR-4 桌面端空载内存 ——");
    console.log(`  目标: ≤ ${String(TARGET_MB)}MB（三进程汇总，空载 5 分钟窗口）`);
    console.log(`  实测: 中位数 ${String(med)}MB · 峰值 ${String(max)}MB（n=${String(samples.length)}）`);
    console.log(`  结论: ${pass ? "✅ 达标" : "❌ 未达标"}`);
    if (!pass) process.exitCode = 1;
  } finally {
    if (exitCode === undefined) {
      child.kill();
      await new Promise((r) => setTimeout(r, 1500));
      if (exitCode === undefined) spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
    }
  }
}

await main();
