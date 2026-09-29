/**
 * M1 NFR 基准统一入口（07-dev-plan §2.4 / 01-PRD §6.1 口径）。
 * 运行：pnpm bench:start|bench:send|bench:render|bench:resume|bench:crash|bench:all
 * 实现见 scripts/bench-lib.mts；任一不达标退出码非 0。
 */
import type { CheckResult } from "./bench-lib.mts";
import { benchCrash, benchRender, benchResume, benchSend, benchStart, fmt, printResult } from "./bench-lib.mts";

function usage(): number {
  process.stderr.write(
    [
      "usage: tsx scripts/bench.mts <start|send|render|resume|crash|all>",
      "",
      "  start   NFR-1  CLI 冷启动 ×20 中位数（≤2s）",
      "  send    NFR-2  send→模型请求本地开销 ×100 P95（≤300ms）",
      "  render  NFR-3  工具结果渲染延迟 ×100 P95（≤100ms）",
      "  resume  NFR-5  1 万条消息恢复 ×10 中位数（≤1s）",
      "  crash   NFR-7  强杀恢复专项用例（--times N 可重复，默认 1）",
      "  all     全部 + 汇总表（任一不达标退出码 1）",
      "",
    ].join("\n"),
  );
  return 2;
}

async function main(): Promise<number> {
  const sub = process.argv[2];
  const timesFlag = process.argv.indexOf("--times");
  const times = timesFlag >= 0 ? Number.parseInt(process.argv[timesFlag + 1] ?? "1", 10) || 1 : 1;
  console.log(`RainCode M1 NFR 基准 · ${new Date().toISOString()} · Node ${process.version} · ${process.platform}`);
  console.log("");
  const single = new Map<string, () => Promise<CheckResult>>([
    ["start", () => benchStart(20)],
    ["send", () => benchSend(100)],
    ["render", () => benchRender(100)],
    ["resume", () => benchResume(10)],
    ["crash", () => benchCrash(times)],
  ]);
  if (sub !== "all" && (sub === undefined || !single.has(sub))) {
    return usage();
  }
  const targets: Array<() => Promise<CheckResult>> =
    sub === "all" ? [...single.values()] : [single.get(sub as string)!];
  const results: CheckResult[] = [];
  for (const run of targets) {
    const result = await run();
    printResult(result);
    results.push(result);
  }
  if (sub === "all") {
    console.log("—— M1 NFR 汇总 ——");
    for (const r of results) {
      const actual = r.targetMs === null ? "PASS" : fmt(r.actualMs);
      console.log(`  ${r.nfr.padEnd(7)} ${r.pass ? "✅" : "❌"} 目标 ${r.target.padEnd(18)} 实测 ${actual}`);
    }
    console.log("");
  }
  return results.every((r) => r.pass) ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((reason: unknown) => {
    console.error("");
    console.error("BENCH FAILED:", reason);
    process.exitCode = 1;
  });
