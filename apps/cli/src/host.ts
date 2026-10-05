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
    skills: {}, // skills 域启用（T3.4）：与 CLI in-process 同语义（06 §2.9）
    plugins: {}, // plugins 域启用（T3.5）：与 CLI in-process 同语义（06 §2.10）
    mcp: {}, // mcp 域启用（T3.9 全量对齐补装配）：stdio 宿主无装配期工作区，全局层 mcp.json 生效（06 §2.5）
    memory: {}, // memory 域启用（B2 缺陷修复：stdio 宿主无装配期工作区，MEMORY.md 按会话工作区逐会话解析）（06 §2.6）
    subagent: {}, // subagent 域启用（refine-ui-context-panel 轮缺陷修复：B2 同款三端装配缺口；无装配期工作区，profile 解析 global+builtin 层）（06 §2.5）
    hooks: {}, // hooks 域启用（T5.1；ui-panel-deepening 轮装配缺口修复——B2 同款：此前仅 smoke 自建节点手装，真实入口 hooks.list METHOD_NOT_FOUND；user 层 <dataRoot>/hooks.json + project 层按会话工作区解析）（06 §2.12）
    compaction: {}, // 压缩域启用（ui-panel-deepening 轮装配缺口修复——B2 同款：此前仅 smoke 自建节点手装选项，真实入口 auto-compact/microcompact/session.compact 全部失效；{} = 全缺省，窗口取活跃 Provider maxContextTokens）（02 §1.2.5）
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
