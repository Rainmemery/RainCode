/**
 * CLI 公共装配：进程内 in-memory 绑定到 AgentService（04 §3.1 单进程内嵌；06 §6.1 in-memory 绑定）。
 * Provider 来源优先级在此落地：CLI 参数 > RAINCODE_PROVIDER_* env > config/providers.local.json。
 */
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { createInMemoryTransportPair, createRpcClient } from "@raincode/rpc";
import type { InMemoryTransport, RpcClient } from "@raincode/rpc";
import { createAgentServiceNode, resolveProviderConfig } from "@raincode/server";
import type { AgentServiceNode, ProviderCliArgs } from "@raincode/server";

/** 默认系统提示（walking skeleton 最小形态；提示词工程随工具系统波次演进）。 */
export const DEFAULT_SYSTEM_PROMPT =
  "You are RainCode, a coding agent working inside the user's workspace. Answer concisely.";

export interface ParsedCliArgs {
  positionals: string[];
  provider: ProviderCliArgs;
  providerConfig?: string;
  workspace?: string;
  title?: string;
  /** run 非交互模式自动 allow（等价临时 session 规则，不落库）。 */
  yes?: boolean;
  /** config dump 损坏诊断模式：跳过配置文件读取，只打印内置默认层（T5.5）。 */
  defaultOnly?: boolean;
}

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "base-url": { type: "string" },
      model: { type: "string" },
      "api-key": { type: "string" },
      name: { type: "string" },
      "provider-config": { type: "string" },
      workspace: { type: "string" },
      title: { type: "string" },
      yes: { type: "boolean" },
      "default-only": { type: "boolean" },
    },
  });
  const stringOrUndefined = (value: string | undefined): string | undefined =>
    value !== undefined && value.length > 0 ? value : undefined;
  return {
    positionals,
    provider: {
      baseUrl: stringOrUndefined(values["base-url"]),
      model: stringOrUndefined(values.model),
      apiKey: stringOrUndefined(values["api-key"]),
      name: stringOrUndefined(values.name),
    },
    providerConfig: stringOrUndefined(values["provider-config"]),
    workspace: stringOrUndefined(values.workspace),
    title: stringOrUndefined(values.title),
    yes: values.yes === true,
    defaultOnly: values["default-only"] === true,
  };
}

export interface CliContext {
  client: RpcClient;
  node: AgentServiceNode;
  transports: [InMemoryTransport, InMemoryTransport];
  /** Provider 配置来源诊断（cli|env|config|none，不含凭据）。 */
  providerSource: string;
}

/**
 * 启动进程内服务节点并返回 RPC 客户端。
 * Provider 未配置时服务仍可启动（ping/list/resume 可用）；run/chat 须自行校验。
 */
export async function startServiceNode(args: ParsedCliArgs): Promise<CliContext> {
  const resolved = resolveProviderConfig({
    args: args.provider,
    env: process.env,
    configPath: args.providerConfig,
  });
  const transports = createInMemoryTransportPair();
  const node = await createAgentServiceNode(transports[1], {
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
    skills: {}, // skills 域启用（T3.4）：workspace 技能目录按会话 workspaceRoot 逐会话解析
    plugins: {}, // plugins 域启用（T3.5）：数据根 plugins 目录扫描 + 激活（单插件故障隔离）
    marketplace: {}, // marketplace 域启用（T6.1）：市场注册/安装/卸载（06 §2.10 v1.14）
    // mcp 域启用（T3.9 全量对齐补装配）：project 层 mcp.json 需装配期工作区，仅单工作区入口
    //（--workspace）生效；多工作区入口（chat 无 --workspace / serve / web）全局层 mcp.json 生效
    ...(args.workspace !== undefined ? { mcp: { workspaceRoot: resolve(args.workspace) } } : { mcp: {} }),
    // memory 域启用（B2 可视化测试缺陷修复：三端入口此前均未装配 → memory.read METHOD_NOT_FOUND，
    // MEMORY.md 注入/抽取/晋升全链路失效）：workspaceRoot 为 promote 反查兜底域，有 --workspace 时传入
    ...(args.workspace !== undefined
      ? { memory: { workspaceRoot: resolve(args.workspace) } }
      : { memory: {} }),
    // hooks 域启用（T5.1；ui-panel-deepening 轮装配缺口修复——B2 同款：此前仅 smoke 自建节点手装，
    // 真实入口 hooks.list METHOD_NOT_FOUND；user 层 <dataRoot>/hooks.json + project 层按会话工作区解析）（06 §2.12）
    hooks: {},
    // 压缩域启用（ui-panel-deepening 轮装配缺口修复——B2 同款：此前仅 smoke 自建节点手装选项，
    // 真实入口 auto-compact/microcompact/session.compact 全部失效；{} = 全缺省，窗口取活跃 Provider maxContextTokens）（02 §1.2.5）
    compaction: {},
  });
  const client = createRpcClient({ transport: transports[0] });
  return { client, node, transports, providerSource: resolved ? resolved.source : "none" };
}

/** 优雅收尾：先关客户端（reject 未决请求），再关服务与两侧 transport。 */
export async function teardown(context: CliContext): Promise<void> {
  context.client.close();
  await context.node.close();
  await context.transports[0].close();
  await context.transports[1].close();
}

/** 无 Provider 时的统一报错（exit code 2）。 */
export function missingProviderError(): number {
  process.stderr.write(
    "no provider configured: set --base-url/--model, RAINCODE_PROVIDER_BASE_URL/RAINCODE_PROVIDER_MODEL env,\n" +
      "or add config/providers.local.json (gitignored). See: raincode help\n",
  );
  return 2;
}
