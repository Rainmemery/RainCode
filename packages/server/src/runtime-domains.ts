/**
 * 运行时域装配（T3.8 自 agent-service 构造期拆出，单文件 ≤500 行治理）：MCP / plugins /
 * subagent / memory / skills 五域的构造集中一处；未配置的域为 null（方法不暴露，06 §2）。
 * 仅做构造与接线，不含方法表（buildMethods 归 AgentService）。
 */
import type { LlmPort } from "@raincode/agent-core";
import type { ToolPhaseDeps } from "@raincode/agent-core";
import type { BackgroundTaskRegistry, ToolExecutor, ToolRegistry } from "@raincode/tools";
import type { Storage } from "@raincode/storage";
import type { SectionEditHooks } from "@raincode/memory";
import { McpRuntime } from "./mcp-runtime.js";
import { PluginRuntime } from "./plugin-runtime.js";
import { MarketplaceRuntime } from "./marketplace-runtime.js";
import { SubagentRuntime } from "./subagent-runtime.js";
import { SkillRuntime } from "./skill-runtime.js";
import { MemoryRuntime } from "./memory-runtime.js";
import { McpToolCatalog } from "./mcp-tool-catalog.js";
import { createHistorySearchChannel } from "./history-search-channel.js";

/** 五域装配入参（AgentServiceOptions 的域配置投影，原样透传）。 */
export interface RuntimeDomainInputs {
  /** toolSearch = false 显式关闭 MCP 工具目录化（T5.6；缺省启用）。 */
  mcp?: { workspaceRoot?: string; toolSearch?: boolean };
  plugins?: Record<string, never>;
  /** marketplace 域装配（T6.1 / 06 §2.10 v1.14；要求 plugins 域在位——缺位不装配并诊断）。 */
  marketplace?: Record<string, never>;
  subagent?: { workspaceRoot?: string };
  memory?: { workspaceRoot?: string; sectionEditHooks?: SectionEditHooks };
  skills?: Record<string, never>;
}

/** 五域构造依赖（AgentService 内部件的结构投影；publish 为事件扇出出口）。 */
export interface RuntimeDomainDeps {
  registry: ToolRegistry;
  background: BackgroundTaskRegistry;
  /** MCP 域工具执行面（ToolExecutor，02 §3 命名空间工具调用通道）。 */
  toolExecutor: ToolExecutor;
  /** 子代理域 toolDeps（含 registry/executor/permission/background/askUser）。 */
  toolDeps: ToolPhaseDeps & { background: BackgroundTaskRegistry };
  storage: Storage;
  /** 主 LLM 客户端（memory 抽取/晋升调用；null = 无 provider，抽取失败仅诊断）。 */
  llm: LlmPort | null;
  /** 子代理 profile.model（模型名）→ LLM 客户端（02 §4.3）。 */
  llmForModel: (model: string | undefined) => LlmPort | null;
  publish: (event: { name: string; payload: unknown }) => void;
  /** skills 域提交链（session.send / skills.invoke 共用）。 */
  submitTurn: (sessionId: string, text: string) => Promise<unknown>;
  /** 模型可用窗口 token（T5.6 目录预算 = 10% 封顶 20000；与 contextUsage 投影同口径）。 */
  maxContextTokens: number;
}

export interface RuntimeDomains {
  mcp: McpRuntime | null;
  plugins: PluginRuntime | null;
  /** marketplace 域（T6.1；plugins 域缺位时连带不装配）。 */
  marketplace: MarketplaceRuntime | null;
  subagent: SubagentRuntime | null;
  memory: MemoryRuntime | null;
  skills: SkillRuntime | null;
  /** MCP 工具目录（T5.6；mcp 域未装配或显式关闭 → null，目录模式不生效）。 */
  mcpCatalog: McpToolCatalog | null;
}

