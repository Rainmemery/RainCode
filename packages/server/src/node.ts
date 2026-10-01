/**
 * AgentServiceNode 工厂（04-architecture §2.4 铁律 4 / ADR-06）：
 * CLI in-process 与未来桌面端 headless 宿主复用同一装配入口——
 * 打开 Storage → 组装 LlmClient + AgentService → 绑定到注入的 transport。
 * 端层只领取「组装好的服务」，禁止各自拼装内核依赖（杜绝第二组装点）。
 */
import { Storage, resolveDataRoot } from "@raincode/storage";
import type { IMessageTransport, RpcServiceBinding } from "@raincode/rpc";
import type { SandboxConfig } from "@raincode/shared";
import { resolveSandboxExecutor } from "@raincode/tools";
import type { ResolvedSandboxExecutor } from "@raincode/tools";
import { AgentService } from "./agent-service.js";
import { ConfigStore } from "./config-store.js";
import type {
  AgentServiceOptions,
  PermissionConfig,
  ProviderRuntimeConfig,
  ToolRuntimeConfig,
} from "./agent-service.js";

export interface AgentServiceNodeOptions {
  /** 注入已打开的 Storage（生命周期由持有方管理）；缺省按 dataRoot/env 打开。 */
  storage?: Storage;
  /** 未注入 storage 时的数据根（05 §2.1；缺省 RAINCODE_HOME → ~/.raincode）。 */
  dataRoot?: string;
  env?: NodeJS.ProcessEnv;
  /** Provider 运行时配置；null/缺省 = 无 Provider（ping/list/resume 可用，send 报 CONFIG_PROVIDER_NOT_FOUND）。 */
  provider?: ProviderRuntimeConfig | null;
  systemPrompt?: string;
  /** 工具系统装配（缺省内置工具集）。 */
  tools?: ToolRuntimeConfig;
  /** 权限策略（缺省 normal：五级判定链 + 审批闭环；default-allow 仅开发）。 */
  permission?: PermissionConfig;
  /** auto-compact 选项（02 §1.2.5；缺省 = 不启用；contextWindowTokens 取 Provider maxContextTokens）。 */
  compaction?: AgentServiceOptions["compaction"];
  /** MCP 域装配（02 §3；缺省 = 不启用）。 */
  mcp?: AgentServiceOptions["mcp"];
  /** 子代理域装配（02 §4；缺省 = 不启用；workspaceRoot 为 workspace 层 profiles 判定域）。 */
  subagent?: AgentServiceOptions["subagent"];
  /** memory 域装配（02 §7；缺省 = 不启用；workspaceRoot 为 promote 反查兜底域）。 */
  memory?: AgentServiceOptions["memory"];
  /** 沙箱执行域配置（M3 T3.1；缺省读 `<dataRoot>/config.json` 的 sandbox 节，不可读按 local）。 */
  sandboxConfig?: SandboxConfig;
}

export interface AgentServiceNode {
  readonly service: AgentService;
  readonly binding: RpcServiceBinding;
  readonly storage: Storage;
  /** 关闭方法表受理并关闭 Storage（幂等）。 */
  close(): Promise<void>;
}

/** 沙箱执行域解析（M3 T3.1）：显式配置优先，缺省读 config.json sandbox 节；回退告警走 stderr（诊断通道，stdout 只承载协议帧）。 */
async function resolveNodeSandbox(dataRoot: string, override: SandboxConfig | undefined): Promise<ResolvedSandboxExecutor> {
  let config = override;
  if (config === undefined) {
    try {
      config = new ConfigStore({ dataRoot }).read().sandbox;
    } catch {
      config = undefined; // config.json 缺失/非法按缺省 local（合法性由 config 域方法单独报错）
    }
  }
  const resolved = await resolveSandboxExecutor(config);
  for (const warning of resolved.warnings) {
    process.stderr.write(`[raincode/server] ${warning}\n`);
  }
  return resolved;
}

export async function createAgentServiceNode(
  transport: IMessageTransport,
  options: AgentServiceNodeOptions = {},
): Promise<AgentServiceNode> {
  const storage =
    options.storage ?? (await Storage.open({ dataRoot: options.dataRoot, env: options.env }));
  const sandboxResolved = await resolveNodeSandbox(
    options.dataRoot ?? resolveDataRoot(options.env),
    options.sandboxConfig,
  );
  // 存储关闭单次化：system.shutdown（经 AgentService.onShutdown）与 node.close() 共用同一守卫，
  // 保证 shutdown 应答仍可经 transport 投递后再由持有方收尾（06 §6.2 CLI 行映射）。
  let storageClosed = false;
  const closeStorage = async (): Promise<void> => {
    if (storageClosed) return;
    storageClosed = true;
    await storage.close();
  };
  const service = new AgentService({
    storage,
    provider: options.provider ?? null,
    systemPrompt: options.systemPrompt,
    // 沙箱执行域：调用方显式注入（tools.executor）优先，否则用 config.json 解析结果
    tools: {
      ...(options.tools ?? {}),
      ...(options.tools?.executor === undefined && { executor: sandboxResolved.executor }),
    },
    permission: options.permission,
    ...(options.compaction !== undefined && { compaction: options.compaction }),
    ...(options.mcp !== undefined && { mcp: options.mcp }),
    ...(options.subagent !== undefined && { subagent: options.subagent }),
    ...(options.memory !== undefined && { memory: options.memory }),
    onShutdown: closeStorage,
  });
  const binding = service.attach(transport);
  let closed = false;
  return {
    service,
    binding,
    storage,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      service.close();
      await closeStorage();
    },
  };
}
