/**
 * MCP stdio 测试 server（smoke-mcp 验收 fixture；手写 JSON-RPC 2.0 换行帧，node 直跑无依赖）。
 * 工具：echo（回显 text）· crash（回响应后自杀进程，驱动 client 侧 M4 重连链路）。
 * 用法：node mcp-fixture-stdio.mjs [serverName]
 */
import readline from "node:readline";

const serverName = process.argv[2] ?? "stdio-fixture";
const serverInfo = { name: serverName, version: "0.1.0" };
const tools = [
  {
    name: "echo",
    description: "Echo the given text back (smoke fixture)",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    name: "crash",
    description: "Exit the server process after replying (drives reconnection)",
    inputSchema: { type: "object", properties: {} },
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(id, method, params) {
  switch (method) {
    case "initialize":
      send({
        jsonrpc: "2.0", id,
        result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo },
      });
      break;
    case "tools/list":
      send({ jsonrpc: "2.0", id, result: { tools } });
      break;
    case "tools/call": {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (name === "echo") {
        send({
          jsonrpc: "2.0", id,
          result: { content: [{ type: "text", text: `echo(${serverName}): ${String(args.text ?? "")}` }], isError: false },
        });
      } else if (name === "crash") {
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "crashing" }], isError: false } });
        setTimeout(() => process.exit(0), 30); // 响应落盘后再退出
      } else {
        send({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool: ${String(name)}` } });
      }
      break;
    }
    case "ping":
      send({ jsonrpc: "2.0", id, result: {} });
      break;
    default:
      if (id !== undefined) {
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${String(method)}` } });
      }
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return; // 脏帧丢弃并计数（02 §3.4；smoke 不断言计数）
  }
  if (message.id !== undefined && message.id !== null) {
    handle(message.id, message.method, message.params);
  }
  // 通知（notifications/initialized 等）：忽略
});
