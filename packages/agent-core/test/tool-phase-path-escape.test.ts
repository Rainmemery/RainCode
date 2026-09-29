/**
 * ToolPhaseRunner 越界升级 ask 全链单测（T2.7 任务 4 · 02-module-design §5.4）。
 * 覆盖层级：tool-phase 预检（detectPathEscape → PermissionRequest.pathEscape）
 *   → permission 强制 ask（ScriptedPermissionPort 模拟）→ 获批后精确注入 pathPolicy 钩子
 *   → 处理器 guardPath 经钩子放行（本测试以探针工具直接断言注入的 ctx.pathPolicy 语义）。
 * 无越界 / deny / 非 pathEscape 场景零回归断言一并覆盖。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { join, resolve } from "node:path";
import { z } from "zod";
import { ToolExecutor, ToolRegistry } from "@raincode/tools";
import type { BackgroundTaskRegistry, Tool, ToolExecutionContext } from "@raincode/tools";
import { TOOL_ERROR_CODES } from "@raincode/shared";
import { ToolPhaseRunner } from "../src/index.js";
import type { PermissionPort, PermissionVerdict, ToolPermissionRequest, ToolPhaseDeps } from "../src/index.js";

// ---------------------------------------------------------------------------
// ScriptedPermissionPort：无 pathEscape → allow；有 pathEscape → ask 挂起，测试用例 respond
// ---------------------------------------------------------------------------

class ScriptedPermissionPort implements PermissionPort {
  readonly requests: ToolPermissionRequest[] = [];
  private readonly waiters = new Map<string, (value: "allow" | "deny") => void>();
  private seq = 0;

  async evaluate(request: ToolPermissionRequest): Promise<PermissionVerdict> {
    this.requests.push(request);
    if (request.pathEscape === undefined) {
      return { decision: "allow", matchedBy: "metadata", reason: "无越界，快速通道" };
    }
    this.seq += 1;
    const grantId = `grant_${String(this.seq)}`;
    return {
      decision: "ask",
      matchedBy: "default",
      grantId,
      reason: `访问 workspace 外路径 ${request.pathEscape.absolutePath}，需逐次审批（02 §5.4）`,
    };
  }

  awaitApproval(grantId: string): Promise<"allow" | "deny"> {
    return new Promise((resolvePromise) => {
      this.waiters.set(grantId, resolvePromise);
    });
  }

  /** 模拟审批端 respond；返回是否有挂起中的审批单被收敛。 */
  respond(grantId: string, decision: "allow" | "deny"): boolean {
    const waiter = this.waiters.get(grantId);
    if (waiter === undefined) {
      return false;
    }
    this.waiters.delete(grantId);
    waiter(decision);
    return true;
  }
}

// ---------------------------------------------------------------------------
// 探针工具（名为 read，命中显式路径工具预检集合）：捕获执行期 ctx.pathPolicy
// ---------------------------------------------------------------------------

interface ProbeCapture {
  inputPath: string;
  pathPolicy: ToolExecutionContext["pathPolicy"];
}

function makeReadProbe(captured: ProbeCapture[]): Tool<{ path: string }> {
  return {
    name: "read",
    description: "probe read tool for path-escape chain tests",
    parametersSchema: z.object({ path: z.string() }),
    metadata: {
      readOnly: true,
      destructive: false,
      sideEffectScope: "none",
      riskLevel: "low",
      needsApproval: false,
    },
    async execute(input: { path: string }, ctx: ToolExecutionContext) {
      captured.push({ inputPath: input.path, pathPolicy: ctx.pathPolicy });
      return { data: { path: input.path }, content: `read:${input.path}` };
    },
  };
}

const root = process.cwd();

interface Harness {
  port: ScriptedPermissionPort;
  captured: ProbeCapture[];
  run: (calls: Array<{ toolCallId: string; toolName: string; args: unknown }>) => Promise<
    Awaited<ReturnType<ToolPhaseRunner["run"]>>
  >;
}

function makeHarness(): Harness {
  const port = new ScriptedPermissionPort();
  const captured: ProbeCapture[] = [];
  const registry = new ToolRegistry();
  registry.register(makeReadProbe(captured));
  const deps: ToolPhaseDeps = {
    registry,
    executor: new ToolExecutor({ registry }),
    permission: port,
  };
  const runner = new ToolPhaseRunner({
    sessionId: "s1",
    turnId: "t1",
    deps,
    emitPersisted: () => {},
    publishProgress: () => {},
    onTransition: () => {},
  });
  return {
    port,
    captured,
    run: (calls) =>
      runner.run(
        calls.map((call) => ({ ...call, argsJSON: JSON.stringify(call.args) })),
        {
          signal: new AbortController().signal,
          workspaceRoot: root,
          cwd: root,
          sessionKey: "test",
          mode: "normal",
          workspaceId: "w1",
          background: {} as BackgroundTaskRegistry,
        },
      ),
  };
}

