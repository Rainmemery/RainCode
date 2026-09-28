/**
 * 端到端 smoke（walking skeleton 第三波）。
 * 运行：tsx scripts/smoke-e2e.mts（或 pnpm run smoke:e2e）
 *
 * 链路：node:http 本地 mock OpenAI SSE 服务器（固定脚本化 delta 序列 + usage + [DONE]）
 *   → 临时 NOVACODE_HOME（数据根隔离）→ CLI run 路径（进程内调用 apps/cli main()，
 *   覆盖 参数解析 → in-memory 绑定 → server 方法表 → agent-core turn 循环 → llm → storage 全链）
 *   → 断言：
 *     1) stdout 收到完整流式文本（50ms 批量节流后合并与原文一致）；
 *     2) apiKey 不出现在 stdout/stderr；
 *     3) session.list 经 RPC 可见 1 条；
 *     4) events.jsonl 含 turn.phase_changed / message.completed / done / checkpoint，
 *        且 message.delta 不落盘（UI 瞬态，05-database §4.2）；
 *     5) resume 后历史一致，且恢复出的会话可继续完成第二个 turn。
 *
 * 全程仅本机回环与临时目录：无外呼、无真实密钥。
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main as cliMain } from "../apps/cli/src/index.ts";
import { createInMemoryTransportPair, createRpcClient } from "../packages/rpc/src/index.ts";
import { createAgentServiceNode } from "../packages/server/src/index.ts";
import type { MessageRecord, SessionListResult, SessionResumeResult } from "../packages/shared/src/index.ts";
import { Storage } from "../packages/storage/src/index.ts";
import type { DoneEventPayload } from "../packages/shared/src/index.ts";

const SCRIPTED_DELTAS = ["你好，", "NovaCode！", " walking skeleton 已打通。"];
const FULL_TEXT = SCRIPTED_DELTAS.join("");
const DUMMY_API_KEY = "smoke-dummy-key-DO-NOT-PRINT";

// ---------------------------------------------------------------------------
// mock OpenAI SSE 服务器
// ---------------------------------------------------------------------------

function startMockServer(): Promise<{ port: number; requests: number; close: () => Promise<void> }> {
  let requests = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    requests += 1;
    void Promise.resolve(req).then(() => {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(": keep-alive\n\n");
      res.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "" } }] })}\n\n`,
      );
      for (const delta of SCRIPTED_DELTAS) {
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: delta } }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.write(
        `data: ${JSON.stringify({
          choices: [],
          usage: { prompt_tokens: 21, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 4 } },
        })}\n\n`,
      );
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
        get requests() {
          return requests;
        },
        close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// stdout/stderr 捕获（CLI 进程内调用的输出收集）
// ---------------------------------------------------------------------------

type WriteFn = typeof process.stdout.write;

function captureStreams(): { restore: () => void; getOut: () => string; getErr: () => string } {
  let out = "";
  let err = "";
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = ((chunk: unknown) => {
    out += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  }) as WriteFn;
  process.stderr.write = ((chunk: unknown) => {
    err += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  }) as WriteFn;
  return {
    restore: () => {
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
    },
    getOut: () => out,
    getErr: () => err,
  };
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const mock = await startMockServer();
  const home = await mkdtemp(join(tmpdir(), "novacode-smoke-e2e-"));
  const workspace = join(home, "ws");
  await mkdir(workspace, { recursive: true });

  const savedEnv: Array<[string, string | undefined]> = [
    ["NOVACODE_HOME", process.env["NOVACODE_HOME"]],
    ["NOVACODE_PROVIDER_BASE_URL", process.env["NOVACODE_PROVIDER_BASE_URL"]],
    ["NOVACODE_PROVIDER_MODEL", process.env["NOVACODE_PROVIDER_MODEL"]],
    ["NOVACODE_PROVIDER_API_KEY", process.env["NOVACODE_PROVIDER_API_KEY"]],
  ];
  const setEnv = (key: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  setEnv("NOVACODE_HOME", home);
  setEnv("NOVACODE_PROVIDER_BASE_URL", `http://127.0.0.1:${String(mock.port)}/v1`);
  setEnv("NOVACODE_PROVIDER_MODEL", "mock-model");
  setEnv("NOVACODE_PROVIDER_API_KEY", DUMMY_API_KEY);

  try {
    // 1) CLI run 路径（进程内）：非交互 run
    const captured = captureStreams();
    let exitCode: number;
    try {
      exitCode = await cliMain(["run", "打个招呼"]);
    } finally {
      captured.restore();
    }
    assert.equal(exitCode, 0, `run 应以 0 退出，实际 ${exitCode}\nstderr: ${captured.getErr()}`);
    const stdoutText = captured.getOut();
    assert.ok(stdoutText.includes(FULL_TEXT), "stdout 应包含完整流式文本（批量合并后）");
    assert.ok(!stdoutText.includes(DUMMY_API_KEY), "apiKey 不得出现在 stdout");
    assert.ok(!captured.getErr().includes(DUMMY_API_KEY), "apiKey 不得出现在 stderr");
    console.log("step1 CLI run：exit=0，stdout 流式全文一致，apiKey 零泄露");

    // 2) 持久化事实（临时 NOVACODE_HOME 下新开只读连接）
    const storage = await Storage.open({ env: { NOVACODE_HOME: home } });
    const sessions = await storage.sessions.list({});
    assert.equal(sessions.length, 1, "session.list（storage 直查）应恰好 1 条");
    const sessionId = sessions[0]!.id;
    const eventsFile = await storage.sessionEventsFile(sessionId);
    const raw = await readFile(eventsFile, "utf8");
    assert.ok(raw.includes('"type":"checkpoint"'), "events.jsonl 应含 checkpoint 行");
    assert.ok(raw.includes('"name":"message.completed"'), "events.jsonl 应含 message.completed 事件");
    assert.ok(raw.includes('"name":"turn.phase_changed"'), "events.jsonl 应含 turn.phase_changed 事件");
    assert.ok(raw.includes('"name":"done"'), "events.jsonl 应含 done 事件");
    assert.ok(!raw.includes('"name":"message.delta"'), "message.delta 为 UI 瞬态，不落盘（05 §4.2）");
    assert.ok(raw.includes("你好，"), "assistant 正文已落库");
    console.log("step2 events.jsonl：checkpoint / message.completed / turn.phase_changed / done 齐备，delta 未落盘");

    // 3) resume：历史一致（checkpoint + 增量重放）
    const replay = await storage.resumeSession(sessionId);
    assert.equal(replay.history.length, 2, "resume 历史应为 [user, assistant]");
    const first: MessageRecord | undefined = replay.history[0];
    const second: MessageRecord | undefined = replay.history[1];
    assert.ok(first?.role === "user" && first.content === "打个招呼");
    assert.ok(second?.role === "assistant" && second.content === FULL_TEXT);
    console.log("step3 resume：历史一致（user + assistant 全文）");

    // 4) RPC 路径：新服务实例挂同一数据根 → session.list / session.resume / 续聊第二个 turn
    const transports = createInMemoryTransportPair();
    const node = await createAgentServiceNode(transports[1], {
      env: { NOVACODE_HOME: home },
      provider: {
        name: "mock",
        baseURL: `http://127.0.0.1:${String(mock.port)}/v1`,
        model: "mock-model",
        apiKey: DUMMY_API_KEY,
        maxContextTokens: 8192,
      },
    });
    const client = createRpcClient({ transport: transports[0] });
    try {
      await client.call("system.ping", {});
      const listResult = await client.call<SessionListResult>("session.list", {});
      assert.equal(listResult.items.length, 1, "session.list（RPC）应可见 1 条");
      assert.equal(listResult.items[0]?.id, sessionId);
      assert.equal(listResult.items[0]?.state, "Active");

      const resumeResult = await client.call<SessionResumeResult>("session.resume", { sessionId });
      assert.equal(resumeResult.snapshot.phase, "Idle");
      assert.ok(resumeResult.snapshot.lastSeq > 0, "snapshot.lastSeq 应为正");
      assert.equal(resumeResult.snapshot.model, "mock-model");
      assert.deepEqual(resumeResult.snapshot.pendingApprovals, []);
      console.log("step4a RPC：session.list 可见 1 条；session.resume 快照就绪（幂等恢复）");

      // 恢复出的会话续聊：单写者循环在 resume 后照常工作
      let resolveDone!: (payload: DoneEventPayload) => void;
      const donePromise = new Promise<DoneEventPayload>((resolvePromise) => {
        resolveDone = resolvePromise;
      });
      const offDone = client.onEvent("done", (payload) => resolveDone(payload as DoneEventPayload));
      await client.call("session.send", { sessionId, input: { text: "再来一句" } });
      const done = await donePromise;
      offDone();
      assert.equal(done.outcome, "completed", "resumed 会话第二 turn 应 completed");
      const replay2 = await storage.resumeSession(sessionId);
      assert.equal(replay2.history.length, 4, "第二 turn 后历史应为 4 条");
      assert.ok(mock.requests >= 2, "mock 服务器应收到 ≥2 次请求");
      console.log("step4b RPC：resumed 会话续聊 completed，历史 4 条一致");
    } finally {
      client.close();
      await node.close();
      await transports[0].close();
      await transports[1].close();
    }
    await storage.close();
    console.log(`数据根（临时 NOVACODE_HOME）: ${home}`);
    console.log("");
    console.log("SMOKE OK");
  } finally {
    for (const [key, value] of savedEnv) {
      setEnv(key, value);
    }
    await mock.close();
  }
}

main().catch((reason: unknown) => {
  console.error("");
  console.error("SMOKE FAILED:", reason);
  process.exitCode = 1;
});
