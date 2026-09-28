/**
 * MCP Streamable HTTP 测试 server（smoke-mcp 验收 fixture；手写最小协议子集，node 直跑无依赖）。
 * 只实现 SDK StreamableHTTPClientTransport 需要的路径：POST /mcp（单 JSON 响应）、
 * GET /mcp → 405（无 server 通知流，client 容忍）、DELETE /mcp → 200。
 * 工具：echo（回显 text）。用法：node mcp-fixture-http.mjs <port>
 */
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 0);
const serverInfo = { name: "http-fixture", version: "0.1.0" };
const tools = [
  {
    name: "echo",
    description: "Echo the given text back (smoke fixture)",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
];

function result(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function handle(body) {
  const { id, method, params } = body;
  switch (method) {
    case "initialize":
      return result(id, { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo });
    case "tools/list":
      return result(id, { tools });
    case "tools/call":
      return result(id, {
        content: [{ type: "text", text: `echo(http-fixture): ${String(params?.arguments?.text ?? "")}` }],
        isError: false,
      });
    case "ping":
      return result(id, {});
    default:
      if (id !== undefined && id !== null) {
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${String(method)}` } };
      }
      return null; // 通知：204
  }
}

const server = createServer((req, res) => {
  if (req.method === "DELETE") {
    res.writeHead(200).end();
    return;
  }
  if (req.method === "GET") {
    res.writeHead(405).end(); // 不提供 server 通知 SSE 流（client 容忍）
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      res.writeHead(400).end();
      return;
    }
    process.stderr.write(`[fixture] ${req.method} ${body?.method ?? ""} id=${String(body?.id)}\n`);
    const reply = handle(body);
    if (reply === null) {
      res.writeHead(202).end();
      return;
    }
    res.writeHead(200, {
      "content-type": "application/json",
      "mcp-session-id": "smoke-http-session", // initialize 后 client 依此回传
    });
    res.end(JSON.stringify(reply));
  });
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const actual = typeof address === "object" && address !== null ? address.port : port;
  process.stdout.write(`${JSON.stringify({ ready: true, port: actual })}\n`);
});
