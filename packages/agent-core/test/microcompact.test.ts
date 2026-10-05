/**
 * microcompact 预剪枝单测（T5.4，07 §11.2「收敛性单测」）——
 * - 单过收敛不变量：head+marker+tail 恒 ≤ 单条阈值且严格小于原文（配置校验静态保证 + 动态断言）；
 * - code point 切分不劈代理对（emoji 骑在 head 边界上仍完整保留）；
 * - 候选判定：白名单外不动 / isError 跳过 / 未超阈值跳过 / 已剪枝重入跳过 / 工具名自 assistant
 *   tool_call 块回查；
 * - 保留最近 N 条候选；整 pass 最小节省 tokens 门槛 all-or-nothing；
 * - 服务层：触发判定（0.9 × full 线）/ compaction.pruned 事件回指 payload / 幂等 / enabled:false。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MessageRecord } from "@raincode/shared";
import type { StoragePort } from "../src/ports.js";
import {
  MICROCOMPACT_HEAD_CHARS,
  MICROCOMPACT_PRUNE_MARKER,
  MICROCOMPACT_TAIL_CHARS,
  MICROCOMPACT_THRESHOLD_CHARS,
  MicrocompactService,
  codePointLength,
  planMicrocompact,
  pruneToolResultText,
  resolveMicrocompactConfig,
} from "../src/index.js";

const config = resolveMicrocompactConfig(undefined);

function assistantWithCalls(calls: Array<{ id: string; name: string }>): MessageRecord {
  return {
    id: `msg_a_${calls.map((call) => call.id).join("_")}`,
    role: "assistant",
    content: [
      { type: "text", text: "先调用工具" },
      ...calls.map((call) => ({ type: "tool_call" as const, toolCallId: call.id, name: call.name, arguments: {} })),
    ],
  };
}

function toolResult(callId: string, content: string, isError = false): MessageRecord {
  return { id: `msg_t_${callId}`, role: "tool", toolCallId: callId, content, ...(isError && { isError: true }) };
}

/** n 条（assistant+tool）候选对，工具结果各 9000 code points，白名单内工具 read。 */
function candidatePairs(count: number): MessageRecord[] {
  const history: MessageRecord[] = [];
  for (let i = 1; i <= count; i += 1) {
    history.push(assistantWithCalls([{ id: `tc${String(i)}`, name: "read" }]));
    history.push(toolResult(`tc${String(i)}`, "x".repeat(9000)));
  }
  return history;
}

describe("resolveMicrocompactConfig 配置校验（收敛不变量的静态保证）", () => {
  it("head+marker+tail 超过单条阈值 → 抛错", () => {
    assert.throws(() => resolveMicrocompactConfig({ headChars: 5000, tailChars: 4000 }), /must be at most thresholdChars/);
  });

  it("非法数值域 → 抛错", () => {
    assert.throws(() => resolveMicrocompactConfig({ thresholdRatio: 1.5 }), /thresholdRatio/);
    assert.throws(() => resolveMicrocompactConfig({ keepRecentCount: -1 }), /keepRecentCount/);
    assert.throws(() => resolveMicrocompactConfig({ thresholdChars: 0 }), /thresholdChars/);
    assert.throws(() => resolveMicrocompactConfig({ tailChars: -1 }), /tailChars/);
  });

  it("缺省 = ZCode/dsh 参照常量", () => {
    assert.equal(config.thresholdRatio, 0.9);
    assert.equal(config.keepRecentCount, 5);
    assert.equal(config.minSavingsTokens, 256);
    assert.equal(config.thresholdChars, 8192);
    assert.equal(config.headChars, 4096);
    assert.equal(config.tailChars, 1024);
    assert.ok(config.compactableTools.has("read"));
    assert.ok(!config.compactableTools.has("write"));
  });
});