export function buildRuntimeDomains(inputs: RuntimeDomainInputs, deps: RuntimeDomainDeps): RuntimeDomains {
  // MCP 域（02 §3）：命名空间工具进同一 registry；连接异步建立，状态经全局事件
  const mcp =
    inputs.mcp === undefined
      ? null
      : new McpRuntime({
          registry: deps.registry,
          background: deps.background,
          executor: deps.toolExecutor,
          dataRoot: deps.storage.dataRoot,
          workspaceRoot: inputs.mcp.workspaceRoot,
          publish: deps.publish,
        });
  // init 失败（如 mcp.json 损坏 MCP_CONFIG_INVALID）→ 域降级 + 诊断，不得以未处理拒绝
  // 击穿 agent 装配（T3.9 桌面走查发现：配置形态缺陷曾致 agent 子进程崩溃循环放弃）
  mcp?.init().catch((err: unknown) => {
    console.error("[raincode/server] mcp domain degraded: init failed", err);
  });
  // 插件域（06 §2.10 v1.8）：目录扫描 + 激活异步进行，单插件故障隔离为 failed 状态
  // （bootstrap 于构造期启动；控制面方法经就绪门等待初次扫描完成）。
  // T6.1 postBootstrap 钩子：初扫完成后、ready 放行前由 marketplace 域执行台账重 attach
  //（保证重启后首次 plugins.list 已含市场安装插件；marketplace 缺位时钩子空转）。
  let marketplaceRuntime: MarketplaceRuntime | null = null;
  const plugins =
    inputs.plugins === undefined
      ? null
      : new PluginRuntime({
          registry: deps.registry,
          dataRoot: deps.storage.dataRoot,
          publish: deps.publish,
          ...(inputs.marketplace !== undefined && {
            postBootstrap: async () => {
              await marketplaceRuntime?.bootstrap();
            },
          }),
        });
  // marketplace 域（T6.1 / 06 §2.10 v1.14）：安装/卸载/注册表/台账 + 技能第三源供给；
  // 要求 plugins 域在位（激活/注销单点归 PluginRuntime），缺位连带不装配（诊断不抛）。
  const marketplace =
    inputs.marketplace === undefined || plugins === null
      ? null
      : (marketplaceRuntime = new MarketplaceRuntime({ dataRoot: deps.storage.dataRoot, plugins }));
  // 子代理域（02 §4）：agent 工具进同一 registry；子会话宿主经 SubagentLoopHost 注入（ADR-06）
  const subagent =
    inputs.subagent === undefined
      ? null
      : new SubagentRuntime({
          storage: deps.storage,
          toolDeps: deps.toolDeps,
          llmFor: deps.llmForModel,
          dataRoot: deps.storage.dataRoot,
          workspaceRoot: inputs.subagent.workspaceRoot ?? null,
          publish: deps.publish,
        });
  // memory 域（02 §7 / 06 §2.6）：未配置 → 不注册方法/不注入 MEMORY.md/不挂抽取钩子
  const memory =
    inputs.memory === undefined
      ? null
      : new MemoryRuntime({
          storage: deps.storage,
          llmFor: () => deps.llm,
          ...(inputs.memory.workspaceRoot !== undefined && { workspaceRoot: inputs.memory.workspaceRoot }),
          ...(inputs.memory.sectionEditHooks !== undefined && { sectionEditHooks: inputs.memory.sectionEditHooks }),
        });
  // skills 域（T3.4 / 06 §2.9）：提交链注入（session.send / skills.invoke 共用）；
  // T6.1 第三源：marketplace 已安装插件随附技能（workspace > global > plugin 优先级）。
  const skills =
    inputs.skills === undefined
      ? null
      : new SkillRuntime({
          dataRoot: deps.storage.dataRoot,
          workspaceRootOf: (sessionId) => deps.storage.workspaceRootOf(sessionId),
          submitTurn: deps.submitTurn,
          ...(marketplace !== null && { pluginSkillRoots: () => marketplace.installedPluginDirs() }),
        });
  // 模型侧工具通道接线集中此处（tool-phase ToolPhaseDeps；缺省字段缺失 → 工具以 TOOL_UNAVAILABLE 收敛）
  if (skills !== null) {
    // T4.4 skill 展开通道：展开单点 SkillRuntime（skills.invoke 同链路）
    deps.toolDeps.expandSkill = (request) => skills.expandForModel(request.sessionId, request.name, request.arguments);
  }
  // T5.3 session_search 检索通道：storage.searchHistory 薄投影（part 级 FTS + 相对分数地板语义单点在 storage）
  deps.toolDeps.searchHistory = createHistorySearchChannel(deps.storage);
  // T5.6 MCP 工具目录化：mcp 域装配且未显式关闭 → 目录快照端口（turn-loop 载荷）+ mcp_tool_search 检索通道
  const mcpCatalog =
    inputs.mcp !== undefined && (inputs.mcp.toolSearch ?? true)
      ? new McpToolCatalog({
          registry: deps.registry,
          maxContextTokens: () => deps.maxContextTokens,
        })
      : null;
  if (mcpCatalog !== null) {
    deps.toolDeps.searchMcpTools = (request) => mcpCatalog.search(request.query, request.limit);
  }
  return { mcp, plugins, marketplace, subagent, memory, skills, mcpCatalog };
}
