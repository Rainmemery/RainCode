/**
 * MCP 工具适配（02-module-design §3.3）：
 * 远端工具描述符 → RainCode Tool（注册进 ToolRegistry，source="mcp"）。
 *
 * - 命名：mcp__<serverKey>__<toolName>（toMcpToolName）；
 * - schema：原始 inputSchema 直通（provider function parameters），运行时仅保留宽松
 *   object 形状校验，具体校验由远端 server 承担（02 §3.3「不可表达处降级」）；
 * - 权限 metadata 合成从严（02 §3.3）：readOnly=false、destructive=false、
 *   sideEffectScope="machine"、riskLevel="medium"、needsApproval=true——
 *   用户可在权限规则中为可信 server 显式放宽；
 * - 失败隔离：server 不可用/工具未知/超时映射为数据级 ToolExecutionError（TOOL_*），
 *   不影响其他 server 与内置工具。
 */
import { z } from "zod";
import type { McpToolDescriptor } from "@raincode/shared";
import { ToolExecutionError } from "@raincode/tools";
import type { Tool, ToolExecutionContext, ToolOutput } from "@raincode/tools";
import { McpError } from "./manager.js";
import type { McpManager } from "./manager.js";

/** CallToolResult → 模型可见文本（text 块拼接；非文本块 JSON 序列化附后）。 */
export function projectCallResultContent(result: { content: Array<{ type: string; [key: string]: unknown }> }): string {
  const parts: string[] = [];
  for (const block of result.content) {
    if (block.type === "text" && typeof block["text"] === "string") {
      parts.push(block["text"]);
    } else {
      parts.push(JSON.stringify(block));
    }
  }
  return parts.join("\n");
}

/** 把远端工具描述符适配为 Tool（available=false 时不注册——由 server 域控制注册时机）。 */
export function createMcpTool(serverKey: string, descriptor: McpToolDescriptor, manager: McpManager): Tool {
  const toolName = descriptor.name;
  const inputSchema =
    descriptor.inputSchema !== null && typeof descriptor.inputSchema === "object"
      ? (descriptor.inputSchema as Record<string, unknown>)
      : { type: "object" as const };
  return {
    name: `mcp__${serverKey}__${toolName}`,
    description: descriptor.description ?? `MCP tool "${toolName}" on server "${serverKey}"`,
    parametersSchema: z.record(z.string(), z.unknown()),
    parametersJsonSchema: inputSchema,
    metadata: {
      readOnly: false,
      destructive: false,
      sideEffectScope: "machine",
      riskLevel: "medium",
      needsApproval: true, // 外部工具默认从严（02 §3.3）
      ...(manager.configOf(serverKey)?.timeoutMs !== undefined && {
        timeoutMs: manager.configOf(serverKey)!.timeoutMs,
      }),
    },
    async execute(input: unknown, ctx: ToolExecutionContext): Promise<ToolOutput<string>> {
      try {
        const result = await manager.callTool(serverKey, toolName, input, undefined, ctx.signal);
        const text = projectCallResultContent(result);
        if (result.isError === true) {
          // 远端工具报错（数据级）：MCP isError → TOOL_EXEC_FAILED，内容交模型自纠
          throw new ToolExecutionError("TOOL_EXEC_FAILED", text || `mcp tool "${toolName}" reported an error`);
        }
        return { data: text, content: text };
      } catch (reason: unknown) {
        if (reason instanceof ToolExecutionError) {
          throw reason;
        }
        if (reason instanceof McpError) {
          const code =
            reason.code === "MCP_TOOL_UNKNOWN"
              ? "TOOL_UNKNOWN"
              : reason.code === "MCP_UNAVAILABLE"
                ? "TOOL_UNAVAILABLE"
                : "TOOL_EXEC_FAILED";
          throw new ToolExecutionError(code, reason.message);
        }
        if (reason instanceof Error && /timed out|timeout/i.test(reason.message)) {
          throw new ToolExecutionError("TOOL_TIMEOUT", reason.message);
        }
        throw new ToolExecutionError("TOOL_EXEC_FAILED", reason instanceof Error ? reason.message : String(reason));
      }
    },
  };
}
