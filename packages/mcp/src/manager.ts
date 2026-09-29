/**
 * McpManager：每 serverKey 一条连接，状态机独立（02-module-design §3.2，迁移表 M1~M8）。
 *
 * - 协议交互复用官方 SDK（@modelcontextprotocol/sdk Client）；transport 按配置选择
 *   stdio（子进程）/ http（Streamable HTTP）/ sse（兼容旧版）；
 * - 失败隔离：单 server 的故障只影响其命名空间工具（available=false），不影响其他 server
 *   与内置工具；callTool 单调用超时（默认 60s）不杀连接，连续 3 次超时触发重连；
 * - 重连退避 1s/2s/4s/8s/16s（M4），耗尽 5 次 → Failed（M6）；手动 retry 走 M7。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerConfig, McpServerStatus, McpToolDescriptor } from "@raincode/shared";
import { McpConfigError, validateServerKey } from "./config.js";
import type { McpServerConfigLevel } from "./config.js";
const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000]; // M4 退避序列
const DEFAULT_CALL_TIMEOUT_MS = 60000;
const MAX_CONSECUTIVE_TIMEOUTS = 3; // 连续超时触发重连（02 §3.4）

export class McpError extends Error {
  constructor(
    public readonly code: "MCP_SERVER_NOT_FOUND" | "MCP_TOOL_UNKNOWN" | "MCP_UNAVAILABLE" | "MCP_CALL_FAILED",
    message: string,
  ) {
    super(message);
  }
}

export interface McpStatusSnapshot {
  serverKey: string;
  transport: McpServerConfig["transport"];
  status: McpServerStatus;
  enabled: boolean;
  toolCount: number;
  availableTools: number;
  lastError?: string;
}

type StatusListener = (snapshot: McpStatusSnapshot) => void;

interface Connection {
  config: McpServerConfigLevel;
  state: McpServerStatus;
  client: Client | null;
  tools: Map<string, McpToolDescriptor>; // 原始 toolName → 描述符（state=Failed 时 available=false）
  lastError?: string;
  retries: number;
  consecutiveTimeouts: number;
  reconnectTimer: NodeJS.Timeout | null;
  /** 手动 disconnect 置位：onclose 不进入 Reconnecting（M8）。 */
  intentionalClose: boolean;
}

export interface McpManagerOptions {
  clientName?: string;
  clientVersion?: string;
  onDiagnostic?: (message: string, err?: unknown) => void;
}

export class McpManager {
  private readonly connections = new Map<string, Connection>();
  private readonly listeners = new Set<StatusListener>();
  private readonly diag: (message: string, err?: unknown) => void;

  constructor(private readonly options: McpManagerOptions = {}) {
    this.diag = options.onDiagnostic ?? ((message, err) => console.error(`[raincode/mcp] ${message}`, err ?? ""));
  }

  /** 注册配置并进入状态机（不做 IO；连接由 connect/restoreAll 驱动）。 */
  register(config: McpServerConfigLevel): void {
    validateServerKey(config.serverKey);
    if (this.connections.has(config.serverKey)) {
      throw new McpConfigError("MCP_SERVER_CONFLICT", `serverKey already registered: ${config.serverKey}`);
    }
    this.connections.set(config.serverKey, {
      config,
      state: "Disconnected",
      client: null,
      tools: new Map(),
      retries: 0,
      consecutiveTimeouts: 0,
      reconnectTimer: null,
      intentionalClose: false,
    });
  }

  has(serverKey: string): boolean {
    return this.connections.has(serverKey);
  }

  /** 注销配置（mcp.servers.remove；调用前须先 disconnect）。 */
  remove(serverKey: string): void {
    this.connections.delete(serverKey);
  }

  configOf(serverKey: string): McpServerConfigLevel | undefined {
    return this.connections.get(serverKey)?.config;
  }

  keys(): string[] {
    return [...this.connections.keys()];
  }

