/**
 * Web 宿主（T3.8 / 04-architecture §4.4 websocket 绑定 / 06-api-spec §6.3）：
 * HTTP(+静态工作台资源) + WS upgrade → 逐连接 WebSocketTransport + 独立绑定（鉴权门 + ws.auth）。
 *
 * - 连接级鉴权（06 §6.3 第 3 条）：每连接独立绑定以 authGate={"ws.auth"} 构造，ws.auth handler
 *   由本宿主注入（token 常数时间比较，sha256 摘要防长度泄露）；时序 = ws.auth → system.ping → 业务；
 * - 事件扇出：AgentService.attach 多次（多连接各一绑定），会话事件投递到全部活跃连接；
 * - 心跳与空闲断开（06 §6.3 第 2 条）：ws.ping 探活，pong 超时 terminate；
 * - 静态资源：可选 staticDir（apps/web 构建产物），GET/HEAD + 精确路径 + "/" → index.html，
 *   路径穿越防护；RPC 帧只走 WS，HTTP 不承载协议帧。
 * 全程仅本机回环缺省（hostname 127.0.0.1）；token 绝不落日志（04 §5.3）。
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { stat } from "node:fs/promises";
import { WebSocketServer, type WebSocket } from "ws";
import { METHOD_SCHEMAS, SYSTEM_ERROR_CODES } from "@raincode/shared";
import { RpcCallError, WebSocketTransport } from "@raincode/rpc";
import type { RpcServiceBinding, WsSocketLike } from "@raincode/rpc";
import type { AgentServiceNode } from "./node.js";

export interface WebHostOptions {
  /** 未绑定 transport 的服务节点（createAgentServiceNode(undefined, …)）；连接期逐 service.attach。 */
  node: AgentServiceNode;
  /** 监听端口；缺省 8787，0 = 临时端口（测试）。 */
  port?: number;
  /** 监听地址；缺省 127.0.0.1（本机回环，跨网络暴露属调用方显式决策）。 */
  hostname?: string;
  /** ws.auth 令牌（--token / RAINCODE_WEB_TOKEN / 自动生成，解析归端层 CLI）。 */
  token: string;
  /** 静态工作台资源目录（apps/web 构建产物）；缺省不启用（纯 WS API）。 */
  staticDir?: string;
  /** delta 批量窗口毫秒（缺省 50；06 §6.3 第 5 条可经 RAINCODE_WS_DELTA_WINDOW_MS 调大，CLI 装配读取）。 */
  deltaWindowMs?: number;
  /** ws.ping 探活间隔毫秒（缺省 30000；0 = 关闭心跳。连续 2 周期未 pong 判定空闲断开）。 */
  heartbeatIntervalMs?: number;
  onDiagnostic?: (message: string, err?: unknown) => void;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json",
  ".woff2": "font/woff2",
};

export class WebHost {
  private readonly diag: (message: string, err?: unknown) => void;
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private readonly connections = new Map<WebSocket, { binding: RpcServiceBinding; transport: WebSocketTransport; heartbeat?: NodeJS.Timeout }>();
  private started = false;

  constructor(private readonly options: WebHostOptions) {
    this.diag = options.onDiagnostic ?? ((message, err) => console.error(`[raincode/web] ${message}`, err ?? ""));
    this.http = createServer((req, res) => void this.serveStatic(req, res));
    this.wss = new WebSocketServer({ noServer: true });
    this.http.on("upgrade", (req, socket, head) => {
      // 任意路径均受理 upgrade（路径不承载语义；RPC 方法在帧内），非 WS upgrade 由 wss 拒绝
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
    });
  }

  get port(): number {
    const addr = this.http.address();
    return typeof addr === "object" && addr !== null ? addr.port : 0;
  }

  get url(): string {
    return `ws://${this.options.hostname ?? "127.0.0.1"}:${this.port}`;
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  async start(): Promise<void> {
    if (this.started) return;
    await new Promise<void>((resolvePromise, reject) => {
      this.http.once("error", reject);
      this.http.listen(this.options.port ?? 8787, this.options.hostname ?? "127.0.0.1", () => resolvePromise());
    });
    this.started = true;
    this.diag(`listening: ${this.url}（ws.auth 鉴权；token 经 --token / RAINCODE_WEB_TOKEN 提供）`);
  }

  /** 优雅停止：关闭全部连接（1001 going away）→ 停受理 → HTTP 关闭；节点生命周期归持有方。 */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    for (const [ws, conn] of Array.from(this.connections)) {
      this.teardown(ws, conn);
      ws.close(1001, "web host stopping");
    }
    await new Promise<void>((resolvePromise) => this.wss.close(() => resolvePromise()));
    await new Promise<void>((resolvePromise, reject) => {
      this.http.close((err) => (err === undefined ? resolvePromise() : reject(err)));
    });
  }

