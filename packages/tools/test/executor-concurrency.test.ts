/**
 * ToolExecutor 并发上限单测（T2.7 任务 2）。
 * 02-module-design §2.2：readOnly 工具并行执行（上限可配，缺省 4），写工具按序串行。
 * 探针工具以「峰值并发计数 + 写时间窗」断言：① 上限可配且峰值不越界 ② 写严格串行 ③ 缺省仍 4。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { ToolExecutor, ToolRegistry } from "../src/index.js";
import type { BackgroundTaskRegistry, Tool, ToolRunContext } from "../src/index.js";

interface ProbeState {
  /** 当前在执行的调用数。 */
  active: number;
  /** 峰值并发（readOnly 计数口径）。 */
  peak: number;
  /** 每次调用的执行时间窗（toolCallId → start/end，performance.now 毫秒时标）。 */
  windows: Map<string, { start: number; end: number }>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/** 探针工具：进入时计数并记录峰值，保持 holdMs 后退出并记录时间窗。 */
function makeProbeTool(name: string, readOnly: boolean, state: ProbeState, holdMs = 20): Tool<{ index: number }> {
  return {
    name,
    description: "probe tool for concurrency tests",
    parametersSchema: z.object({ index: z.number() }),
    metadata: {
      readOnly,
      destructive: false,
      sideEffectScope: readOnly ? "none" : "workspace",
      riskLevel: readOnly ? "low" : "medium",
      needsApproval: false,
    },
    async execute(input: { index: number }) {
      const start = performance.now();
      state.active += 1;
      state.peak = Math.max(state.peak, state.active);
      await sleep(holdMs);
      state.active -= 1;
      state.windows.set(`${name}#${String(input.index)}`, { start, end: performance.now() });
      return { data: { ok: true } };
    },
  };
}

function setup(state: ProbeState, maxConcurrency?: number): ToolExecutor {
  const registry = new ToolRegistry();
  registry.register(makeProbeTool("probe_read", true, state));
  registry.register(makeProbeTool("probe_write", false, state));
  return new ToolExecutor({
    registry,
    ...(maxConcurrency !== undefined && { maxConcurrency }),
  });
}

function runCtx(): ToolRunContext {
  return {
    signal: new AbortController().signal,
    workspaceRoot: process.cwd(),
    cwd: process.cwd(),
    sessionKey: "test",
    background: {} as BackgroundTaskRegistry,
  };
}

function readOnlyCalls(count: number, toolName = "probe_read") {
  return Array.from({ length: count }, (_, index) => ({
    toolCallId: `c${String(index)}`,
    toolName,
    args: { index },
  }));
}

describe("ToolExecutor 并发上限（02 §2.2）", () => {
  it("6 个只读调用、上限 2：峰值并发恰为 2 且全部收敛", async () => {
    const state: ProbeState = { active: 0, peak: 0, windows: new Map() };
    const executor = setup(state, 2);

    const results = await executor.runBatch(readOnlyCalls(6), runCtx());
    assert.equal(results.length, 6);
    for (const result of results) {
      assert.equal(result.isError, false);
    }
    // runBatch 同步派发全部调用：前 2 个进入、其余排队 → 峰值确定性等于上限
    assert.equal(state.peak, 2, "峰值并发不得超过上限 2");
  });

  it("写工具与只读混合：写工具严格串行（时间窗不交叠）", async () => {
    const state: ProbeState = { active: 0, peak: 0, windows: new Map() };
    const executor = setup(state, 4);

    const calls = [
      { toolCallId: "w0", toolName: "probe_write", args: { index: 0 } },
      { toolCallId: "r0", toolName: "probe_read", args: { index: 0 } },
      { toolCallId: "w1", toolName: "probe_write", args: { index: 1 } },
      { toolCallId: "r1", toolName: "probe_read", args: { index: 1 } },
      { toolCallId: "w2", toolName: "probe_write", args: { index: 2 } },
    ];
    const results = await executor.runBatch(calls, runCtx());
    assert.equal(results.length, 5);
    assert.ok(results.every((result) => !result.isError), "全部调用应收敛成功");

    const windows = [...state.windows.entries()]
      .filter(([key]) => key.startsWith("probe_write#"))
      .map(([, value]) => value)
      .sort((a, b) => a.start - b.start);
    assert.equal(windows.length, 3);
    for (let i = 1; i < windows.length; i += 1) {
      assert.ok(
        windows[i]!.start >= windows[i - 1]!.end,
        `写调用必须串行：第 ${String(i)} 窗开始早于上一窗结束`,
      );
    }
    // 只读与写互不阻塞的并行通道仍在（02 §2.2：读并行、写串行）
    const readWindows = [...state.windows.entries()].filter(([key]) => key.startsWith("probe_read#"));
    assert.equal(readWindows.length, 2);
  });

  it("缺省上限仍为 4：6 个只读调用峰值恰为 4", async () => {
    const state: ProbeState = { active: 0, peak: 0, windows: new Map() };
    const executor = setup(state); // 不传 maxConcurrency

    const results = await executor.runBatch(readOnlyCalls(6), runCtx());
    assert.equal(results.length, 6);
    assert.ok(results.every((result) => !result.isError));
    assert.equal(state.peak, 4, "缺省并发上限应保持 4（02 §2.2）");
  });

  it("非法上限（0/负数）：按最小 1 防御退化为串行", async () => {
    const state: ProbeState = { active: 0, peak: 0, windows: new Map() };
    const executor = setup(state, 0);

    const results = await executor.runBatch(readOnlyCalls(3), runCtx());
    assert.equal(results.length, 3);
    assert.ok(results.every((result) => !result.isError));
    assert.equal(state.peak, 1, "Math.max(1, n) 防御：峰值并发为 1");
  });
});