  onStatusChange(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** M1：Disconnected/Failed → Connecting（异步握手；结果经事件通知）。 */
  async connect(serverKey: string): Promise<void> {
    const connection = this.require(serverKey);
    if (connection.state === "Connected" || connection.state === "Connecting" || connection.state === "Reconnecting") {
      return; // 幂等：已连接/在建中直接受理
    }
    await this.establish(connection, serverKey);
  }

  /** M7：Failed → Connecting（与 connect 同路径；状态机语义入口区分）。 */
  async retry(serverKey: string): Promise<void> {
    const connection = this.require(serverKey);
    if (connection.state !== "Failed" && connection.state !== "Disconnected") {
      return;
    }
    connection.retries = 0;
    await this.establish(connection, serverKey);
  }

  /** M8：→ Disconnected（close 子进程/连接；onclose 经 intentionalClose 抑制重连）。 */
  async disconnect(serverKey: string): Promise<void> {
    const connection = this.connections.get(serverKey);
    if (!connection) {
      throw new McpError("MCP_SERVER_NOT_FOUND", `mcp server not found: ${serverKey}`);
    }
    if (connection.reconnectTimer !== null) {
      clearTimeout(connection.reconnectTimer);
      connection.reconnectTimer = null;
    }
    connection.intentionalClose = true;
    const client = connection.client;
    connection.client = null;
    connection.state = "Disconnected";
    connection.retries = 0;
    connection.lastError = undefined;
    if (client !== null) {
      try {
        await client.close();
      } catch (err: unknown) {
        this.diag(`disconnect close failed for ${serverKey}`, err);
      }
    }
    this.emit(serverKey);
  }

  /** 优雅停机：断开全部连接（进程树由 transport close 收敛）。 */
  async closeAll(): Promise<void> {
    await Promise.all([...this.connections.keys()].map((key) => this.disconnect(key).catch(() => undefined)));
  }

  // 工具面 ------------------------------------------------------------------

  /** 命名空间工具投影（Failed 时 available=false —— M6 标记）。 */
  toolsOf(serverKey: string): McpToolDescriptor[] {
    const connection = this.require(serverKey);
    const available = connection.state === "Connected";
    return [...connection.tools.values()].map((descriptor) => ({ ...descriptor, available }));
  }

  /** M2/M5：握手成功后拉取工具清单并缓存；瞬时网络错误重试 2 次（Connected 事件先于工具清单到达的竞态兜底）。 */
  async refreshTools(serverKey: string): Promise<McpToolDescriptor[]> {
    const connection = this.require(serverKey);
    if (connection.client === null) {
      throw new McpError("MCP_UNAVAILABLE", `mcp server not connected: ${serverKey}`);
    }
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const result = await connection.client.listTools();
        connection.tools = new Map(
          result.tools.map((tool) => [
            tool.name,
            {
              name: tool.name,
              serverKey,
              ...(typeof tool.description === "string" && tool.description.length > 0
                ? { description: tool.description }
                : {}),
              inputSchema: tool.inputSchema,
              available: true,
            },
          ]),
        );
        return this.toolsOf(serverKey);
      } catch (err: unknown) {
        lastErr = err;
        if (connection.client === null || connection.state !== "Connected") {
          break; // 连接已丢失：交由重连链路处理
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
    throw lastErr instanceof Error ? lastErr : new McpError("MCP_CALL_FAILED", String(lastErr));
  }

  /** 单调用执行（06 §2.5 mcp.tools.call / 适配 Tool.execute 共用）。超时不杀连接。 */
  async callTool(
    serverKey: string,
    toolName: string,
    args: unknown,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<CallToolResult> {
    const connection = this.require(serverKey);
    if (connection.state !== "Connected" || connection.client === null) {
      throw new McpError("MCP_UNAVAILABLE", `mcp server unavailable: ${serverKey} (${connection.state})`);
    }
    if (!connection.tools.has(toolName)) {
      throw new McpError("MCP_TOOL_UNKNOWN", `tool "${toolName}" not found on server "${serverKey}"`);
    }
    const timeout = timeoutMs ?? connection.config.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    try {
      const result = (await connection.client.callTool(
        { name: toolName, arguments: (args ?? {}) as Record<string, unknown> },
        undefined,
        { timeout, ...(signal !== undefined && { signal }) },
      )) as CallToolResult;
      connection.consecutiveTimeouts = 0;
      return result;
    } catch (err: unknown) {
      if (isTimeoutError(err)) {
        connection.consecutiveTimeouts += 1;
        if (connection.consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS && connection.state === "Connected") {
          this.diag(`server ${serverKey}: ${String(MAX_CONSECUTIVE_TIMEOUTS)} consecutive timeouts, reconnecting`);
          connection.intentionalClose = false;
          void connection.client?.close(); // 触发 onclose → M4 重连链路
        }
      }
      throw err instanceof Error ? err : new McpError("MCP_CALL_FAILED", String(err));
    }
  }

  status(): McpStatusSnapshot[] {
    return [...this.connections.entries()].map(([serverKey, connection]) => ({
      serverKey,
      transport: connection.config.transport,
      status: connection.state,
      enabled: connection.config.enabled,
      toolCount: connection.tools.size,
      availableTools: connection.state === "Connected" ? connection.tools.size : 0,
      ...(connection.lastError !== undefined && { lastError: connection.lastError }),
    }));
  }

  // 状态机内部（M1~M8）-------------------------------------------------------

  /** M1/M7 公共建立路径： Connecting → [Connected | Failed]；stdio onclose → M4 重连链路。 */
  private async establish(connection: Connection, serverKey: string): Promise<void> {
    if (connection.reconnectTimer !== null) {
      clearTimeout(connection.reconnectTimer);
      connection.reconnectTimer = null;
    }
    connection.intentionalClose = false;
    this.setState(connection, serverKey, "Connecting");
    const client = new Client(
      { name: this.options.clientName ?? "raincode", version: this.options.clientVersion ?? "0.1.0" },
      { capabilities: {} },
    );
    try {
      const transport = this.createTransport(connection.config);
      await client.connect(transport);
    } catch (err: unknown) {
      connection.client = null;
      connection.lastError = err instanceof Error ? err.message : String(err);
      connection.state = "Failed"; // M3：握手失败/超时（其余 server 不受影响）
      this.emit(serverKey);
      this.diag(`server ${serverKey} handshake failed: ${connection.lastError}`);
      return;
    }
    connection.client = client;
    connection.state = "Connected"; // M2：initialize 成功
    connection.retries = 0;
    connection.consecutiveTimeouts = 0;
    connection.lastError = undefined;
    connection.intentionalClose = false;
    client.onclose = () => this.onConnectionLost(connection, serverKey);
    client.onerror = (err: unknown) => this.diag(`server ${serverKey} protocol error`, err);
    this.emit(serverKey);
    // 工具清单失败不回退连接状态：连接可用但工具面为空（下次 status change 再刷新）
    await this.refreshTools(serverKey).catch((err: unknown) =>
      this.diag(`server ${serverKey} listTools failed`, err),
    );
    this.emit(serverKey); // toolCount 刷新
  }

  /** M4/M6：连接丢失 → Reconnecting（指数退避）→ 耗尽 → Failed。 */
  private onConnectionLost(connection: Connection, serverKey: string): void {
    connection.client = null;
    if (connection.intentionalClose) {
      connection.state = "Disconnected";
      this.emit(serverKey);
      return;
    }
    if (connection.state === "Reconnecting" || connection.state === "Failed" || connection.state === "Disconnected") {
      return; // 重连链路已在途 / 尚未连接成功过（握手失败不重连）
    }
    connection.state = "Reconnecting"; // M4
    this.emit(serverKey);
    this.scheduleReconnect(connection, serverKey);
  }

  private scheduleReconnect(connection: Connection, serverKey: string): void {
    const attempts = connection.retries;
    if (attempts >= BACKOFF_MS.length) {
      connection.state = "Failed"; // M6：退避耗尽
      connection.lastError = `reconnect retries exhausted (${String(BACKOFF_MS.length)})`;
      this.emit(serverKey);
      return;
    }
    connection.retries += 1;
    connection.reconnectTimer = setTimeout(() => {
      connection.reconnectTimer = null;
      void this.establish(connection, serverKey).then(() => {
        if (connection.state !== "Connected" && connection.state !== "Reconnecting") {
          this.scheduleReconnect(connection, serverKey); // M5 失败继续退避
        }
      });
    }, BACKOFF_MS[attempts]);
  }

  private setState(connection: Connection, serverKey: string, state: McpServerStatus): void {
    connection.state = state;
    this.emit(serverKey);
  }

  private emit(serverKey: string): void {
    const snapshot = this.status().find((entry) => entry.serverKey === serverKey);
    if (snapshot === undefined) {
      return;
    }
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (err: unknown) {
        this.diag("status listener threw", err);
      }
    }
  }

  private require(serverKey: string): Connection {
    const connection = this.connections.get(serverKey);
    if (!connection) {
      throw new McpError("MCP_SERVER_NOT_FOUND", `mcp server not found: ${serverKey}`);
    }
    return connection;
  }

  private createTransport(config: McpServerConfigLevel): Transport {
    if (config.transport === "stdio") {
      return new StdioClientTransport({
        command: config.command!,
        ...(config.args !== undefined && { args: config.args }),
        // 继承环境经密钥过滤（02 §3.4 SECRET_ENV_FILTER），用户显式 env 覆盖
        env: sanitizedEnvironment(config.env),
        ...(config.cwd !== undefined && { cwd: config.cwd }),
        stderr: "pipe",
      });
    }
    const url = new URL(config.url!);
    const headers = config.headers;
    if (config.transport === "http") {
      return new StreamableHTTPClientTransport(url, {
        ...(headers !== undefined && { requestInit: { headers } }),
      });
    }
    return new SSEClientTransport(url, {
      ...(headers !== undefined && {
        requestInit: { headers },
        eventSourceInit: { fetch: (input, init) => fetch(input, { ...init, headers }) },
      }),
    });
  }
}

/** 继承环境白名单过滤：剔除密钥类变量（KEY/TOKEN/SECRET/PASSWORD），用户显式 env 覆盖。 */
function sanitizedEnvironment(userEnv: Record<string, string> | undefined): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/KEY|TOKEN|SECRET|PASSWORD/i.test(key)) continue;
    base[key] = value;
  }
  return { ...base, ...userEnv };
}

function isTimeoutError(err: unknown): boolean {
  if (err instanceof Error) {
    return err.name === "McpError" && /timed out|timeout/i.test(err.message);
  }
  return false;
}
