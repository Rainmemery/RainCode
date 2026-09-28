/**
 * McpRuntime：MCP 域装配（06-api-spec §2.5；02-module-design §3）。
 *
 * - 启动时加载 global（NOVACODE_HOME/mcp.json）+ project（<workspace>/.novacode/mcp.json）
 *   两层配置（同名 serverKey 跨层冲突 → MCP_SERVER_CONFLICT），注册进 manager 并异步连接
 *   enabled server（受理即返语义，状态经 mcp.server_status_changed 全局事件）；
 * - 命名空间工具与内置工具共用 ToolRegistry（source="mcp"，mcp__<serverKey>__<toolName>）；
 *   server 状态变化时同步注册/注销（失败隔离：非 Connected 的 server 其工具不可见）；
 * - mcp.tools.call 走同一 ToolExecutor（超时/裁剪/错误映射一致，06 §2.5）。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { RpcCallError } from "@novacode/rpc";
import type { RpcServiceBinding } from "@novacode/rpc";
import {
  buildMcpServerStatusChangedEvent,
} from "@novacode/shared";
import type { McpServerConfig, McpServersAddParams, McpToolsCallParams, McpToolsListParams } from "@novacode/shared";
import { ToolExecutor } from "@novacode/tools";
import type { BackgroundTaskRegistry, ToolRegistry } from "@novacode/tools";
import { McpConfigError, McpError, McpManager, loadMcpConfig, persistMcpConfig, toMcpToolName } from "@novacode/mcp";
import type { McpConfigSource } from "@novacode/mcp";
import { createMcpTool } from "@novacode/mcp";

/** MCP 域装配依赖（agent-service 注入；server 是唯一组装点）。 */
export interface McpRuntimeOptions {
  registry: ToolRegistry;
  background: BackgroundTaskRegistry;
  executor: ToolExecutor;
  /** NOVACODE_HOME（global mcp.json 数据根）。 */
  dataRoot: string;
  /** project 级 mcp.json 所在 workspace 根（缺省 = 不加载 project 层）。 */
  workspaceRoot?: string;
  /** 全局事件出口（mcp.server_status_changed；sessionId 缺省事件）。 */
  publish: RpcServiceBinding["publish"];
}

interface RegisteredTool {
  fullName: string;
  serverKey: string;
  toolName: string;
}

export class McpRuntime {
  private readonly manager: McpManager;
  private readonly globalConfigPath: string;
  private readonly projectConfigPath: string | null;
  /** 本 runtime 已注册进 registry 的 mcp 工具（状态变化时先注销再重建）。 */
  private readonly registered = new Map<string, RegisteredTool[]>();
  private globalSeq = 0;

  constructor(private readonly options: McpRuntimeOptions) {
    this.globalConfigPath = join(options.dataRoot, "mcp.json");
    this.projectConfigPath =
      options.workspaceRoot !== undefined ? join(options.workspaceRoot, ".novacode", "mcp.json") : null;
    this.manager = new McpManager({
      onDiagnostic: (message, err) => console.error(`[novacode/server] ${message}`, err ?? ""),
    });
    this.manager.onStatusChange((snapshot) => {
      this.syncTools(snapshot.serverKey, snapshot.status === "Connected");
      const seq = ++this.globalSeq;
      this.options.publish({
        name: "mcp.server_status_changed",
        payload: buildMcpServerStatusChangedEvent({
          seq,
          serverKey: snapshot.serverKey,
          status: snapshot.status,
          toolCount: snapshot.toolCount,
          ...(snapshot.lastError !== undefined && { error: snapshot.lastError }),
        }),
      });
    });
  }

  /** 启动加载 + 异步连接 enabled server（不阻塞装配；状态经事件）。 */
  async init(): Promise<void> {
    const sources: McpConfigSource[] = [{ path: this.globalConfigPath, level: "global" }];
    if (this.projectConfigPath !== null && existsSync(this.projectConfigPath)) {
      sources.push({ path: this.projectConfigPath, level: "project" });
    }
    const loaded = await loadMcpConfig(sources);
    for (const [serverKey, config] of loaded.configs) {
      this.manager.register(config);
      this.syncTools(serverKey, false);
      if (config.enabled) {
        void this.manager.connect(serverKey).catch(() => undefined); // 失败经事件
      }
    }
  }

  /** 优雅停机：断开全部 server（子进程树由 transport close 收敛）。 */
  async close(): Promise<void> {
    await this.manager.closeAll();
  }

  // ---------------------------------------------------------------------------
  // 方法表（06 §2.5：mcp.servers.list/add/remove/retry + mcp.tools.list/call）
  // ---------------------------------------------------------------------------

