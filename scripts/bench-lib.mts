/**
 * M1 NFR 基准实现库（口径=07-dev-plan §2.4 / 01-PRD §6.1，不另行定义新口径）。
 * 由 scripts/bench.mts（子命令入口）调用。五个基准：
 *   start   NFR-1  `novacode ping` 冷启动 ×20 中位数（spawn tsx CLI，计时至 stdout 首个版本输出；附 P95）
 *   send    NFR-2  session.send 受理→ModelRequest 发出 ×100 P95（p0-lib mock 请求捕获时间戳）
 *   render  NFR-3  tool_call.completed→CLI 渲染完成 ×100 P95（进程内 harness，复刻 stream.ts completed 分支）
 *   resume  NFR-5  1 万条消息会话（批量写入 events.jsonl，无 checkpoint=full-replay 最坏路径）
 *                  → Storage.open + resumeSession 全流程 ×10 中位数
 *   crash   NFR-7  turn 进行中强杀（bash 慢命令执行中 taskkill /F /T）→ 重开 storage → resume →
 *                  断言：已完成消息零丢失 / 悬挂 tool_call 补齐 isError / message_count 对账一致
 * 全程仅本机回环与临时目录：无外呼、无真实密钥；测量含 tsx 启动开销（当前 CLI 交付形态）。
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, appendFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";
import { createInMemoryTransportPair, createRpcClient } from "../packages/rpc/src/index.ts";
import { createAgentServiceNode } from "../packages/server/src/index.ts";
import { Storage, parseLine } from "../packages/storage/src/index.ts";
import type { MessageRecord, ToolCallCompletedEventPayload } from "../packages/shared/src/index.ts";
import type { SseScript } from "./p0-lib.mts";
import { beginTurn, startMockLlmServer, textScript, toolCallFrame, withTimeout } from "./p0-lib.mts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI_ENTRY = join(REPO_ROOT, "apps", "cli", "src", "index.ts");
const SUMMARY_MAX_CHARS = 120; // 与 apps/cli/src/stream.ts 单行摘要上限一致

// --- 统计与结果表 ---

export interface CheckResult {
  nfr: string;
  name: string;
  target: string;
  /** 目标阈值（ms），null=约束型（仅 PASS/FAIL）。 */
  targetMs: number | null;
  /** 主实测值（ms）。 */
  actualMs: number;
  detail: string;
  pass: boolean;
}

interface Stats { median: number; p95: number; min: number; max: number; n: number }

function percentile(sortedSamples: number[], p: number): number {
  if (sortedSamples.length === 0) return 0;
  const index = Math.min(sortedSamples.length - 1, Math.max(0, Math.ceil((p / 100) * sortedSamples.length) - 1));
  return sortedSamples[index] ?? 0;
}

function stats(samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    median: percentile(sorted, 50), p95: percentile(sorted, 95),
    min: sorted[0] ?? 0, max: sorted[sorted.length - 1] ?? 0, n: sorted.length,
  };
}

export function fmt(ms: number): string {
  return `${ms.toFixed(1)}ms`;
}

