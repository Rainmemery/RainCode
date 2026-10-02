/**
 * 插件工具适配（02-module-design §2.3 / §3.3 同构口径）：
 * 插件工具描述符 → RainCode Tool（注册进 ToolRegistry，source="plugin"）。
 *
 * - 命名：plugin__<pluginName>__<toolName>（toPluginToolName，registry 对 source="plugin"
 *   放行该命名空间——与 mcp__ 豁免同构）；
 * - schema：JSON Schema 直通（parametersJsonSchema），运行时仅保留宽松 object 形状校验，
 *   具体校验由插件自身承担（plain JS 契约无 zod，02 §3.3「不可表达处降级」同款）；
 * - 权限 metadata 合成从严（02 §3.3 同款）：缺省 readOnly=false、destructive=false、
 *   sideEffectScope="machine"、riskLevel="medium"、needsApproval=true——插件声明可收窄
 *   （readOnly/needsApproval 等），权限规则仍可对可信插件显式放宽；
 * - 失败隔离（T3.5 验收「插件故障不拖垮内核」）：execute 抛错/超时映射为数据级
 *   ToolExecutionError（TOOL_EXEC_FAILED/TOOL_TIMEOUT），turn 继续模型可自纠。
 */
import { z } from "zod";
import { ToolExecutionError } from "../executor.js";
import type { Tool, ToolExecutionContext, ToolOutput } from "../tool.js";
import type { PluginToolDescriptor } from "./loader.js";

export function createPluginTool(pluginName: string, descriptor: PluginToolDescriptor): Tool {
  const fullName = `plugin__${pluginName}__${descriptor.name}`;
  const declared = descriptor.metadata ?? {};
  const inputSchema =
    descriptor.parametersJsonSchema !== undefined
      ? descriptor.parametersJsonSchema
      : { type: "object" as const };
  return {
    name: fullName,
    description: descriptor.description,
    parametersSchema: z.record(z.string(), z.unknown()),
    parametersJsonSchema: inputSchema,
    metadata: {
      readOnly: declared.readOnly ?? false,
      destructive: declared.destructive ?? false,
      sideEffectScope: "machine",
      riskLevel: declared.riskLevel ?? "medium",
      needsApproval: declared.needsApproval ?? true,
      ...(declared.timeoutMs !== undefined && { timeoutMs: declared.timeoutMs }),
    },
    async execute(input: unknown, ctx: ToolExecutionContext): Promise<ToolOutput<string>> {
      try {
        const result = await descriptor.execute(input, { signal: ctx.signal });
        const text =
          typeof result === "string" ? result : JSON.stringify(result ?? null); // 非字符串返回值序列化兜底
        return { data: text, content: text };
      } catch (reason: unknown) {
        if (reason instanceof ToolExecutionError) {
          throw reason;
        }
        if (reason instanceof Error && /timed out|timeout/i.test(reason.message)) {
          throw new ToolExecutionError("TOOL_TIMEOUT", reason.message);
        }
        throw new ToolExecutionError(
          "TOOL_EXEC_FAILED",
          `plugin tool "${fullName}" failed: ${reason instanceof Error ? reason.message : String(reason)}`,
        );
      }
    },
  };
}
