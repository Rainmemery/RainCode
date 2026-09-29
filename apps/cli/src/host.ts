/**
 * stdio 宿主装配（T2.8 / 04-architecture §3.2 agent 子进程同形态，端层唯一 stdio 组装点）：
 * StdioTransport(process.stdin/stdout) → createAgentServiceNode（server 唯一组装点，无第二拼装）。
 * 桌面端 agent 子进程宿主（T2.9）与人工 cat 调试共用本入口。
 */
import { StdioTransport } from "@raincode/rpc";
import { createAgentServiceNode, resolveProviderConfig } from "@raincode/server";
import type { AgentServiceNode } from "@raincode/server";
import { DEFAULT_SYSTEM_PROMPT, parseCliArgs } from "./context.js";

export interface StdioHostContext {
  readonly node: AgentServiceNode;
  readonly transport: StdioTransport;
  /** Provider 配置来源诊断（cli|env|config|none，不含凭据）。 */
  readonly providerSource: string;
  /** 优雅收尾：先关服务与存储（在途响应可继续 flush），再关 transport（flush + end stdout）。 */
  close(): Promise<void>;
}

export async function createStdioHostContext(argv: string[] = []): Promise<StdioHostContext> {
  const args = parseCliArgs(argv);
  const resolved = resolveProviderConfig({ args: args.provider, env: process.env, configPath: args.providerConfig });
  const transport = new StdioTransport({ input: process.stdin, output: process.stdout });
  const node = await createAgentServiceNode(transport, {
    provider: resolved
      ? {
          name: resolved.name,
          baseURL: resolved.baseURL,
          model: resolved.model,
          apiKey: resolved.apiKey,
          maxContextTokens: resolved.maxContextTokens,
        }
      : null,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
  });
  return {
    node,
    transport,
    providerSource: resolved ? resolved.source : "none",
    async close(): Promise<void> {
      await node.close();
      await transport.close();
    },
  };
}