export function printResult(result: CheckResult): void {
  console.log(`—— ${result.nfr} ${result.name} ——`);
  console.log(`  目标: ${result.target}`);
  console.log(`  实测: ${result.targetMs === null ? "PASS（约束型专项用例）" : fmt(result.actualMs)}`);
  if (result.detail.length > 0) console.log(`  说明: ${result.detail}`);
  console.log(`  结论: ${result.pass ? "✅ 达标" : "❌ 未达标"}`);
  console.log("");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/** 临时隔离环境：独立 NOVACODE_HOME + workspace 目录。 */
async function isolatedEnv(prefix: string): Promise<{ home: string; workspace: string; dispose: () => Promise<void> }> {
  const home = await mkdtemp(join(tmpdir(), `novacode-bench-${prefix}-`));
  const workspace = join(home, "ws");
  await mkdir(workspace, { recursive: true });
  return { home, workspace, dispose: () => rm(home, { recursive: true, force: true }) };
}

/** 任意工具调用脚本项（round 1 发起 tool_call；round 2 由调用方追加纯文本脚本项）。 */
function toolCallScript(id: string, name: string, args: object): SseScript {
  const frames = [
    { choices: [{ index: 0, delta: { role: "assistant", content: "" } }] },
    toolCallFrame(id, name, args),
  ];
  return { frames, finish: "tool_calls" as const };
}

// --- NFR-1 start：novacode ping 冷启动 ---

function pingColdStartOnce(home: string): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const t0 = performance.now();
    let firstOutputAt = 0;
    let stderr = "";
    const child = spawn(process.execPath, ["--import", "tsx", CLI_ENTRY, "ping"], {
      cwd: REPO_ROOT,
      env: { ...process.env, NOVACODE_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", () => {
      if (firstOutputAt === 0) firstOutputAt = performance.now() - t0; // stdout 首个版本输出即 ready 等价打点
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", rejectPromise);
    child.on("exit", (code: number | null) => {
      if (code !== 0) rejectPromise(new Error(`novacode ping exit ${String(code)}: ${stderr.slice(0, 400)}`));
      else resolvePromise(firstOutputAt);
    });
  });
}

export async function benchStart(runs = 20): Promise<CheckResult> {
  const env = await isolatedEnv("start");
  const samples: number[] = [];
  try {
    for (let i = 0; i < runs; i += 1) {
      samples.push(await pingColdStartOnce(env.home));
    }
  } finally {
    await env.dispose();
  }
  const s = stats(samples);
  return {
    nfr: "NFR-1",
    name: "CLI 冷启动（novacode ping）",
    target: "≤ 2s（20 次中位数）",
    targetMs: 2000,
    actualMs: s.median,
    detail: `spawn tsx CLI 计时至 stdout 首个版本输出（01-PRD §6.1）；中位数 ${fmt(s.median)} · P95 ${fmt(s.p95)} · min ${fmt(s.min)} · max ${fmt(s.max)} (n=${String(s.n)})`,
    pass: s.median <= 2000,
  };
}

// --- 共享 harness：in-memory 服务节点 + mock LLM（复用 p0-lib） ---

interface Harness {
  client: ReturnType<typeof createRpcClient>;
  mock: Awaited<ReturnType<typeof startMockLlmServer>>;
  env: Awaited<ReturnType<typeof isolatedEnv>>;
  dispose: () => Promise<void>;
}

async function startHarness(prefix: string): Promise<Harness> {
  const env = await isolatedEnv(prefix);
  const mock = await startMockLlmServer();
  const transports = createInMemoryTransportPair();
  const node = await createAgentServiceNode(transports[1], {
    env: { NOVACODE_HOME: env.home },
    provider: {
      name: `bench-${prefix}`,
      baseURL: mock.url,
      model: "mock-model",
      apiKey: "bench-dummy-key-NOT-A-SECRET",
      maxContextTokens: 8192,
    },
  });
  const client = createRpcClient({ transport: transports[0] });
  await client.call("system.ping", {});
  return {
    client,
    mock,
    env,
    dispose: async () => {
      client.close();
      await node.close();
      await transports[0].close();
      await transports[1].close();
      await mock.close();
      await env.dispose();
    },
  };
}

// --- NFR-2 send：session.send 受理 → ModelRequest 发出 ---

export async function benchSend(iterations = 100): Promise<CheckResult> {
  const harness = await startHarness("send");
  const samples: number[] = [];
  try {
    for (let i = 0; i < iterations; i += 1) {
      // 每次迭代新建会话：上下文恒定，测「用户确认发送→请求发出」的纯本地开销
      const created = await harness.client.call<{ sessionId: string }>("session.create", {
        workspaceRoot: harness.env.workspace,
        title: "bench send",
      });
      harness.mock.setScript([textScript("ok")]);
      const bodiesStart = harness.mock.bodies.length;
      const t0 = performance.now(); // 用户确认发送（订阅先于 send，beginTurn 内发起调用）
      const run = beginTurn(harness.client, created.sessionId, `bench input ${String(i)}：请直接回复 ok`);
      await run.sendPromise;
      while (harness.mock.bodies.length <= bodiesStart) await delay(1); // 轮询粒度 ≤1ms
      samples.push((harness.mock.bodyTimes[bodiesStart] ?? performance.now()) - t0); // mock 捕获的请求到达时刻
      await withTimeout(run.done, 15000, `bench send turn ${String(i)}`);
      run.stop();
    }
  } finally {
    await harness.dispose();
  }
  const s = stats(samples);
  return {
    nfr: "NFR-2",
    name: "输入→模型请求本地开销（session.send 受理→ModelRequest 发出）",
    target: "≤ 300ms（P95）",
    targetMs: 300,
    actualMs: s.p95,
    detail: `mock LLM 请求捕获时间戳差值；含上下文组装/zod 校验/消息落盘/HTTP 请求发出；P95 ${fmt(s.p95)} · 中位数 ${fmt(s.median)} · max ${fmt(s.max)} (n=${String(s.n)})`,
    pass: s.p95 <= 300,
  };
}

// --- NFR-3 render：tool_call.completed → CLI stdout 渲染完成 ---

/** 复刻 apps/cli/src/stream.ts 的 tool_call.completed 渲染分支（写丢弃 sink 等价 stdout.write 调用）。 */
const renderSink = new Writable({
  write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    callback();
  },
});

