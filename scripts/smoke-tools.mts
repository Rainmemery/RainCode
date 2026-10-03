/**
 * 工具调用系统 smoke（第四波）。
 * 运行：tsx scripts/smoke-tools.mts（或 pnpm run smoke:tools）
 *
 * 链路：node:http 本地 mock OpenAI SSE 服务器（按请求次数脚本化多轮回复，tool_call delta
 * 分片下发以覆盖 llm 侧累积）→ 临时 RAINCODE_HOME → createAgentServiceNode（in-memory 绑定，
 * 显式 default-allow 权限策略——回归第四波测试审批路径，见 startScenario 注记）
 * → RPC session.send → agent-core 多轮 turn（ToolSchedule → ToolExecution → 回传）→ 断言：
 *
 * 用例 A（allow）：
 *   第一轮 text + read 工具调用（读临时文件）→ 第二轮 write 工具调用（写结果文件）
 *   → 第三轮纯文本总结。断言：两个工具均执行成功、events.jsonl 含 tool_call.started/completed、
 *   结果文件内容正确、最终回复包含文件内容摘要、无 tool_call 泄露到最终文本。
 * 用例 B（deny）：needsApproval 工具（write）+ always-deny 审批实现 →
 *   工具未执行（目标文件不存在）且模型收到 TOOL_PERMISSION_DENIED 拒绝结果并继续收束。
 *
 * 全程仅本机回环与临时目录：无外呼、无真实密钥。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemoryTransportPair, createRpcClient } from "../packages/rpc/src/index.ts";
import type { RpcClient } from "../packages/rpc/src/index.ts";
import { createAgentServiceNode } from "../packages/server/src/index.ts";
import { Storage } from "../packages/storage/src/index.ts";
import type {
  DoneEventPayload,
  MessageCompletedEventPayload,
  ToolCallCompletedEventPayload,
  ToolCallStartedEventPayload,
  ToolToolsListResult,
} from "../packages/shared/src/index.ts";

const MARKER = "NOVA-TOOL-SMOKE-42: tools are alive";

// ---------------------------------------------------------------------------
// mock OpenAI SSE 服务器：按请求序号回放脚本（每项 = SSE 帧序列 + finish_reason）
// ---------------------------------------------------------------------------

interface SseScript {
  frames: unknown[];
  finish: "stop" | "tool_calls";
}

function toolCallFrame(index: number, id: string, name: string, argsPart: string): unknown {
  return {
    choices: [
      {
        index: 0,
        delta: { tool_calls: [{ index, id, type: "function", function: { name, arguments: argsPart } }] },
      },
    ],
  };
}

function textFrame(text: string): unknown {
  return { choices: [{ index: 0, delta: { content: text } }] };
}

function startMockServer(
  script: SseScript[],
): Promise<{ port: number; requests: () => number; close: () => Promise<void> }> {
  let requests = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const turn = script[Math.min(requests, script.length - 1)]!;
    requests += 1;
    void Promise.resolve(req).then(() => {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(": keep-alive\n\n");
      for (const frame of turn.frames) {
        res.write(`data: ${JSON.stringify(frame)}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: turn.finish }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolvePromise({
        port,
        requests: () => requests,
        close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// 场景装配：临时 RAINCODE_HOME + workspace + in-memory 服务节点 + RPC 客户端
// ---------------------------------------------------------------------------

interface Scenario {
  home: string;
  workspace: string;
  client: RpcClient;
  requests: () => number;
  close: () => Promise<void>;
}

async function startScenario(
  name: string,
  approval: "always-allow" | "always-deny",
  script: SseScript[],
): Promise<Scenario> {
  const home = await mkdtemp(join(tmpdir(), `raincode-smoke-tools-${name}-`));
  const workspace = join(home, "ws");
  await mkdir(workspace, { recursive: true });
  const mock = await startMockServer(script);
  const transports = createInMemoryTransportPair();
  const node = await createAgentServiceNode(transports[1], {
    env: { RAINCODE_HOME: home },
    provider: {
      name: `mock-${name}`,
      baseURL: `http://127.0.0.1:${String(mock.port)}/v1`,
      model: "mock-model",
      apiKey: "smoke-dummy-key",
      maxContextTokens: 8192,
    },
    systemPrompt: "You are RainCode (smoke).",
    tools: { approval },
    // 第五波回归申报：显式 default-allow（仅开发策略）走第四波测试审批路径，保持本 smoke 语义不变
    permission: { policy: "default-allow" },
  });
  const client = createRpcClient({ transport: transports[0] });
  return {
    home,
    workspace,
    client,
    requests: () => mock.requests(),
    close: async () => {
      client.close();
      await node.close();
      await transports[0].close();
      await transports[1].close();
      await mock.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// 发送一条输入并收集事件直至 done（订阅先于 send，06 §1.2 串行不阻塞）
// ---------------------------------------------------------------------------

interface RunOutcome {
  done: DoneEventPayload;
  completed: MessageCompletedEventPayload[];
  toolStarted: ToolCallStartedEventPayload[];
  toolCompleted: ToolCallCompletedEventPayload[];
}

function attachAndRun(client: RpcClient, sessionId: string, text: string): Promise<RunOutcome> {
  return new Promise((resolvePromise, rejectPromise) => {
    const completed: MessageCompletedEventPayload[] = [];
    const toolStarted: ToolCallStartedEventPayload[] = [];
    const toolCompleted: ToolCallCompletedEventPayload[] = [];
    const offCompleted = client.onEvent("message.completed", (payload) =>
      completed.push(payload as MessageCompletedEventPayload),
    );
    const offStarted = client.onEvent("tool_call.started", (payload) =>
      toolStarted.push(payload as ToolCallStartedEventPayload),
    );
    const offToolCompleted = client.onEvent("tool_call.completed", (payload) =>
      toolCompleted.push(payload as ToolCallCompletedEventPayload),
    );
    const finish = (resolve: (outcome: RunOutcome) => void, payload: unknown): void => {
      offCompleted();
      offStarted();
      offToolCompleted();
      offDone();
      resolve({
        done: payload as DoneEventPayload,
        completed,
        toolStarted,
        toolCompleted,
      });
    };
    const offDone = client.onEvent("done", (payload) => finish(resolvePromise, payload));
    client.call("session.send", { sessionId, input: { text } }).catch((reason: unknown) => {
      offCompleted();
      offStarted();
      offToolCompleted();
      offDone();
      rejectPromise(reason);
    });
  });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf8");
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  // 用例 A：read → write → 纯文本总结（approval = always-allow）
  // -------------------------------------------------------------------------
  {
    const readArgs = JSON.stringify({ path: "notes/nova-input.txt" });
    const writeArgs = JSON.stringify({ path: "notes/nova-result.txt", content: `read ok — ${MARKER}` });
    const script: SseScript[] = [
      {
        // 第一轮：text + read 工具调用（arguments 分片下发，覆盖 llm 侧增量累积）
        finish: "tool_calls",
        frames: [
          { choices: [{ index: 0, delta: { role: "assistant", content: "" } }] },
          textFrame("我先读取输入文件。"),
          toolCallFrame(0, "call_read_1", "read", readArgs.slice(0, 9)),
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: readArgs.slice(9) } }] } }] },
        ],
      },
      {
        // 第二轮：write 工具调用（无正文）
        finish: "tool_calls",
        frames: [
          { choices: [{ index: 0, delta: { role: "assistant", content: "" } }] },
          toolCallFrame(0, "call_write_1", "write", writeArgs.slice(0, 30)),
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: writeArgs.slice(30) } }] } }] },
        ],
      },
      {
        // 第三轮：纯文本总结（stop）
        finish: "stop",
        frames: [
          { choices: [{ index: 0, delta: { role: "assistant", content: "" } }] },
          textFrame(`汇总：输入文件内容为 ${MARKER}，已写入结果文件。`),
          { choices: [], usage: { prompt_tokens: 30, completion_tokens: 12 } },
        ],
      },
    ];
    const scenario = await startScenario("allow", "always-allow", script);
    try {
      await scenario.client.call("system.ping", {});
      const toolsList = await scenario.client.call<ToolToolsListResult>("tool.tools.list", {});
      // T2.7 P1 起内置清单含 web_fetch / ask_user_question；T4.4 增 skill（02 §2.3 全 11 项）
      assert.equal(toolsList.tools.length, 11, "tool.tools.list 应返回 11 个内置工具");
      assert.ok(toolsList.tools.every((tool) => tool.source === "builtin"));

      const created = await scenario.client.call<{ sessionId: string }>("session.create", {
        workspaceRoot: scenario.workspace,
        title: "smoke-tools allow",
      });
      const sessionId = created.sessionId;

      // 预置输入文件（read 的读取目标）
      await mkdir(join(scenario.workspace, "notes"), { recursive: true });
      await writeFile(join(scenario.workspace, "notes", "nova-input.txt"), MARKER, "utf8");

      const outcome = await attachAndRun(
        scenario.client,
        sessionId,
        "把 notes/nova-input.txt 的内容写入 notes/nova-result.txt",
      );
      assert.equal(outcome.done.outcome, "completed", "用例 A turn 应 completed");
      assert.equal(scenario.requests(), 3, "mock 应收到 3 次请求（read 轮 / write 轮 / 总结轮）");

      // 1) 两个工具均执行成功
      const startedNames = outcome.toolStarted.map((event) => event.toolName);
      assert.ok(
        startedNames.includes("read") && startedNames.includes("write"),
        `started 应含 read/write：${startedNames.join(",")}`,
      );
      assert.equal(outcome.toolStarted.length, 2);
      assert.equal(outcome.toolCompleted.length, 2);
      assert.ok(outcome.toolCompleted.every((event) => !event.isError), "两个工具都应执行成功");
      assert.ok(
        outcome.toolStarted.every((event) => event.batchIndex === 0 && event.batchSize === 1),
        "started 事件应带 batchIndex/batchSize（本轮各含 1 个调用）",
      );

      // 2) events.jsonl 持久化（started/completed 落盘；progress 为瞬态不落盘；tool 消息行落库）
      const storage = await Storage.open({ env: { RAINCODE_HOME: scenario.home } });
      const eventsFile = await storage.sessionEventsFile(sessionId);
      const raw = await readFile(eventsFile, "utf8");
      assert.ok(raw.includes('"name":"tool_call.started"'), "events.jsonl 应含 tool_call.started");
      assert.ok(raw.includes('"name":"tool_call.completed"'), "events.jsonl 应含 tool_call.completed");
      assert.ok(!raw.includes('"name":"tool_call.progress"'), "tool_call.progress 为 UI 瞬态不落盘");
      assert.ok(raw.includes('"role":"tool"'), "工具结果应以 role:tool 消息行落库");
      const replay = await storage.resumeSession(sessionId);
      const toolRows = replay.history.filter((message) => message.role === "tool");
      assert.equal(toolRows.length, 2, "应落库 2 条 tool 结果消息");
      await storage.close();

      // 3) 结果文件内容正确（write 真实生效）
      const written = await readFile(join(scenario.workspace, "notes", "nova-result.txt"), "utf8");
      assert.equal(written, `read ok — ${MARKER}`, "write 结果文件内容应与模型参数一致");

      // 4) 最终回复包含文件内容摘要；5) 无 tool_call 泄露到最终文本
      const finalMessage = [...outcome.completed].reverse().find((event) => event.message.stopReason === "stop");
      assert.ok(finalMessage !== undefined, "应有 stop 收束的 message.completed");
      assert.ok(finalMessage.message.content.includes(MARKER), "最终回复应包含文件内容摘要");
      assert.ok(!finalMessage.message.content.includes("tool_call"), "最终文本不得泄露 tool_call 字样");
      assert.ok(!finalMessage.message.content.includes('"path"'), "最终文本不得泄露工具参数 JSON");
      assert.equal(finalMessage.message.toolCalls, undefined, "stop 收束消息不应携带 toolCalls");
      console.log("用例 A：read/write 均执行成功，事件与 tool 消息落库，结果文件正确，最终回复无泄露");
    } finally {
      await scenario.close();
    }
  }

  // -------------------------------------------------------------------------
  // 用例 B：needsApproval 工具 + always-deny → 工具未执行、模型收到拒绝结果
  // -------------------------------------------------------------------------
  {
    const deniedArgs = JSON.stringify({ path: "out/denied.txt", content: "should not exist" });
    const script: SseScript[] = [
      {
        finish: "tool_calls",
        frames: [
          { choices: [{ index: 0, delta: { role: "assistant", content: "" } }] },
          toolCallFrame(0, "call_write_deny", "write", deniedArgs),
        ],
      },
      {
        finish: "stop",
        frames: [
          { choices: [{ index: 0, delta: { role: "assistant", content: "" } }] },
          textFrame("写入被用户拒绝，我不会重试。"),
        ],
      },
    ];
    const scenario = await startScenario("deny", "always-deny", script);
    try {
      await scenario.client.call("system.ping", {});
      const created = await scenario.client.call<{ sessionId: string }>("session.create", {
        workspaceRoot: scenario.workspace,
        title: "smoke-tools deny",
      });
      const outcome = await attachAndRun(scenario.client, created.sessionId, "把结果写入 out/denied.txt");
      assert.equal(outcome.done.outcome, "completed", "拒绝路径 turn 仍应正常收束");
      assert.equal(scenario.requests(), 2, "拒绝结果应回传模型并触发第二轮");

      // 工具未执行：目标文件不存在；completed isError=true 且错误码为 TOOL_PERMISSION_DENIED
      assert.equal(await fileExists(join(scenario.workspace, "out", "denied.txt")), false, "被拒工具不得产生文件副作用");
      assert.equal(outcome.toolCompleted.length, 1);
      assert.equal(outcome.toolCompleted[0]?.isError, true);
      assert.equal(outcome.toolCompleted[0]?.error?.code, "TOOL_PERMISSION_DENIED");

      // 拒绝结果以 tool 消息行落库（模型可见），且无悬挂 tool_call
      const storage = await Storage.open({ env: { RAINCODE_HOME: scenario.home } });
      const replay = await storage.resumeSession(created.sessionId);
      const toolRow = replay.history.find((message) => message.role === "tool");
      assert.ok(toolRow !== undefined, "拒绝结果应落库为 tool 消息行");
      assert.equal(toolRow.isError, true);
      assert.ok(toolRow.content.includes("TOOL_PERMISSION_DENIED"));
      assert.equal(replay.synthesizedToolResults.length, 0, "不应存在悬挂 tool_call");
      await storage.close();
      console.log("用例 B：needsApproval 工具被 deny，未执行、无副作用，模型收到拒绝结果并收束");
    } finally {
      await scenario.close();
    }
  }

  console.log("");
  console.log("SMOKE OK");
}

main().catch((reason: unknown) => {
  console.error("");
  console.error("SMOKE FAILED:", reason);
  process.exitCode = 1;
});
