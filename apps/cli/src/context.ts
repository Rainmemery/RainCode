/**
 * CLI 公共装配：进程内 in-memory 绑定到 AgentService（04 §3.1 单进程内嵌；06 §6.1 in-memory 绑定）。
 * Provider 来源优先级在此落地：CLI 参数 > NOVACODE_PROVIDER_* env > config/providers.local.json。
 */
import { parseArgs } from "node:util";
import { createInMemoryTransportPair, createRpcClient } from "@novacode/rpc";
import type { InMemoryTransport, RpcClient } from "@novacode/rpc";
import { createAgentServiceNode, resolveProviderConfig } from "@novacode/server";
import type { AgentServiceNode, ProviderCliArgs } from "@novacode/server";

/** 默认系统提示（walking skeleton 最小形态；提示词工程随工具系统波次演进）。 */
export const DEFAULT_SYSTEM_PROMPT =
  "You are NovaCode, a coding agent working inside the user's workspace. Answer concisely.";

export interface ParsedCliArgs {
  positionals: string[];
  provider: ProviderCliArgs;
  providerConfig?: string;
  workspace?: string;
  title?: string;
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
    "no provider configured: set --base-url/--model, NOVACODE_PROVIDER_BASE_URL/NOVACODE_PROVIDER_MODEL env,\n" +
      "or add config/providers.local.json (gitignored). See: novacode help\n",
  );
  return 2;
}
