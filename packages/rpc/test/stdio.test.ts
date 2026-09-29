/**
 * StdioTransport 单测（T2.8）：JSONL 分帧 / 畸形行 PARSE_ERROR / delta 批量窗口合并与
 * 边界 flush / onInputEnd 半开语义 / close flush。全部以内存流驱动（06 §1.3 帧编码契约）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { StdioTransport } from "../src/stdio.js";
import type { RpcFrame } from "../src/transport.js";

interface Harness {
  transport: StdioTransport;
  input: PassThrough;
  /** 已到达的输出帧（按行 JSON 反序列化，顺序保持）。 */
  frames: RpcFrame[];
  raw: string[];
  waitForFrames(count: number, timeoutMs?: number): Promise<RpcFrame[]>;
  end(): void;
}

function deltaPayload(overrides: {
  seq: number;
  turnId?: string;
  round?: number;
  text?: string;
  argsPartial?: string;
  index?: number;
  toolCallId?: string;
  toolName?: string;
  type?: "text" | "tool_call";
}): Record<string, unknown> {
  const type = overrides.type ?? "text";
  return {
    seq: overrides.seq,
    ts: 1_700_000_000_000 + overrides.seq,
    sessionId: "s_test",
    turnId: overrides.turnId ?? "t1",
    round: overrides.round ?? 0,
    delta:
      type === "tool_call"
        ? {
            type,
            index: overrides.index ?? 0,
            ...(overrides.toolCallId !== undefined && { toolCallId: overrides.toolCallId }),
            ...(overrides.toolName !== undefined && { toolName: overrides.toolName }),
            ...(overrides.argsPartial !== undefined && { argsPartial: overrides.argsPartial }),
          }
        : { type, text: overrides.text ?? "" },
  };
}

function deltaFrame(seq: number, overrides: Parameters<typeof deltaPayload>[0] = { seq }): RpcFrame {
  return { kind: "event", name: "message.delta", payload: deltaPayload({ seq, ...overrides }) } as RpcFrame;
}

function createHarness(options: { deltaWindowMs?: number; onInputEnd?: () => void } = {}): Harness {
  const input = new PassThrough();
  const output = new PassThrough();
  const transport = new StdioTransport({
    input,
    output,
    ...(options.deltaWindowMs !== undefined && { deltaWindowMs: options.deltaWindowMs }),
    ...(options.onInputEnd !== undefined && { onInputEnd: options.onInputEnd }),
  });
  const frames: RpcFrame[] = [];
  const raw: string[] = [];
  let buffer = "";
  output.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let idx = buffer.indexOf("\n");
    while (idx !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line.length > 0) {
        raw.push(line);
        frames.push(JSON.parse(line) as RpcFrame);
      }
      idx = buffer.indexOf("\n");
    }
  });
  return {
    transport,
    input,
    frames,
    raw,
    waitForFrames(count, timeoutMs = 2000) {
      const started = Date.now();
      return new Promise((resolve, reject) => {
        const poll = (): void => {
          if (frames.length >= count) {
            resolve(frames.slice(0, count));
            return;
          }
          if (Date.now() - started > timeoutMs) {
            reject(new Error(`timeout waiting ${count} frames, got ${String(frames.length)}`));
            return;
          }
          setTimeout(poll, 5);
        };
        poll();
      });
    },
    end() {
      input.end();
    },
  };
}

function requestLine(id: string, method: string, params: unknown = {}): string {
  return `${JSON.stringify({ kind: "request", id, method, params })}\n`;
}

test("stdio: request 帧入站解析（跨 chunk 分帧）", async () => {
  const h = createHarness();
  const received: RpcFrame[] = [];
  h.transport.onFrame((frame) => received.push(frame));
  const line = requestLine("req-1", "system.ping");
  h.input.write(line.slice(0, 10));
  await new Promise((r) => setTimeout(r, 10));
  h.input.write(line.slice(10));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(received.length, 1);
  assert.equal(received[0]!.kind, "request");
  if (received[0]!.kind === "request") {
    assert.equal(received[0]!.method, "system.ping");
    assert.equal(received[0]!.id, "req-1");
  }
  h.end();
});

test("stdio: response 帧出站为单行 JSONL（含中文字面量）", async () => {
  const h = createHarness();
  h.transport.send({ kind: "response", id: "req-1", ok: true, result: { text: "你好世界" } });
  await h.waitForFrames(1);
  assert.equal(h.frames.length, 1);
  assert.ok(h.raw[0]!.includes("你好世界"), "非 ASCII 以 UTF-8 原文落帧");
  assert.equal(h.raw[0]!.split("\n").length, 1);
  h.end();
});