  methods(register: (method: string, handler: (params: unknown) => Promise<unknown>) => unknown): Record<string, unknown> {
    return {
      "mcp.servers.list": register("mcp.servers.list", async () => ({
        servers: this.manager.status().map((snapshot) => ({
          serverKey: snapshot.serverKey,
          transport: snapshot.transport,
          status: snapshot.status,
          enabled: snapshot.enabled,
          toolCount: snapshot.toolCount,
          ...(snapshot.lastError !== undefined && { lastError: snapshot.lastError }),
        })),
      })),
      "mcp.servers.add": register("mcp.servers.add", async (params) => this.addServer(params as McpServersAddParams)),
      "mcp.servers.remove": register("mcp.servers.remove", async (params) => {
        const { serverKey } = params as { serverKey: string };
        if (!this.manager.has(serverKey)) {
          throw new RpcCallError("MCP_SERVER_NOT_FOUND", `mcp server not found: ${serverKey}`);
        }
        await this.manager.disconnect(serverKey);
        this.unregisterTools(serverKey);
        this.manager.remove(serverKey);
        const level = this.levelOf(serverKey) ?? "global";
        await persistMcpConfig(this.pathOf(level), (servers) => {
          delete servers[serverKey];
        });
        return { removed: true };
      }),
      "mcp.servers.retry": register("mcp.servers.retry", async (params) => {
        const { serverKey } = params as { serverKey: string };
        await this.requireServer(serverKey).retry(serverKey);
        const snapshot = this.manager.status().find((s) => s.serverKey === serverKey);
        return { status: snapshot?.status ?? "Disconnected" };
      }),
      "mcp.tools.list": register("mcp.tools.list", async (params) => {
        const { serverKey } = params as McpToolsListParams;
        const keys = serverKey !== undefined ? [this.requireKey(serverKey)] : this.manager.keys();
        return {
          tools: keys.flatMap((key) =>
            this.manager.toolsOf(key).map((descriptor) => ({
              name: toMcpToolName(key, descriptor.name),
              serverKey: key,
              ...(descriptor.description !== undefined && { description: descriptor.description }),
              inputSchema: descriptor.inputSchema,
              available: descriptor.available,
            })),
          ),
        };
      }),
      "mcp.tools.call": register("mcp.tools.call", async (params) => {
        // timeoutMs（06 可选参数）由 server config.timeoutMs 经 metadata 统一生效，控制面不单独覆盖
        const { serverKey, toolName, args } = params as McpToolsCallParams;
        this.requireServer(serverKey);
        const descriptor = this.manager.toolsOf(serverKey).find((tool) => tool.name === toolName);
        if (descriptor === undefined) {
          throw new RpcCallError("MCP_TOOL_UNKNOWN", `tool "${toolName}" not found on server "${serverKey}"`);
        }
        if (!descriptor.available) {
          throw new RpcCallError("MCP_UNAVAILABLE", `mcp server unavailable: ${serverKey}`);
        }
        // 与模型调用同一 ToolExecutor 链路（超时/裁剪/错误映射一致，06 §2.5）
        const fullName = toMcpToolName(serverKey, toolName);
        const result = await this.options.executor.execute(
          { toolCallId: `mcpctl_${String(++this.globalSeq)}`, toolName: fullName, args },
          {
            signal: new AbortController().signal,
            workspaceRoot: this.options.workspaceRoot ?? process.cwd(),
            cwd: this.options.workspaceRoot ?? process.cwd(),
            sessionKey: "mcp-control",
            background: this.options.background,
          },
        );
        return { content: result.content, isError: result.isError, raw: { toolCallId: result.toolCallId, durationMs: result.durationMs } };
      }),
    };
  }

  // 内部 ---------------------------------------------------------------------

  private levelOf(serverKey: string): "project" | "global" | undefined {
    return this.manager.configOf(serverKey)?.level;
  }

  private pathOf(level: "project" | "global"): string {
    if (level === "project" && this.projectConfigPath !== null) {
      return this.projectConfigPath;
    }
    return this.globalConfigPath;
  }

  private requireKey(serverKey: string): string {
    if (!this.manager.has(serverKey)) {
      throw new RpcCallError("MCP_SERVER_NOT_FOUND", `mcp server not found: ${serverKey}`);
    }
    return serverKey;
  }

  private requireServer(serverKey: string): McpManager {
    this.requireKey(serverKey);
    return this.manager;
  }

  /** mcp.servers.add：持久化 → 注册 → 受理即返（连接异步建立，状态经事件）。 */
  private async addServer(params: McpServersAddParams): Promise<unknown> {
    const config: McpServerConfig = params.config;
    const path = this.pathOf(params.level);
    await persistMcpConfig(path, (servers) => {
      servers[config.serverKey] = config;
    });
    this.manager.register({ ...config, level: params.level });
    this.syncTools(config.serverKey, false);
    if (config.enabled) {
      void this.manager.connect(config.serverKey).catch(() => undefined);
    }
    const snapshot = this.manager.status().find((s) => s.serverKey === config.serverKey);
    return { serverKey: config.serverKey, status: snapshot?.status ?? "Disconnected" };
  }

  /** 失败隔离同步：Connected → 注册命名空间工具；否则注销（M6 标记 unavailable 语义）。 */
  private syncTools(serverKey: string, connected: boolean): void {
    this.unregisterTools(serverKey);
    if (!connected) {
      return;
    }
    const registered: RegisteredTool[] = [];
    for (const descriptor of this.manager.toolsOf(serverKey)) {
      if (!descriptor.available) {
        continue;
      }
      const tool = createMcpTool(serverKey, descriptor, this.manager);
      try {
        this.options.registry.register(tool, "mcp");
        registered.push({ fullName: tool.name, serverKey, toolName: descriptor.name });
      } catch (err: unknown) {
        console.error(`[novacode/server] mcp tool register failed: ${tool.name}`, err);
      }
    }
    this.registered.set(serverKey, registered);
  }

  private unregisterTools(serverKey: string): void {
    for (const { fullName } of this.registered.get(serverKey) ?? []) {
      this.options.registry.unregister(fullName);
    }
    this.registered.delete(serverKey);
  }
}

// McpError → RpcCallError 统一映射（方法 handler 内 catch 后转换）
export function mapMcpError(err: unknown): unknown {
  if (err instanceof McpError) {
    return new RpcCallError(err.code, err.message);
  }
  if (err instanceof McpConfigError) {
    return new RpcCallError(err.code, err.message);
  }
  return err;
}
