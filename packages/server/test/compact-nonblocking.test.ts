/**
 * NFR-6 专项单测（07-dev-plan §3.4：`compact-nonblocking`——压缩窗口内注入输入与
 * 工具调用探测，断言零排队等待）：auto-compact 摘要请求延迟窗口内
 *   a) session.send 仍即返受理（< 100ms，不等待压缩完成）；
 *   b) tool.tools.list 控制面探测即返（< 100ms）；
 *   c) compact.completed 正常收敛（ok=true）。
 * 与 smoke:compact 用例 A 同一装配口径（in-memory 节点 + mock LLM），此为单测粒度回归。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemoryTransportPair, createRpcClient } from "@raincode/rpc";
import type { RpcClient } from "@raincode/rpc";
import { createAgentServiceNode } from "../src/index.js";

const WINDOW_TOKENS = 200; // 阈值 0.8×200=160；首回 usage.promptTokens=500 必触发
const SUMMARY_DELAY_MS = 600; // 摘要延迟 = 压缩探测窗口
const ADMIT_BUDGET_MS = 100; // NFR-6「零排队等待」的单测可执行化预算

interface MockLlm {
  url: string;
  setScript(script: Array<{ frames: unknown[]; finish: string; delayMs?: number }>): void;
  close(): Promise<void>;
}

/** 极简 mock OpenAI SSE 服务器（按请求序回放脚本项；帧形态与 p0-lib 同源口径）。 */
async function startMock(): Promise<MockLlm> {
  let script: Array<{ frames: unknown[]; finish: string; delayMs?: number }> = [];
  const server = createServer((_req, res) => {
    const item = script.shift() ?? { frames: [], finish: "stop" };
    const respond = (): void => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const frame of item.frames) {
        res.write(`data: ${JSON.stringify(frame)}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
    };
    if (item.delayMs !== undefined) {
      setTimeout(respond, item.delayMs);
    } else {
      respond();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${String(port)}/v1`,
    setScript: (s) => {
      script = s;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function textReply(text: string, promptTokens: number): { frames: unknown[]; finish: string } {
  return {
    frames: [
      { choices: [{ index: 0, delta: { role: "assistant", content: "" } }] },
      { choices: [{ index: 0, delta: { content: text } }] },
      { choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: 5 } },
    ],
    finish: "stop",
  };
}

interface Harness {
  client: RpcClient;
  mock: MockLlm;
  close(): Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), "raincode-nfr6-"));
  const workspace = join(home, "ws");
  await mkdir(workspace, { recursive: true });
  const mock = await startMock();
  const transports = createInMemoryTransportPair();
  const node = await createAgentServiceNode(transports[1], {
    env: { RAINCODE_HOME: home },
    provider: {
      name: "mock-nfr6",
      baseURL: mock.url,
      model: "mock-model",
      apiKey: "test-dummy-key",
      maxContextTokens: WINDOW_TOKENS,
    },
    tools: { approval: "always-allow" },
    permission: { policy: "default-allow" },
    compaction: { keepRecentCount: 1 },
  });
  const client = createRpcClient({ transport: transports[0] });
  await client.call("system.ping", {});
  return {
    client,
    mock,
    close: async () => {
      client.close();
      await new Promise((r) => setTimeout(r, 30));
      await node.close();
      await transports[0].close();
      await transports[1].close();
      await mock.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

test("compact-nonblocking: 压缩摘要窗口内 send/控制面探测零排队等待", async () => {
  const harness = await startHarness();
  try {
    const { client, mock } = harness;
    // 脚本：请求1 = turn1 回复（usage 500 ≥ 阈值触发 auto-compact）；请求2 = 摘要（延迟 600ms 制造压缩窗口）
    mock.setScript([
      textReply("第一轮回复", 500),
      {
        frames: [{ choices: [{ index: 0, delta: { content: "[上下文压缩] 摘要" } }] }],
        finish: "stop",
        delayMs: SUMMARY_DELAY_MS,
      },
    ]);
    const completed = new Promise<{ ok: boolean }>((resolve) => {
      client.onEvent("compact.completed", (payload) => resolve(payload as { ok: boolean }));
    });
    const created = await client.call<{ sessionId: string }>("session.create", {
      workspaceRoot: process.cwd(),
      title: "nfr6",
    });
    await client.call("session.send", { sessionId: created.sessionId, input: { text: "第一轮" } });
    await new Promise((r) => setTimeout(r, 200)); // turn1 收束 + compact.started（摘要请求挂起中）

    // 探测 a：压缩窗口内 send 即返受理（不等摘要完成）
    const t0 = Date.now();
    await client.call("session.send", { sessionId: created.sessionId, input: { text: "压缩窗口期注入" } });
    const admitMs = Date.now() - t0;
    assert.ok(admitMs < ADMIT_BUDGET_MS, `send 受理 ${String(admitMs)}ms 应 < ${String(ADMIT_BUDGET_MS)}ms（零排队等待）`);

    // 探测 b：压缩窗口内控制面即返
    const t1 = Date.now();
    await client.call("tool.tools.list", {});
    const toolsMs = Date.now() - t1;
    assert.ok(toolsMs < ADMIT_BUDGET_MS, `tools.list ${String(toolsMs)}ms 应 < ${String(ADMIT_BUDGET_MS)}ms`);

    // 压缩正常收敛
    const result = await completed;
    assert.equal(result.ok, true);
  } finally {
    await harness.close();
  }
});