function renderToolCompleted(event: ToolCallCompletedEventPayload): void {
  const seconds = `${(event.durationMs / 1000).toFixed(1)}s`;
  const preview = event.contentPreview ?? "";
  const line = event.isError
    ? `  ✗ ${event.error !== undefined ? `${event.error.code} ${event.error.message}` : "failed"} · ${seconds}\n`
    : `  ✓ ${preview.length > 0 ? `${collapse(preview)} · ` : ""}${seconds}\n`;
  renderSink.write(line);
}

function collapse(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > SUMMARY_MAX_CHARS ? `${collapsed.slice(0, SUMMARY_MAX_CHARS)}…` : collapsed;
}

export async function benchRender(iterations = 100): Promise<CheckResult> {
  const harness = await startHarness("render");
  await appendFile(join(harness.env.workspace, "notes.txt"), "render bench sample content\n", "utf8");
  const renderSamples: number[] = []; // 事件到达（CLI 侧回调入口）→ 渲染完成
  const fromPublishSamples: number[] = []; // 服务端发布（event.ts）→ 渲染完成（全链路）
  const offCompleted = harness.client.onEvent("tool_call.completed", (payload: unknown) => {
    const event = payload as ToolCallCompletedEventPayload;
    const arrival = performance.now();
    renderToolCompleted(event); // 同步渲染（与 stream.ts 相同的同步 write 语义）
    renderSamples.push(performance.now() - arrival);
    fromPublishSamples.push(Date.now() - event.ts); // 服务端发布时刻（epoch ms）→ 渲染完成（全链路）
  });
  try {
    for (let i = 0; i < iterations; i += 1) {
      const created = await harness.client.call<{ sessionId: string }>("session.create", {
        workspaceRoot: harness.env.workspace,
        title: "bench render",
      });
      harness.mock.setScript([
        toolCallScript(`call_render_${String(i)}`, "read", { path: "notes.txt" }), // 只读工具走 metadata 快速通道
        textScript("done"),
      ]);
      const run = beginTurn(harness.client, created.sessionId, `bench render ${String(i)}`);
      await run.sendPromise;
      await withTimeout(run.done, 15000, `bench render turn ${String(i)}`);
      run.stop();
    }
  } finally {
    offCompleted();
    await harness.dispose();
  }
  const s = stats(renderSamples);
  const sp = stats(fromPublishSamples);
  return {
    nfr: "NFR-3",
    name: "工具结果本地渲染延迟（tool_call.completed → 渲染完成）",
    target: "≤ 100ms（P95）",
    targetMs: 100,
    actualMs: s.p95,
    detail: `进程内 harness；事件到达→渲染完成 P95 ${fmt(s.p95)}；服务端发布→渲染完成 P95 ${fmt(sp.p95)}（全链路，n=${String(s.n)}）`,
    pass: s.p95 <= 100,
  };
}

// --- NFR-5 resume：1 万条消息会话恢复 ---

const RESUME_MESSAGES = 10000;

