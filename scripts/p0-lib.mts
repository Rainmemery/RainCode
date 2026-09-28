/**
 * smoke-p0 共享库：脚本化 mock OpenAI SSE 服务器（含请求体捕获与响应延迟）+ turn harness +
 * P0 方法/事件注册表对照工具。仅供 scripts/smoke-p0.mts 使用。
 */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { EVENT_SCHEMAS, METHOD_SCHEMAS } from "../packages/shared/src/index.ts";
import type {
  DoneEventPayload,
  PermissionRequestedPayload,
  ToolCallCompletedEventPayload,
} from "../packages/shared/src/index.ts";
import type { RpcClient } from "../packages/rpc/src/index.ts";

// ---------------------------------------------------------------------------
// 07-dev-plan §2.1 M1 权威清单：22 个 P0 方法 + 12 个 P0 事件
// ---------------------------------------------------------------------------

export const P0_METHODS: readonly string[] = [
  // system 3
  "system.ping",
  "system.version",
  "system.shutdown",
  // session 8（除 compact）
  "session.create",
  "session.list",
  "session.resume",
  "session.send",
  "session.steer",
  "session.cancel",
  "session.archive",
  "session.setMode",
  // permission 2
  "permission.respond",
  "permission.decisions.list",
  // config 5
  "config.get",
  "config.set",
  "config.providers.list",
  "config.providers.add",
  "config.providers.remove",
  // tool 4
  "tool.tools.list",
  "tool.background.list",
  "tool.background.kill",
  "tool.background.output",
];

export const P0_EVENTS: readonly string[] = [
  // A. 消息与 turn 生命周期（6）
  "message.delta",
  "message.completed",
  "turn.phase_changed",
  "done",
  "error",
  "session.snapshot",
  // B. 工具与权限（5）
  "tool_call.started",
  "tool_call.progress",
  "tool_call.completed",
  "permission.requested",
  "permission.resolved",
  // 第 12 个：session.created（05-database JSONL 头行同名事件）
  "session.created",
];

/** 断言 METHOD_SCHEMAS ⊇ 22 方法、EVENT_SCHEMAS ⊇ 12 事件，并打印对照表。 */
export function assertRegistryCoverage(): void {
  console.log("—— P0 方法对照（07 §2.1 清单 vs METHOD_SCHEMAS）——");
  for (const method of P0_METHODS) {
    const entry = METHOD_SCHEMAS[method];
    assert.ok(entry, `METHOD_SCHEMAS 缺失 P0 方法: ${method}`);
    assert.ok(entry.request && entry.response, `P0 方法 schema 不完整: ${method}`);
    console.log(`  [方法] ${method.padEnd(28)} registered`);
  }
  console.log("—— P0 事件对照（07 §2.1 清单 vs EVENT_SCHEMAS）——");
  for (const event of P0_EVENTS) {
    assert.ok(EVENT_SCHEMAS[event], `EVENT_SCHEMAS 缺失 P0 事件: ${event}`);
    console.log(`  [事件] ${event.padEnd(28)} registered`);
  }
  const extras = Object.keys(METHOD_SCHEMAS).filter((m) => !P0_METHODS.includes(m));
  console.log(`方法注册表共 ${String(Object.keys(METHOD_SCHEMAS).length)} 项（P0 22 + 额外: ${extras.join(", ") || "无"}）`);
  console.log(`事件注册表共 ${String(Object.keys(EVENT_SCHEMAS).length)} 项（P0 12）`);
}

// ---------------------------------------------------------------------------
// mock OpenAI SSE 服务器：按脚本序号回放；捕获请求体；支持响应前延迟
// ---------------------------------------------------------------------------

export interface SseScript {
  frames: unknown[];
  finish: "stop" | "tool_calls";
  /** 响应前延迟 ms（制造「turn 运行中」窗口，steer 注入用例）。 */
  delayMs?: number;
}

export interface CapturedBody {
  messages: Array<{ role: string; content: unknown }>;
}

export interface MockLlmServer {
  port: number;
  url: string;
  /** 自 setScript 以来的请求序号（0 起始）。 */
  served: () => number;
  bodies: CapturedBody[];
  setScript: (script: SseScript[]) => void;
  close: () => Promise<void>;
}