describe("pruneToolResultText 单过收敛不变量", () => {
  it("剪后恒 ≤ 阈值且严格小于原文，head/tail 锚点与标记在位", () => {
    for (const total of [MICROCOMPACT_THRESHOLD_CHARS + 1, 20_000, 100_000]) {
      const text = "x".repeat(total);
      const pruned = pruneToolResultText(text, config);
      assert.ok(pruned !== null);
      assert.ok(codePointLength(pruned) <= config.thresholdChars, `剪后 ${String(codePointLength(pruned))} ≤ ${String(config.thresholdChars)}`);
      assert.ok(codePointLength(pruned) < total);
      assert.ok(pruned.startsWith("x".repeat(config.headChars)));
      assert.ok(pruned.endsWith("x".repeat(config.tailChars)));
      assert.ok(pruned.includes(MICROCOMPACT_PRUNE_MARKER));
    }
  });

  it("≤ 阈值不动", () => {
    assert.equal(pruneToolResultText("x".repeat(MICROCOMPACT_THRESHOLD_CHARS), config), null);
    assert.equal(pruneToolResultText("短结果", config), null);
  });

  it("code point 切分不劈代理对：emoji 骑在 head 边界上仍完整", () => {
    const text = `${"x".repeat(MICROCOMPACT_HEAD_CHARS - 1)}😀${"y".repeat(9000)}`;
    const pruned = pruneToolResultText(text, config);
    assert.ok(pruned !== null);
    assert.ok(pruned.startsWith(`${"x".repeat(MICROCOMPACT_HEAD_CHARS - 1)}😀`), "head 以完整 emoji 收尾");
    assert.ok(pruned.endsWith("y".repeat(MICROCOMPACT_TAIL_CHARS)));
    for (const ch of pruned) {
      const code = ch.codePointAt(0)!;
      assert.ok(!(code >= 0xd800 && code <= 0xdfff), "不应出现代理区裸项（劈开的代理对）");
    }
  });
});

describe("planMicrocompact 候选判定（白名单/保留区/幂等）", () => {
  it("白名单外工具不动", () => {
    const history = [assistantWithCalls([{ id: "tc1", name: "write" }]), toolResult("tc1", "x".repeat(9000))];
    assert.equal(planMicrocompact({ history, config }), "no_candidates");
  });

  it("isError 结果跳过（缺省不清错误结果）", () => {
    const history = [assistantWithCalls([{ id: "tc1", name: "read" }]), toolResult("tc1", "x".repeat(9000), true)];
    assert.equal(planMicrocompact({ history, config }), "no_candidates");
  });

  it("未超单条阈值跳过", () => {
    const history = [assistantWithCalls([{ id: "tc1", name: "read" }]), toolResult("tc1", "x".repeat(8000))];
    assert.equal(planMicrocompact({ history, config }), "no_candidates");
  });

  it("已剪枝内容重入跳过（幂等）", () => {
    const history = [
      assistantWithCalls([{ id: "tc1", name: "read" }]),
      toolResult("tc1", `${"x".repeat(4096)}${MICROCOMPACT_PRUNE_MARKER}${"y".repeat(1024)}${"z".repeat(4000)}`),
    ];
    assert.equal(planMicrocompact({ history, config }), "no_candidates");
  });

  it("候选全落在保留区（最近 N 条）→ 不剪", () => {
    const history = candidatePairs(3);
    assert.equal(planMicrocompact({ history, config }), "no_candidates");
  });

  it("保留最近 5 条，更老者入剪枝集（工具名自 tool_call 块回查）", () => {
    const history = candidatePairs(7);
    const plan = planMicrocompact({ history, config });
    assert.ok(typeof plan === "object");
    assert.equal(plan.replacements.length, 2, "7 条候选保留最近 5 条，剪最老 2 条");
    assert.equal(plan.replacements[0]!.sourceMessageId, "msg_t_tc1");
    assert.equal(plan.replacements[1]!.sourceMessageId, "msg_t_tc2");
    assert.equal(plan.replacements[0]!.toolName, "read");
    assert.equal(plan.replacements[0]!.toolCallId, "tc1");
    // tokensSaved = floor(总剪除 code points / 3)
    const markerLen = codePointLength(MICROCOMPACT_PRUNE_MARKER);
    const perItemRemoved = 9000 - (config.headChars + markerLen + config.tailChars);
    assert.equal(plan.charsRemoved, perItemRemoved * 2);
    assert.equal(plan.tokensSaved, Math.floor((perItemRemoved * 2) / 3));
  });

  it("整 pass 节省不足 minSavingsTokens → below_min_savings（all-or-nothing）", () => {
    const smallConfig = resolveMicrocompactConfig({ thresholdChars: 600, headChars: 550, tailChars: 0, keepRecentCount: 0 });
    const history = [assistantWithCalls([{ id: "tc1", name: "read" }]), toolResult("tc1", "x".repeat(700))];
    const plan = planMicrocompact({ history, config: smallConfig });
    assert.equal(plan, "below_min_savings");
    // 验证可剪但节省太小：700 → 550+marker(42)，剪除 108 code points ≈ 36 tokens < 256
    assert.ok(codePointLength("x".repeat(700)) > smallConfig.thresholdChars);
  });
});

interface Harness {
  history: MessageRecord[];
  events: Array<{ name: string; payload: unknown }>;
  diags: string[];
  service: MicrocompactService;
}