export async function benchResume(runs = 10): Promise<CheckResult> {
  const env = await isolatedEnv("resume");
  try {
    const storage = await Storage.open({ env: { NOVACODE_HOME: env.home } });
    const wsInfo = await storage.ensureWorkspace(env.workspace);
    const meta = await storage.createSession({ workspaceHash: wsInfo.hash, title: "bench resume 10k" });
    const sessionId = meta.id;
    const eventsFile = await storage.sessionEventsFile(sessionId);
    // 批量写入 1 万条消息行（头行 seq=1 由 createSession 写入；无 checkpoint = full-replay 最坏路径）
    const lines: string[] = [];
    for (let i = 0; i < RESUME_MESSAGES; i += 1) {
      const record: MessageRecord = {
        id: `msg_bench_${String(i).padStart(6, "0")}`,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `bench message #${String(i)} — 会话恢复基准样本行，正文保持约 80 字符以贴近真实消息体积。`,
      };
      lines.push(JSON.stringify({ v: 1, type: "message", seq: i + 2, ts: Date.now(), message: record }));
    }
    await appendFile(eventsFile, `${lines.join("\n")}\n`, "utf8");
    await storage.close();

    const samples: number[] = [];
    let replaySource = "";
    let replayCount = 0;
    for (let r = 0; r < runs; r += 1) {
      const s = await Storage.open({ env: { NOVACODE_HOME: env.home } }); // 重开 storage（崩溃重启等价路径）
      try {
        const t0 = performance.now();
        const replay = await s.resumeSession(sessionId);
        samples.push(performance.now() - t0);
        replaySource = replay.source;
        replayCount = replay.messageCount;
      } finally {
        await s.close();
      }
    }
    const fileSize = (await readFile(eventsFile)).byteLength;
    if (replayCount !== RESUME_MESSAGES) {
      throw new Error(`resume 对账失败: messageCount=${String(replayCount)} 期望 ${String(RESUME_MESSAGES)}`);
    }
    const s = stats(samples);
    return {
      nfr: "NFR-5",
      name: "会话恢复（1 万条消息）",
      target: "≤ 1s（10 次中位数）",
      targetMs: 1000,
      actualMs: s.median,
      detail: `Storage.open + resumeSession 全流程；重放路径=${replaySource}，events.jsonl=${(fileSize / 1024 / 1024).toFixed(2)}MB · 中位数 ${fmt(s.median)} · max ${fmt(s.max)} (n=${String(s.n)})`,
      pass: s.median <= 1000,
    };
  } finally {
    await env.dispose();
  }
}

// --- NFR-7 crash：turn 进行中强杀 → 恢复 → 完整性断言 ---

function slowCommand(): string {
  return process.platform === "win32" ? "ping -n 8 127.0.0.1" : "sleep 7"; // 跨 shell（bash/PowerShell）慢命令
}

async function crashOnce(index: number): Promise<void> {
  const harness = await startHarness("crash");
  const command = slowCommand();
  harness.mock.setScript([
    toolCallScript(`call_crash_${String(index)}`, "bash", { command }),
    textScript("recovered after crash"),
  ]);
  const child = spawn(
    process.execPath,
    ["--import", "tsx", CLI_ENTRY, "run", `请执行 bash 命令：${command}`, "--yes", "--workspace", harness.env.workspace],
    {
      cwd: REPO_ROOT, // tsx 从仓库根解析（与 smoke 回归子进程同口径）；工作区经 --workspace 注入
      env: {
        ...process.env,
        NOVACODE_HOME: harness.env.home,
        NOVACODE_PROVIDER_BASE_URL: harness.mock.url,
        NOVACODE_PROVIDER_MODEL: "mock-model",
        NOVACODE_PROVIDER_API_KEY: "bench-crash-dummy-NOT-A-SECRET",
        NOVACODE_PROVIDER_NAME: "bench-crash",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const exited = new Promise<number | null>((resolvePromise) => child.on("exit", (code) => resolvePromise(code)));
  try {
    // 等待工具开始执行（CLI 渲染 ▸ bash 行），随后在执行窗口内强杀
    const deadline = Date.now() + 60000;
    while (!stdout.includes("▸ bash")) {
      if (Date.now() > deadline) throw new Error(`timeout waiting ▸ bash; stderr=${stderr.slice(0, 300)}`);
      await delay(20);
    }
    await delay(800); // bash 慢命令执行中（ping 约 7s，远未结束）→ JSONL 处于静默窗口
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid ?? 0)]);
    } else {
      child.kill("SIGKILL");
    }
    await exited;
    await assertCrashRecovery(harness, stderr, command, index);
  } finally {
    await harness.dispose();
  }
}