export function textFrame(text: string): unknown {
  return { choices: [{ index: 0, delta: { content: text } }] };
}

export function toolCallFrame(id: string, name: string, args: object): unknown {
  return {
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
        },
      },
    ],
  };
}

/** 纯文本回复脚本项（含 role 首帧与 usage 尾帧）。 */
export function textScript(text: string, delayMs?: number): SseScript {
  return {
    frames: [
      { choices: [{ index: 0, delta: { role: "assistant", content: "" } }] },
      textFrame(text),
      { choices: [], usage: { prompt_tokens: 20, completion_tokens: 8 } },
    ],
    finish: "stop",
    ...(delayMs !== undefined && { delayMs }),
  };
}

/** 一次写工具调用脚本项（round 1 发起 tool_call；round 2 由调用方追加文本脚本项）。 */
export function writeCallScript(id: string, path: string, content: string): SseScript {
  return {
    frames: [
      { choices: [{ index: 0, delta: { role: "assistant", content: "" } }] },
      toolCallFrame(id, "write", { path, content }),
    ],
    finish: "tool_calls",
  };
}

export function startMockLlmServer(): Promise<MockLlmServer> {
  let script: SseScript[] = [];
  let servedSinceScript = 0;
  const bodies: CapturedBody[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const turn = script[Math.min(servedSinceScript, script.length - 1)];
      servedSinceScript += 1;
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages?: CapturedBody["messages"] };
        bodies.push({ messages: parsed.messages ?? [] });
      } catch {
        bodies.push({ messages: [] });
      }
      const respond = (): void => {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(": keep-alive\n\n");
        for (const frame of turn?.frames ?? []) {
          res.write(`data: ${JSON.stringify(frame)}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: turn?.finish ?? "stop" }] })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      };
      if (turn?.delayMs !== undefined && turn.delayMs > 0) {
        setTimeout(respond, turn.delayMs);
      } else {
        respond();
      }
    });
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolvePromise({
        port,
        url: `http://127.0.0.1:${String(port)}/v1`,
        served: () => servedSinceScript,
        bodies,
        setScript: (next: SseScript[]) => {
          script = next;
          servedSinceScript = 0;
        },
        close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// turn harness：订阅先于 send（06 §1.2 串行不阻塞），done 兜底超时
// ---------------------------------------------------------------------------

export interface TurnRun {
  sendPromise: Promise<unknown>;
  done: Promise<DoneEventPayload>;
  requested: PermissionRequestedPayload[];
  toolCompleted: ToolCallCompletedEventPayload[];
  stop: () => void;
}

export function beginTurn(client: RpcClient, sessionId: string, text: string): TurnRun {
  const requested: PermissionRequestedPayload[] = [];
  const toolCompleted: ToolCallCompletedEventPayload[] = [];
  let resolveDone!: (payload: DoneEventPayload) => void;
  let rejectDone!: (reason: unknown) => void;
  const done = new Promise<DoneEventPayload>((resolvePromise, rejectPromise) => {
    resolveDone = resolvePromise;
    rejectDone = rejectPromise;
  });
  const offRequested = client.onEvent("permission.requested", (payload) =>
    requested.push(payload as PermissionRequestedPayload));
  const offTool = client.onEvent("tool_call.completed", (payload) =>
    toolCompleted.push(payload as ToolCallCompletedEventPayload));
  const offDone = client.onEvent("done", (payload) => resolveDone(payload as DoneEventPayload));
  const sendPromise = client.call("session.send", { sessionId, input: { text } });
  sendPromise.catch((reason: unknown) => rejectDone(reason));
  return {
    sendPromise,
    done,
    requested,
    toolCompleted,
    stop: () => {
      offRequested();
      offTool();
      offDone();
    },
  };
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(`timeout: ${label}`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (reason: unknown) => {
        clearTimeout(timer);
        rejectPromise(reason);
      },
    );
  });
}

/** 轮询等待谓词成立（审批单到达等异步窗口）。 */
export async function waitFor(predicate: () => boolean, ms = 10000, label = "condition"): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timeout waiting for ${label}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}

/** 审批应答（allow）。 */
export function respondAllow(client: RpcClient, grantId: string): Promise<unknown> {
  return client.call("permission.respond", { grantId, decision: "allow" });
}
