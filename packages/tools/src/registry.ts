/**
 * ToolRegistry（02-module-design §2.3）：内置工具 + MCP 工具 + 插件工具的统一注册点。
 *
 * - 注册查重：重名即抛错（fail-fast，02 §2.4 表格外的装配期约束）；
 * - 命名空间隔离：非 mcp 来源禁止占用 `mcp__<serverKey>__<toolName>` 命名空间；v1.8 起
 *   source="plugin" 同构放行 `plugin__<pluginName>__<toolName>`（T3.5 插件化）；
 *   其余来源禁止内嵌 `__` 的名字（02 §3.3/§3.4）；
 * - list：输出 ToolDescriptor（含 zod→JSON Schema 投影）。
 */
import { zodToJsonSchema } from "./json-schema.js";
import type { Tool, ToolDescriptor, ToolSource } from "./tool.js";

interface Registration {
  tool: Tool<any, any>;
  source: ToolSource;
}

export class ToolRegistry {
  private readonly tools = new Map<string, Registration>();

  register(tool: Tool<any, any>, source: ToolSource = "builtin"): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`duplicate tool registration: ${tool.name}`);
    }
    if (tool.name.includes("__")) {
      // 命名空间保留（02 §3.4）：`mcp__`/`plugin__` 各自仅对应来源可用，其余来源禁用 `__`
      const namespaceOk =
        (source === "mcp" && tool.name.startsWith("mcp__")) ||
        (source === "plugin" && tool.name.startsWith("plugin__"));
      if (!namespaceOk) {
        throw new Error(`tool name "${tool.name}" uses a reserved namespace`);
      }
    }
    this.tools.set(tool.name, { tool, source });
  }

  get(name: string): Tool<any, any> | undefined {
    return this.tools.get(name)?.tool;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** 注销工具（MCP 失败隔离/server 移除时使用；不存在返回 false）。 */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  sourceOf(name: string): ToolSource | undefined {
    return this.tools.get(name)?.source;
  }

  list(filter?: { source?: ToolSource }): ToolDescriptor[] {
    const out: ToolDescriptor[] = [];
    for (const { tool, source } of this.tools.values()) {
      if (filter?.source !== undefined && filter.source !== source) {
        continue;
      }
      out.push({
        name: tool.name,
        description: tool.description,
        source,
        metadata: tool.metadata,
        // MCP 工具优先直通原始 inputSchema（02 §3.3：JSON Schema 转换保留原始 schema）
        parametersSchema: tool.parametersJsonSchema ?? zodToJsonSchema(tool.parametersSchema),
      });
    }
    return out;
  }

  get size(): number {
    return this.tools.size;
  }
}
