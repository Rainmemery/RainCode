/**
 * @raincode/mcp —— MCP Integration（04-architecture §2.1 / 02-module-design §3）。
 *
 * 本包唯一 publicEntrypoint（architecture/policy.yaml）。
 * 职责（02 §3）：MCP server 连接生命周期（stdio/http/sse 三 transport + 状态机 M1~M8）、
 * 失败隔离与重连退避、mcp.json 配置加载与持久化、远端工具适配（命名空间 + 从严 metadata）。
 * 依赖：@modelcontextprotocol/sdk（协议交互）、@raincode/shared（schema）、@raincode/tools（Tool 契约）。
 */

export {
  BUILTIN_TOOL_NAMES,
  McpConfigError,
  loadMcpConfig,
  persistMcpConfig,
  toMcpToolName,
  validateServerKey,
} from "./config.js";
export type { LoadedMcpConfig, McpConfigSource, McpServerConfigLevel } from "./config.js";

export { McpError, McpManager } from "./manager.js";
export type { McpManagerOptions, McpStatusSnapshot } from "./manager.js";

export { createMcpTool, projectCallResultContent } from "./adapter.js";