/** 强杀后的恢复断言（05 §4.4 / NFR-7）：完整性 → 零丢失 → 悬挂补齐 → 对账。 */
async function assertCrashRecovery(
  harness: Harness,
  childStderr: string,
  command: string,
  index: number,
): Promise<void> {
  const storage = await Storage.open({ env: { NOVACODE_HOME: harness.env.home } });
  try {
    const match = /session (\S+) · model/.exec(childStderr);
    const active = await storage.sessions.list({ status: "active" });
    const sessionId = match?.[1] ?? active[0]?.id ?? "";
    if (sessionId.length === 0) throw new Error("crash 后未找到会话");
    const replay = await storage.resumeSession(sessionId);
    const meta = await storage.sessions.get(sessionId);

    // 1) JSONL 完整性：全部行可解析（kill 落在写入静默窗口，应无残行）
    const raw = await readFile(await storage.sessionEventsFile(sessionId), "utf8");
    const parsedLines = raw
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => parseLine(line));
    const broken = parsedLines.filter((parsed) => !parsed.ok).length;
    if (broken !== 0) throw new Error(`JSONL 存在 ${String(broken)} 条损坏行`);
    const messages = parsedLines.flatMap((parsed) =>
      parsed.ok && parsed.line.type === "message" ? [parsed.line.message] : [],
    );

    // 2) 已完成消息零丢失：用户输入与 assistant tool_call 消息均在
    const userMsg = messages.find(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.includes(command),
    );
    if (userMsg === undefined) throw new Error("用户消息丢失（已完成消息零丢失断言失败）");
    const assistantCall = messages.find(
      (m) =>
        m.role === "assistant" &&
        Array.isArray(m.content) &&
        m.content.some((block) => block.type === "tool_call" && block.name === "bash"),
    );
    if (assistantCall === undefined || !Array.isArray(assistantCall.content)) {
      throw new Error("assistant tool_call 消息缺失");
    }
    const toolCallIds = assistantCall.content.flatMap((block) =>
      block.type === "tool_call" ? [block.toolCallId] : [],
    );
    const danglingId = toolCallIds.find((id) => !messages.some((m) => m.role === "tool" && m.toolCallId === id));
    if (danglingId === undefined) throw new Error("预期悬挂 tool_call 未出现（强杀时机未命中工具执行窗口）");

    // 3) 悬挂 tool_call 补齐：isError=true 合成结果
    const synthesized = replay.synthesizedToolResults.find((r) => r.toolCallId === danglingId);
    if (synthesized === undefined || synthesized.isError !== true) {
      throw new Error(`悬挂 tool_call 未补齐: ${JSON.stringify(replay.synthesizedToolResults)}`);
    }

    // 4) message_count 对账一致（文件实数 = 重放对账口径 = sessions 投影列）
    const fileCount = messages.length;
    if (replay.messageCount !== fileCount || meta?.messageCount !== fileCount) {
      throw new Error(
        `message_count 对账失败: file=${String(fileCount)} replay=${String(replay.messageCount)} sessions=${String(meta?.messageCount)}`,
      );
    }
    console.log(
      `  crash#${String(index)}: 会话 ${sessionId} · JSONL ${String(parsedLines.length)} 行完整 · 消息 ${String(fileCount)} 条零丢失 · ` +
        `悬挂 tool_call(${danglingId}) 已补齐 isError=true · message_count 对账一致`,
    );
  } finally {
    await storage.close();
  }
}

export async function benchCrash(times = 1): Promise<CheckResult> {
  for (let i = 0; i < times; i += 1) {
    await crashOnce(i);
  }
  return {
    nfr: "NFR-7",
    name: `崩溃可恢复（turn 进行中强杀 ×${String(times)}）`,
    target: "100% 可恢复（约束型）",
    targetMs: null,
    actualMs: 0,
    detail: `强杀后重开 storage → resume：消息零丢失 / 悬挂 tool_call 补齐 / message_count 对账一致（${String(times)} 轮全部断言通过）`,
    pass: true,
  };
}
