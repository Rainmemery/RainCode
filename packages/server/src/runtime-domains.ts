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
import { SubagentRuntime } from "./subagent-runtime.js";
import { SkillRuntime } from "./skill-runtime.js";
import { MemoryRuntime } from "./memory-runtime.js";

/** 五域装配入参（AgentServiceOptions 的域配置投影，原样透传）。 */
export interface RuntimeDomainInputs {
  mcp?: { workspaceRoot?: string };
  plugins?: Record<string, never>;
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
}

export interface RuntimeDomains {
  mcp: McpRuntime | null;
  plugins: PluginRuntime | null;
  subagent: SubagentRuntime | null;
  memory: MemoryRuntime | null;
  skills: SkillRuntime | null;
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
  // （bootstrap 于构造期启动；控制面方法经就绪门等待初次扫描完成）
  const plugins =
    inputs.plugins === undefined
      ? null
      : new PluginRuntime({ registry: deps.registry, dataRoot: deps.storage.dataRoot, publish: deps.publish });
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
  // skills 域（T3.4 / 06 §2.9）：提交链注入（session.send / skills.invoke 共用）
  const skills =
    inputs.skills === undefined
      ? null
      : new SkillRuntime({
          dataRoot: deps.storage.dataRoot,
          workspaceRootOf: (sessionId) => deps.storage.workspaceRootOf(sessionId),
          submitTurn: deps.submitTurn,
        });
  return { mcp, plugins, subagent, memory, skills };
}
