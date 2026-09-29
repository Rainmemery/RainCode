/**
 * `agent` 工具（02-module-design §4.1/§4.3）：主会话模型派发子代理的入口（P1）。
 *
 * - execute 内 await handle.result() 同步阻塞到子代理终态——工具结果即「完成通知」，
 *   作为 role:"tool" 消息落盘并参与下轮模型请求（02 §4.1 完成通知注入主循环的实现路径，
 *   无需额外的历史注入机制）；
 * - 层级固定为 2：子会话工具投影不含本工具（server 装配经 projectRegistry 保证，天然不可达）；
 * - 工具自身无副作用（readOnly/none/low）：子会话内的工具各自走同一权限链判定（02 §4.4），
 *   本元数据只描述派发动作本身；
 * - Failed 结果作为正常工具输出回传（模型可自纠，02 §4.4），仅 spawn 前置校验失败
 *   （profile 名无法解析/字段非法）映射为数据级 ToolExecutionError，风格同 mcp/adapter.ts。
 */
import { z } from "zod";
import { subagentProfileInlineSchema } from "@raincode/shared";
import type { SubagentProfileInline, SubagentProfileSummary } from "@raincode/shared";
import { ToolExecutionError } from "@raincode/tools";
import type { Tool, ToolExecutionContext, ToolOutput } from "@raincode/tools";
import { errorMessage } from "../turn/round-helpers.js";
import type { SubagentHandle, SubagentManager, SubagentResult } from "./manager.js";
import { DEFAULT_SUBAGENT_MAX_TURNS, SubagentProfileError } from "./profile.js";
import type { SubagentProfile } from "./profile.js";

const agentToolParamsSchema = z.object({
  profile: z.union([z.string().min(1), subagentProfileInlineSchema]),
  task: z.string().min(1),
});
type AgentToolInput = z.infer<typeof agentToolParamsSchema>;

export interface CreateAgentToolOptions {
  manager: SubagentManager;
  /** profile 清单（工具 description 动态生成名字+description 列表；server 扫描目录后注入）。 */
  profileCatalog: () => SubagentProfileSummary[];
  /** 按名解析 profile（server 实现目录解析；SubagentProfileError → 数据级 TOOL_* 错误）。 */
  resolveProfile: (name: string) => SubagentProfile;
}

/** 创建 `agent` 工具（注册进主会话工具集，source="builtin"）。 */
export function createAgentTool(options: CreateAgentToolOptions): Tool<AgentToolInput, SubagentResult> {
  const { manager, profileCatalog, resolveProfile } = options;
  return {
    name: "agent",
    // 每次列工具时现取 profile 清单（注册后新增 profile 无需重建工具）
    get description() {
      const list = profileCatalog().map((p) => `- ${p.name}：${p.description}`);
      return [
        "把独立子任务派发给子代理（subagent）执行：子代理拥有独立上下文与受限工具集，复用同一 turn 内核，最终结论回传本会话。",
        "适用场景：上下文隔离的大范围检索、批量修改、独立验证等可自包含描述的子任务；task 必须自包含（子代理看不到主会话历史）。",
        "层级固定为 2：子代理不能再派发子代理。",
        "可用 profile：",
        ...(list.length > 0 ? list : ["- （当前无已注册 profile，可用内联对象自定义 name/description）"]),
      ].join("\n");
    },
    parametersSchema: agentToolParamsSchema,
    metadata: {
      // 工具自身无副作用：子会话内工具各自走同一权限链判定（02 §4.4）
      readOnly: true,
      destructive: false,
      sideEffectScope: "none",
      riskLevel: "low",
      needsApproval: false,
    },
    async execute(input, ctx: ToolExecutionContext): Promise<ToolOutput<SubagentResult>> {
      let profile: SubagentProfile;
      try {
        profile =
          typeof input.profile === "string" ? resolveProfile(input.profile) : inlineToProfile(input.profile);
      } catch (reason: unknown) {
        if (reason instanceof SubagentProfileError) {
          throw new ToolExecutionError(reason.code, reason.message);
        }
        throw new ToolExecutionError("TOOL_INTERNAL", `profile 解析失败：${errorMessage(reason)}`);
      }
      // parentSessionId = 当前主会话（ctx.sessionKey 即 loop.sessionId）：子会话回链与归属过滤（02 §4.1）
      const handle = await manager.spawn(profile, input.task, { parentSessionId: ctx.sessionKey });
      // 级联取消（S5）：主会话取消 → 停止子代理（02 §4.4）；正常终态后解除监听防泄漏
      const onAbort = (): void => {
        void manager.stop(handle.id, { reason: "parent-cancelled" });
      };
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      try {
        const result = await handle.result();
        return { data: result, content: formatResult(handle, result) };
      } finally {
        ctx.signal.removeEventListener("abort", onAbort);
      }
    },
  };
}

/** 内联 profile → 解析后形态：schema 已校验；maxTurns 补默认 20；内联无正文，systemPrompt 置空。 */
function inlineToProfile(inline: SubagentProfileInline): SubagentProfile {
  return {
    name: inline.name,
    description: inline.description,
    ...(inline.tools !== undefined && { tools: inline.tools }),
    ...(inline.model !== undefined && { model: inline.model }),
    maxTurns: inline.maxTurns ?? DEFAULT_SUBAGENT_MAX_TURNS,
    systemPrompt: "",
  };
}

/** 工具输出文本（完成通知正文；Failed 亦为正常输出回传，模型可自纠）。summary 居首行：
 * tool_call.completed.contentPreview 取首行投影（agent-core tool-phase previewOf），结论需在首行可见。 */
function formatResult(handle: SubagentHandle, result: SubagentResult): string {
  return [
    result.summary,
    `[subagent ${handle.id} ${handle.profileName}] status=${result.status}`,
    `usage=inputTokens:${String(result.usage.inputTokens)},outputTokens:${String(result.usage.outputTokens)} turnsUsed=${String(result.turnsUsed)}`,
  ].join("\n");
}
