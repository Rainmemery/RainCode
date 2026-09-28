/**
 * Wave 2 验证脚本（walking skeleton 第二波）。
 * 运行：tsx scripts/verify-wave2.mts
 *
 * 覆盖：
 *  1) storage：临时 NOVACODE_HOME → 建 workspace/session → append 3 条 → checkpoint
 *     （含 epoch 单调合并：旧 epoch 拒绝、compact epoch+1 提升）→ 重开 Storage →
 *     resumeRead O(1) 定位 + 增量重放一致 → 悬挂 tool_call 补齐 → 半行残尾诊断与修复；
 *  2) llm：本地 mock SSE 服务器（127.0.0.1）验证流式解析 / usage / HTTP 错误 / AbortSignal 贯穿取消。
 *
 * 全程仅本机回环与临时目录：无外呼、无密钥。
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, appendFile, readdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  LlmAbortedError,
  LlmClient,
  LlmHttpError,
  normalizeBaseUrl,
  type LlmStreamEvent,
} from "../packages/llm/src/index.ts";
import { Storage, ulid } from "../packages/storage/src/index.ts";
import type { MessageRecord } from "../packages/shared/src/index.ts";

// ---------------------------------------------------------------------------
// storage 验证
// ---------------------------------------------------------------------------

async function verifyStorage(): Promise<void> {
  console.log("=== storage：临时 NOVACODE_HOME → 建会话 → 追加 → checkpoint → 重开恢复 ===");
  const home = await mkdtemp(join(tmpdir(), "novacode-wave2-"));
  const env = { NOVACODE_HOME: home };
  const workspaceRoot = join(home, "workspace-demo");
  await mkdir(workspaceRoot, { recursive: true });

  // Phase A：创建 workspace / session，追加 3 条消息，checkpoint（含 epoch 单调合并）
  const storageA = await Storage.open({ env });
  const ws = await storageA.ensureWorkspace(workspaceRoot);
  assert.equal(ws.hash.length, 16);
  console.log(`workspace 登记: hash=${ws.hash} root=${ws.rootPath}`);

  const session = await storageA.createSession({ workspaceHash: ws.hash, workspaceRoot, title: "wave2 验证" });
  console.log(`session 创建: ${session.id}（JSONL 头行已落盘，schemaVersion+epoch）`);

  const userMsg: MessageRecord = { id: `msg_${ulid()}`, role: "user", content: "修复 login 401" };
  const assistantMsg: MessageRecord = {
    id: `msg_${ulid()}`,
    role: "assistant",
    content: [
      { type: "text", text: "先看仓库状态。" },
      { type: "tool_call", toolCallId: "tc_01", name: "bash", arguments: { command: "git status" } },
    ],
  };
  const toolMsg: MessageRecord = {
    id: `msg_${ulid()}`,
    role: "tool",
    toolCallId: "tc_01",
    content: "On branch main",
    isError: false,
  };

  const streamA = await storageA.openSessionStream(session.id);
  for (const [index, message] of [userMsg, assistantMsg, toolMsg].entries()) {
    const appended = await streamA.appendMessage(message);
    if (!appended.accepted) throw new Error("append should be accepted");
    assert.equal(appended.seq, index + 2); // 头行 seq=1
  }
  console.log("追加 3 条 message 行（seq 2..4）");

  const staleBeforeCompact = await streamA.appendMessage(
    { id: `msg_${ulid()}`, role: "user", content: "stale" },
    { epoch: -1 },
  );
  assert.equal(staleBeforeCompact.accepted, false);
  console.log("旧 epoch (-1) 追加被拒绝（未落盘）");

  const cp1 = await storageA.writeCheckpoint(session.id, {
    mode: "normal",
    todo: [],
    messageCount: 3,
    usage: { inputTokens: 3120, outputTokens: 87 },
  });
  if (!cp1.accepted) throw new Error("checkpoint#1 should be accepted");
  assert.equal(cp1.epoch, 0);
  assert.equal(cp1.pos, streamA.byteLength);
  console.log(`checkpoint#1 落盘并 fsync（epoch=0 offset=${cp1.lineStartOffset} pos=${cp1.pos}）`);

  const cp2 = await storageA.writeCheckpoint(
    session.id,
    { mode: "normal", todo: [], messageCount: 3 },
    { epoch: 1 }, // compact 提交：epoch+1
  );
  if (!cp2.accepted) throw new Error("checkpoint#2 should be accepted");

  const staleAfterCompact = await streamA.appendMessage(
    { id: `msg_${ulid()}`, role: "user", content: "old snapshot" },
    { epoch: 0 },
  );
  assert.equal(staleAfterCompact.accepted, false);
  assert.equal(streamA.rejectedWrites, 2);
  console.log("compact epoch+1 后旧快照写入（epoch=0）被拒：单调合并最小落地，rejectedWrites=2");
  await storageA.close();

  // Phase B：重开 repo → resumeRead 一致（recorded 定位 + 对账回写）
  const storageB = await Storage.open({ env });
  const resumed1 = await storageB.resumeSession(session.id);
  assert.equal(resumed1.source, "recorded"); // checkpoint_offset O(1) 定位命中
  assert.ok(resumed1.checkpoint);
  assert.equal(resumed1.checkpoint.epoch, 1);
  assert.equal(resumed1.epoch, 1);
  assert.equal(resumed1.messages.length, 0); // checkpoint 后无增量
  assert.equal(resumed1.messageCount, 3); // 对账口径 = checkpoint.state.messageCount
  assert.equal(resumed1.danglingTailLines, 0);
  assert.deepEqual(resumed1.history, [userMsg, assistantMsg, toolMsg]); // 完整历史重建一致
  const rowB = await storageB.sessions.get(session.id);
  assert.equal(rowB?.epoch, 1);
  assert.equal(rowB?.checkpointOffset, resumed1.checkpoint.offset);
  console.log("resume#1: recorded 定位命中，epoch=1，messageCount 对账=3，history 深度一致");

  const streamB = await storageB.openSessionStream(session.id);
  assert.equal(streamB.seq, 6); // 续写行号来自尾部扫描（header1 + 3 消息 + 2 checkpoint）
  await streamB.appendMessage({
    id: `msg_${ulid()}`,
    role: "assistant",
    content: [{ type: "tool_call", toolCallId: "tc_02", name: "read", arguments: { path: "src/a.ts" } }],
  });
  await storageB.close();

  // Phase C：悬挂 tool_call 补齐 + 半行残尾
  const storageC = await Storage.open({ env });
  const resumed2 = await storageC.resumeSession(session.id);
  assert.equal(resumed2.messages.length, 1); // 增量：checkpoint 之后 1 条
  assert.equal(resumed2.synthesizedToolResults.length, 1);
  assert.equal(resumed2.synthesizedToolResults[0]?.toolCallId, "tc_02");
  assert.equal(resumed2.synthesizedToolResults[0]?.isError, true);
  assert.equal(resumed2.synthesizedToolResults[0]?.content, "进程中断，结果丢失");
  assert.equal(resumed2.messageCount, 4);
  assert.equal(resumed2.history.length, 4);
  console.log("resume#2: 悬挂 tool_call(tc_02) 已按 isError=true 补齐，对账 messageCount=4");

  const eventsFile = await storageC.sessionEventsFile(session.id);
  await appendFile(eventsFile, '{"v":1,"type":"mess'); // 模拟崩溃半行（无换行）
  const resumed3 = await storageC.resumeSession(session.id);
  assert.equal(resumed3.danglingTailLines, 1);
  console.log("resume#3: EOF 半行残尾已计数（danglingTailLines=1，只读不改写）");

  await storageC.appendMessage(session.id, {
    id: `msg_${ulid()}`,
    role: "tool",
    toolCallId: "tc_02",
    content: "file content",
    isError: false,
  }); // 打开流时触发残尾修复（另存 .tail-<ts> 后截去），随后正常续写
  await storageC.writeCheckpoint(session.id, { mode: "normal", todo: [], messageCount: 5 });
  await storageC.close();
  const dirEntries = await readdir(dirname(eventsFile));
  assert.ok(dirEntries.some((name) => name.startsWith("events.jsonl.tail-")));
  console.log("残尾已另存 events.jsonl.tail-* 并截去；修复后续写 + checkpoint 正常");

  // Phase D：最终一致性
  const storageD = await Storage.open({ env });
  const resumed4 = await storageD.resumeSession(session.id);
  assert.equal(resumed4.danglingTailLines, 0);
  assert.equal(resumed4.history.length, 5);
  assert.equal(resumed4.messageCount, 5);
  const rowD = await storageD.sessions.get(session.id);
  assert.equal(rowD?.messageCount, 5);
  assert.equal(rowD?.epoch, 1);
  const listed = await storageD.sessions.list({ workspaceHash: ws.hash, status: "active" });
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.id, session.id);
  await storageD.close();
  console.log("resume#4: 修复后重放干净（dangling=0, history=5, 对账=5, list 命中 1 条）");
  console.log(`数据根（临时 NOVACODE_HOME）: ${home}`);
}

// ---------------------------------------------------------------------------
// llm 验证（本地 mock SSE 服务器）
// ---------------------------------------------------------------------------

interface MockState {
  lastAuth: string | null;
}

async function handleMock(req: IncomingMessage, res: ServerResponse, state: MockState): Promise<void> {
  const auth = req.headers["authorization"];
  state.lastAuth = Array.isArray(auth) ? (auth[0] ?? null) : (auth ?? null);
  const caseHeader = req.headers["x-mock-case"];
  const testCase = (Array.isArray(caseHeader) ? caseHeader[0] : caseHeader) ?? "ok";

  if (testCase === "error") {
    res.writeHead(500, { "content-type": "application/json" });
    res.end('{"error":{"message":"mock internal error","type":"server_error"}}');
    return;
  }
  if (testCase === "hang") {
    // 流式响应但永不结束：验证流读取中的 AbortSignal 取消
    res.writeHead(200, { "content-type": "text/event-stream" });
    const timer = setInterval(() => {
      res.write(": keep-alive\n\n");
    }, 50);
    req.on("close", () => clearInterval(timer));
    return;
  }
  // 标准 OpenAI 兼容 SSE 序列（含 keep-alive 注释行、usage chunk、[DONE]）
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  res.write(": keep-alive\n\n");
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "" } }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "你好" } }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "，世界" } }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
  res.write(
    `data: ${JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 3 } },
    })}\n\n`,
  );
  res.write("data: [DONE]\n\n");
  res.end();
}

function startMockServer(): Promise<{ port: number; state: MockState; close: () => Promise<void> }> {
  const state: MockState = { lastAuth: null };
  const server = createServer((req, res) => {
    void handleMock(req, res, state);
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolvePromise({
        port,
        state,
        close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
      });
    });
  });
}

async function verifyLlm(): Promise<void> {
  console.log("=== llm：本地 mock SSE 服务器（流式 / usage / HTTP 错误 / Abort） ===");

  // baseURL 归一：无路径补 /v1；尾斜杠去除；自定义路径保留
  assert.equal(normalizeBaseUrl("https://api.example.com"), "https://api.example.com/v1");
  assert.equal(normalizeBaseUrl("https://api.example.com/"), "https://api.example.com/v1");
  assert.equal(normalizeBaseUrl("https://api.example.com/v1/"), "https://api.example.com/v1");
  assert.equal(normalizeBaseUrl("https://api.example.com/openai/v1"), "https://api.example.com/openai/v1");
  console.log("baseURL 归一通过");

  const mock = await startMockServer();
  try {
    const provider = {
      id: "mock",
      name: "Mock Provider",
      baseURL: `http://127.0.0.1:${mock.port}/v1`,
      model: "mock-model",
      maxContextTokens: 8192,
      apiKeyRef: null,
    };
    const messages = [{ role: "user" as const, content: "打个招呼" }];

    // 1) 正常流式：逐 delta 回调 + role + finish_reason + usage + [DONE]
    const client = new LlmClient({ provider, apiKey: "test-key" });
    const events: LlmStreamEvent[] = [];
    const result = await client.streamChat({
      messages,
      includeUsage: true,
      onEvent: (event) => {
        events.push(event);
      },
    });
    assert.equal(mock.state.lastAuth, "Bearer test-key");
    assert.equal(events[0]?.type, "stream.opened");
    const texts = events
      .filter((event): event is Extract<LlmStreamEvent, { type: "delta.text" }> => event.type === "delta.text")
      .map((event) => event.text);
    assert.deepEqual(texts, ["你好", "，世界"]);
    assert.ok(events.some((event) => event.type === "role" && event.role === "assistant"));
    assert.ok(events.some((event) => event.type === "finish" && event.finishReason === "stop"));
    assert.ok(
      events.some(
        (event) =>
          event.type === "usage" &&
          event.usage.inputTokens === 10 &&
          event.usage.outputTokens === 5 &&
          event.usage.cachedTokens === 3,
      ),
    );
    assert.equal(events.at(-1)?.type, "done");
    assert.equal(result.finishReason, "stop");
    assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 5, cachedTokens: 3 });
    console.log("流式解析：delta.text/role/finish/usage/[DONE] 逐事件回调；Authorization 头正确");

    // 2) HTTP 500 → LlmHttpError
    const clientError = new LlmClient({
      provider,
      apiKey: "test-key",
      defaultHeaders: { "x-mock-case": "error" },
    });
    await assert.rejects(
      () => clientError.streamChat({ messages, onEvent: () => {} }),
      (reason: unknown) => reason instanceof LlmHttpError && reason.status === 500,
    );
    console.log("HTTP 错误：500 → LlmHttpError(status=500, code=LLM_HTTP_ERROR)");

    // 3) 流读取中中止 → LlmAbortedError（AbortSignal 贯穿）
    const clientHang = new LlmClient({
      provider,
      apiKey: "test-key",
      defaultHeaders: { "x-mock-case": "hang" },
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 150);
    await assert.rejects(
      () => clientHang.streamChat({ messages, signal: controller.signal, onEvent: () => {} }),
      LlmAbortedError,
    );
    clearTimeout(timer);
    console.log("取消：流读取中 AbortSignal 触发 → LlmAbortedError");

    // 4) 请求前已中止 → LlmAbortedError（零网络开销）
    const preAborted = new AbortController();
    preAborted.abort();
    await assert.rejects(
      () => client.streamChat({ messages, signal: preAborted.signal, onEvent: () => {} }),
      LlmAbortedError,
    );
    console.log("取消：请求前已中止 → LlmAbortedError");
  } finally {
    await mock.close();
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await verifyStorage();
  await verifyLlm();
  console.log("");
  console.log("OK — wave2 验证全部通过");
}

main().catch((reason: unknown) => {
  console.error("");
  console.error("FAILED:", reason);
  process.exitCode = 1;
});
