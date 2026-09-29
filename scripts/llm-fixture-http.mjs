/**
 * OpenAI 兼容流式 LLM 测试 server（GUI 走查 / 端到端联调 fixture；node 直跑无依赖）。
 *
 * 脚本化行为（按请求 messages 尾条消息自动分流，无需配置）：
 * - 尾条 role=tool（工具结果已回）→ 流式输出文本 `fixture-final: <工具输出尾部片段>`，finish=stop；
 * - 其余（首轮）→ 流式输出一个 tool_call：bash `echo raincode-gui-fixture`，finish=tool_calls。
 *
 * 用法：node llm-fixture-http.mjs <port>（缺省 8391）；GET /health 供就绪探测。
 */
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 8391);
const model = "fixture-model";

function sseChunk(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function streamCompletion(res, body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const last = messages[messages.length - 1] ?? {};
  const toolCameBack = last.role === "tool";
  // 脚本化命令：最后一条用户消息若带 "run:" 前缀行，则取其后内容作为 bash 命令
  // （默认 echo，只读白名单自动放行；用 run: 触发需审批的写命令走审批弹窗链路）
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const userText = typeof lastUser?.content === "string" ? lastUser.content : "";
  const runLine = userText.split("\n").find((l) => l.startsWith("run:"));
  const TOOL_COMMAND = runLine !== undefined ? runLine.slice(4).trim() : "echo raincode-gui-fixture";
  const id = `chatcmpl-fixture-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  const base = { id, object: "chat.completion.chunk", created, model };
  // role 帧
  sseChunk(res, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });

  if (toolCameBack) {
    const toolText = typeof last.content === "string" ? last.content : "";
    const tail = toolText.split("\n").filter(Boolean).slice(-3).join(" | ").slice(0, 200);
    const text = `fixture-final: 工具已执行（GUI fixture）。输出尾部：${tail}`;
    sseChunk(res, { ...base, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
    sseChunk(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  } else {
    const args = JSON.stringify({ command: TOOL_COMMAND });
    sseChunk(res, {
      ...base,
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 0, id: `call_fixture_${created}`, type: "function", function: { name: "bash", arguments: "" } }] },
        finish_reason: null,
      }],
    });
    // 参数分两帧下发（客户端按 index 累积拼接）
    sseChunk(res, {
      ...base,
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(0, Math.ceil(args.length / 2)) } }] },
        finish_reason: null,
      }],
    });
    sseChunk(res, {
      ...base,
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(Math.ceil(args.length / 2)) } }] },
        finish_reason: null,
      }],
    });
    sseChunk(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
  }

  sseChunk(res, {
    ...base,
    choices: [],
    usage: { prompt_tokens: 21, completion_tokens: 13, total_tokens: 34 },
  });
  res.write("data: [DONE]\n\n");
  res.end();
}

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  if (req.method === "POST" && (req.url === "/v1/chat/completions" || req.url === "/chat/completions")) {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        streamCompletion(res, JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "bad request body" } }));
      }
    });
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: `not found: ${req.method} ${req.url}` } }));
});

server.listen(port, "127.0.0.1", () => {
  console.log(`llm-fixture-http listening on http://127.0.0.1:${String(port)}/v1`);
});