function makeService(options?: Parameters<typeof resolveMicrocompactConfig>[0], fullThreshold = 1000): Harness {
  const history: MessageRecord[] = [];
  const events: Array<{ name: string; payload: unknown }> = [];
  const diags: string[] = [];
  const storage = {
    appendEvent: async (_sessionId: string, name: string, payload: unknown) => {
      events.push({ name, payload });
      return { accepted: true as const, seq: 1, offset: 0 };
    },
  } as unknown as StoragePort;
  const service = new MicrocompactService(
    {
      getHistory: () => [...history],
      replaceAt: (index, record) => {
        history[index] = record;
      },
      currentEpoch: () => 3,
    },
    {
      sessionId: "s1",
      storage,
      serialWrite: async <T>(task: () => Promise<T>) => task(),
      diag: (message) => {
        diags.push(message);
      },
    },
    options,
    () => fullThreshold,
  );
  return { history, events, diags, service };
}

async function settleEvents(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("MicrocompactService.maybePrune 触发判定与回指事件", () => {
  it("估算低于 0.9 × full 线 → not_triggered；full 线为 0（未配 Provider）→ not_triggered", async () => {
    const harness = makeService();
    harness.history.push(...candidatePairs(1));
    assert.deepEqual(harness.service.maybePrune(100), { applied: false, reason: "not_triggered" });
    assert.equal(harness.events.length, 0);

    const zero = makeService(undefined, 0);
    zero.history.push(...candidatePairs(1));
    assert.deepEqual(zero.service.maybePrune(50_000), { applied: false, reason: "not_triggered" });
    await settleEvents();
    assert.equal(zero.events.length, 0);
  });

  it("压力确认后应用：内存替换 + compaction.pruned 事件回指原文", async () => {
    const harness = makeService({ keepRecentCount: 0 });
    const original = "x".repeat(9000);
    harness.history.push(assistantWithCalls([{ id: "tc1", name: "read" }]), toolResult("tc1", original));
    const outcome = harness.service.maybePrune(1000); // 1000 ≥ 0.9×1000 → 触发
    assert.ok(outcome.applied);
    assert.ok(outcome.prunerId.startsWith("mc_"));
    assert.equal(outcome.prunedCount, 1);

    // 内存替换：同 id 新对象、content 为剪后文本、index 稳定
    assert.equal(harness.history.length, 2);
    assert.equal(harness.history[1]!.id, "msg_t_tc1");
    const pruned = pruneToolResultText(original, config)!;
    assert.equal(harness.history[1]!.content, pruned);
    assert.notEqual(harness.history[1]!.content, original);

    await settleEvents();
    assert.equal(harness.events.length, 1);
    const event = harness.events[0]!;
    assert.equal(event.name, "compaction.pruned");
    const payload = event.payload as { prunerId: string; epoch: number; replacements: Array<{ sourceMessageId: string; toolCallId: string; toolName: string; charsBefore: number; charsAfter: number; prunedContent: string }>; charsRemoved: number; tokensSaved: number; tokensBefore: number };
    assert.equal(payload.prunerId, outcome.prunerId);
    assert.equal(payload.epoch, 3);
    assert.equal(payload.replacements.length, 1);
    const replacement = payload.replacements[0]!;
    assert.equal(replacement.sourceMessageId, "msg_t_tc1");
    assert.equal(replacement.toolCallId, "tc1");
    assert.equal(replacement.toolName, "read");
    assert.equal(replacement.charsBefore, 9000);
    assert.equal(replacement.charsAfter, codePointLength(pruned));
    assert.equal(replacement.prunedContent, pruned);
    assert.equal(payload.tokensBefore, 1000);
    assert.equal(payload.tokensSaved, Math.floor((9000 - codePointLength(pruned)) / 3));
  });

  it("节省不足门槛 → 不应用不落事件（原历史保留）", async () => {
    const harness = makeService({ thresholdChars: 600, headChars: 550, tailChars: 0, keepRecentCount: 0 });
    const original = "x".repeat(700);
    harness.history.push(assistantWithCalls([{ id: "tc1", name: "read" }]), toolResult("tc1", original));
    assert.deepEqual(harness.service.maybePrune(1000), { applied: false, reason: "below_min_savings" });
    await settleEvents();
    assert.equal(harness.events.length, 0);
    assert.equal(harness.history[1]!.content, original);
  });

  it("enabled:false 整体关闭；应用后重入幂等（no_candidates）", async () => {
    const off = makeService({ enabled: false });
    off.history.push(...candidatePairs(1));
    assert.deepEqual(off.service.maybePrune(50_000), { applied: false, reason: "not_triggered" });

    const harness = makeService({ keepRecentCount: 0 });
    harness.history.push(...candidatePairs(1));
    assert.ok(harness.service.maybePrune(1000).applied);
    assert.deepEqual(harness.service.maybePrune(1000), { applied: false, reason: "no_candidates" });
    await settleEvents();
    assert.equal(harness.events.length, 1, "幂等重入不产生第二个剪枝事件");
  });
});