test("stdio: 畸形行带 id → PARSE_ERROR response；不带 id → 丢弃不断开", async () => {
  const h = createHarness();
  const received: RpcFrame[] = [];
  h.transport.onFrame((frame) => received.push(frame));
  h.input.write(`{"kind":"request","id":"req-9","method":"session.send","params":\n`); // 结构残缺但 id 可定位
  h.input.write(`not-json-at-all {"kind":"request","id":"req-8"\n`); // JSON 解析失败但正则可定位
  h.input.write(`}{ broken\n`); // 完全不可定位 → 丢弃
  h.input.write(requestLine("req-2", "system.ping"));
  const frames = await h.waitForFrames(2);
  assert.equal(frames[0]!.kind, "response");
  if (frames[0]!.kind === "response" && !frames[0]!.ok) {
    assert.equal(frames[0]!.id, "req-9");
    assert.equal(frames[0]!.error?.code, "PARSE_ERROR");
  } else {
    assert.fail("expected PARSE_ERROR response for req-9");
  }
  // req-8：JSON 解析失败但正则可定位 id → 同样回 PARSE_ERROR（06 §1.2 可定位 id 口径）
  assert.equal(frames[1]!.kind, "response");
  if (frames[1]!.kind === "response" && !frames[1]!.ok) {
    assert.equal(frames[1]!.id, "req-8");
    assert.equal(frames[1]!.error?.code, "PARSE_ERROR");
  }
  // 不可定位行丢弃且不断开：后续正常 request 仍入站派发
  const started = Date.now();
  while (received.length === 0 && Date.now() - started < 1000) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(received.length, 1);
  if (received[0]!.kind === "request") assert.equal(received[0]!.id, "req-2");
  assert.equal(h.transport.isClosed, false);
  assert.equal(h.frames.length, 2, "不可定位行不产生出站帧");
  h.end();
});

test("stdio: delta 批量窗口合并（text 拼接 + seq/ts 取最新）", async () => {
  const h = createHarness({ deltaWindowMs: 30 });
  h.transport.send(deltaFrame(1, { seq: 1, text: "Hel" }));
  h.transport.send(deltaFrame(2, { seq: 2, text: "lo" }));
  assert.equal(h.frames.length, 0, "窗口内不落帧");
  const frames = await h.waitForFrames(1);
  assert.equal(frames.length, 1);
  const payload = (frames[0] as { payload: { delta: { text: string }; seq: number } }).payload;
  assert.equal(payload.delta.text, "Hello");
  assert.equal(payload.seq, 2, "合并帧取最新 seq");
  h.end();
});

test("stdio: 非 delta 帧发送前先 flush 窗口（边界事件不乱序）", async () => {
  const h = createHarness({ deltaWindowMs: 5000 }); // 长窗口：验证边界 flush 而非窗口到期
  h.transport.send(deltaFrame(1, { seq: 1, text: "par" }));
  h.transport.send({ kind: "response", id: "req-1", ok: true, result: { ok: true } });
  const frames = await h.waitForFrames(2);
  assert.equal(frames[0]!.kind, "event", "delta 先于边界帧投递");
  assert.equal(frames[1]!.kind, "response");
  h.end();
});

test("stdio: 跨 turn / 跨类型 delta 不合并且保序", async () => {
  const h = createHarness({ deltaWindowMs: 30 });
  h.transport.send(deltaFrame(1, { seq: 1, turnId: "t1", text: "a" }));
  h.transport.send(deltaFrame(2, { seq: 2, turnId: "t2", text: "b" }));
  h.transport.send(deltaFrame(3, { seq: 3, type: "tool_call", index: 0, argsPartial: "{" }));
  const frames = await h.waitForFrames(3);
  assert.equal(frames.length, 3);
  h.end();
});

test("stdio: tool_call argsPartial 拼接 + toolCallId/toolName 取最新非空", async () => {
  const h = createHarness({ deltaWindowMs: 30 });
  h.transport.send(deltaFrame(1, { seq: 1, type: "tool_call", index: 0, toolCallId: "c1", toolName: "read_file", argsPartial: `{"path` }));
  h.transport.send(deltaFrame(2, { seq: 2, type: "tool_call", index: 0, argsPartial: `":"a.ts"}` }));
  const frames = await h.waitForFrames(1);
  const delta = (frames[0] as { payload: { delta: { type: string; argsPartial: string; toolCallId?: string; toolName?: string } } }).payload.delta;
  assert.equal(delta.type, "tool_call");
  assert.equal(delta.argsPartial, `{"path":"a.ts"}`);
  assert.equal(delta.toolCallId, "c1");
  assert.equal(delta.toolName, "read_file");
  h.end();
});

test("stdio: close flush 未决 delta 并 end 输出", async () => {
  const h = createHarness({ deltaWindowMs: 60_000 });
  h.transport.send(deltaFrame(1, { seq: 1, text: "tail" }));
  await h.transport.close();
  assert.equal(h.frames.length, 1);
  const payload = (h.frames[0] as { payload: { delta: { text: string } } }).payload;
  assert.equal(payload.delta.text, "tail");
  assert.equal(h.transport.isClosed, true);
  assert.throws(() => h.transport.send(deltaFrame(2, { seq: 2, text: "x" })), /TRANSPORT_CLOSED/);
});

test("stdio: stdin end 触发 onInputEnd，transport 在 close 前保持可写（在途响应 flush）", async () => {
  let ended = false;
  const h = createHarness({ onInputEnd: () => {
    ended = true;
  } });
  h.end();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ended, true);
  assert.equal(h.transport.isClosed, false, "end 不自动关闭（持有方决定 flush 时机）");
  h.transport.send({ kind: "response", id: "req-last", ok: true, result: null });
  await h.waitForFrames(1);
  assert.equal(h.frames[0] && h.frames[0].kind === "response" ? h.frames[0].id : "", "req-last");
  await h.transport.close();
  assert.equal(h.transport.isClosed, true);
});