/** 轮询等待 tool-phase 推进到 ask 挂起点（evaluate 已记录且审批单待应答）。 */
async function until(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      assert.fail("等待挂起点超时");
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2));
  }
}

describe("ToolPhaseRunner 越界升级 ask 全链（02 §5.4）", () => {
  it("越界 read：evaluate 收到 pathEscape，获批后注入精确放行钩子并执行成功", async () => {
    const h = makeHarness();
    const running = h.run([{ toolCallId: "c1", toolName: "read", args: { path: "../outside.txt" } }]);

    await until(() => h.port.requests.length === 1);
    const request = h.port.requests[0]!;
    assert.ok(request.pathEscape !== undefined, "预检应为越界调用注入 pathEscape");
    assert.equal(request.pathEscape.absolutePath, resolve(root, "../outside.txt"));

    const grantId = "grant_1";
    assert.ok(h.port.respond(grantId, "allow"), "ask 应回挂起审批单");
    const result = await running;

    assert.equal(result.results[0]!.isError, false);
    assert.equal(result.results[0]!.content, "read:../outside.txt");

    const capture = h.captured[0]!;
    assert.ok(capture.pathPolicy !== undefined, "获批越界必须注入 pathPolicy 钩子");
    const hook = capture.pathPolicy!.allowEscaped!;
    // 精确放行：仅审批通过的绝对路径（win32 口径由 normalizeForGuard 统一）
    assert.equal(hook(resolve(root, "../outside.txt")), true);
    assert.equal(hook(resolve(root, "../other.txt")), false, "未获批路径不得放行");
    assert.equal(hook(resolve(root, "inside.txt")), false, "workspace 内路径不经钩子放行");
  });

  it("workspace 内 read：不携带 pathEscape，不注入 pathPolicy（零回归）", async () => {
    const h = makeHarness();
    const running = h.run([{ toolCallId: "c1", toolName: "read", args: { path: "notes/a.txt" } }]);
    const result = await running;

    assert.equal(h.port.requests[0]!.pathEscape, undefined, "workspace 内路径不得注入 pathEscape");
    assert.equal(result.results[0]!.isError, false);
    assert.equal(h.captured[0]!.pathPolicy, undefined, "无越界批次不得注入 pathPolicy");
  });

  it("越界 read + 用户 deny：PERMISSION_DENIED 收束，不进执行（既有 deny 路径回归）", async () => {
    const h = makeHarness();
    const running = h.run([{ toolCallId: "c1", toolName: "read", args: { path: "../outside.txt" } }]);

    await until(() => h.port.requests.length === 1);
    assert.ok(h.port.respond("grant_1", "deny"));
    const result = await running;

    assert.equal(result.allBlocked, true);
    assert.equal(result.results[0]!.isError, true);
    assert.equal(result.results[0]!.error?.code, TOOL_ERROR_CODES.PERMISSION_DENIED);
    assert.equal(h.captured.length, 0, "被拒调用不得进入执行批次");
  });

  it("同批两个越界调用：分别审批，allow 精确放行其一路径、deny 拒绝另一个", async () => {
    const h = makeHarness();
    const running = h.run([
      { toolCallId: "c1", toolName: "read", args: { path: "../a.txt" } },
      { toolCallId: "c2", toolName: "read", args: { path: "../b.txt" } },
    ]);

    // tool-phase 顺序判定：c1 evaluate → ask 挂起 → respond 后 c2 才进入判定
    await until(() => h.port.requests.length === 1);
    assert.ok(h.port.requests[0]!.pathEscape !== undefined);
    assert.equal(h.port.requests[0]!.pathEscape!.absolutePath, resolve(root, "../a.txt"));
    assert.ok(h.port.respond("grant_1", "allow")); // c1 放行

    await until(() => h.port.requests.length === 2);
    assert.ok(h.port.requests[1]!.pathEscape !== undefined);
    assert.equal(h.port.requests[1]!.pathEscape!.absolutePath, resolve(root, "../b.txt"));
    assert.ok(h.port.respond("grant_2", "deny")); // c2 拒绝

    const result = await running;

    assert.equal(result.results[0]!.isError, false);
    assert.equal(result.results[1]!.error?.code, TOOL_ERROR_CODES.PERMISSION_DENIED);
    const hook = h.captured[0]!.pathPolicy!.allowEscaped!;
    assert.equal(hook(resolve(root, "../a.txt")), true, "仅获批路径放行");
    assert.equal(hook(resolve(root, "../b.txt")), false, "被拒路径不得借钩子放行");
  });

  it("join 语义回归：workspace 内深层路径与同义写法不触发预检", async () => {
    const h = makeHarness();
    const running = h.run([{ toolCallId: "c1", toolName: "read", args: { path: join("notes", "a.txt") } }]);
    const result = await running;
    assert.equal(h.port.requests[0]!.pathEscape, undefined);
    assert.equal(result.results[0]!.isError, false);
    assert.equal(h.captured[0]!.pathPolicy, undefined);
  });
});