  // ---------------------------------------------------------------------------

  private onConnection(ws: WebSocket): void {
    // 逐连接绑定：authGate 开门 + ws.auth handler 注入方法表（schema 真源 METHOD_SCHEMAS）
    const transport = new WebSocketTransport({
      socket: ws as unknown as WsSocketLike,
      deltaWindowMs: this.options.deltaWindowMs,
      onSocketClose: () => {
        const existing = this.connections.get(ws);
        if (existing) this.teardown(ws, existing);
      },
    });
    const binding = this.options.node.service.attach(transport, { authGate: { method: "ws.auth" } });
    const wsAuth = METHOD_SCHEMAS["ws.auth"];
    if (wsAuth) {
      binding.methods["ws.auth"] = {
        schema: wsAuth.request,
        handler: async (params: unknown) => {
          const token = (params as { token: string }).token;
          if (!tokenMatches(token, this.options.token)) {
            throw new RpcCallError(SYSTEM_ERROR_CODES.UNAUTHORIZED, "invalid web auth token");
          }
          return { ok: true as const };
        },
      };
    }
    const entry = { binding, transport, heartbeat: this.startHeartbeat(ws) };
    this.connections.set(ws, entry);
    this.diag(`client connected（${this.connections.size} active）`);
  }

  /** 心跳探活（06 §6.3 第 2 条）：周期 ping；下一周期 pong 未复位 alive 即 terminate 空闲连接。0 间隔 = 关闭。 */
  private startHeartbeat(ws: WebSocket): NodeJS.Timeout | undefined {
    const intervalMs = this.options.heartbeatIntervalMs ?? 30_000;
    if (intervalMs <= 0) return undefined;
    let alive = true;
    ws.on("pong", () => {
      alive = true;
    });
    return setInterval(() => {
      if (!alive) {
        this.diag("heartbeat timeout, terminating idle connection");
        ws.terminate();
        return;
      }
      alive = false;
      try {
        ws.ping();
      } catch (err) {
        this.diag("heartbeat ping failed", err);
      }
    }, intervalMs);
  }

  private teardown(ws: WebSocket, entry: { binding: RpcServiceBinding; transport: WebSocketTransport; heartbeat?: NodeJS.Timeout }): void {
    if (entry.heartbeat !== undefined) clearInterval(entry.heartbeat);
    this.options.node.service.detach(entry.binding);
    this.connections.delete(ws);
    this.diag(`client disconnected（${this.connections.size} active）`);
  }

  /** 静态工作台资源（未启用 staticDir → 421 提示纯 WS 端点）。 */
  private async serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const dir = this.options.staticDir;
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }
    if (dir === undefined) {
      res.writeHead(421, { "Content-Type": "text/plain; charset=utf-8" }).end(
        "this endpoint serves websocket RPC only (ws.auth → system.ping)",
      );
      return;
    }
    const urlPath = (req.url ?? "/").split("?")[0] ?? "/";
    const relative = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath).replace(/^\/+/, "");
    const absolute = resolve(dir, relative);
    if (absolute !== resolve(dir) && !absolute.startsWith(resolve(dir) + sep)) {
      res.writeHead(403).end(); // 路径穿越防护
      return;
    }
    try {
      const info = await stat(absolute);
      if (!info.isFile()) throw new Error("not a file");
      res.writeHead(200, {
        "Content-Type": CONTENT_TYPES[extname(absolute).toLowerCase()] ?? "application/octet-stream",
        "Content-Length": info.size,
      });
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      const stream = createReadStream(absolute);
      stream.on("error", () => res.destroy());
      stream.pipe(res);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("not found");
    }
  }
}

/** token 常数时间比较：双侧 sha256 摘要定长后 timingSafeEqual（长度差异不泄露）。 */
function tokenMatches(candidate: string, expected: string): boolean {
  const a = createHash("sha256").update(candidate, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}
