/**
 * skill 工具（T4.4 模型侧可发现性；01-PRD TL-6 实现注记 / 06-api-spec §2.9）。
 *
 * 模型经本工具调用技能，与 skills.invoke 走同一展开链路（双源解析 → modelInvocable 开关 →
 * $ARGUMENTS 模板展开，单点在 server SkillRuntime——ctx.expandSkill 通道注入，同 ask_user
 * 通道形态）；展开文本作为工具结果回传，模型在同一 turn 内按技能指令续答收束。
 * 工具调用本身走标准五级判定链（metadata 只读零副作用）与 admission 语义；斜杠命令路径
 * （skills.invoke）不受 modelInvocable 约束——开关只挡模型侧调用。
 *
 * fail-safe：ctx.expandSkill 缺省（skills 域未装配）→ TOOL_UNAVAILABLE（同 ask_user 口径）；
 * 域码投影映射：SKILL_NOT_FOUND → TOOL_INVALID_INPUT（引用了不存在的技能）、
 * SKILL_INVALID → TOOL_EXEC_FAILED（技能文件损坏）、modelInvocable=false →
 * TOOL_PERMISSION_DENIED（开关拒绝）、其余 → TOOL_INTERNAL。
 */
import { z } from "zod";
import { TOOL_ERROR_CODES } from "@raincode/shared";
import type { Tool, ToolExecutionContext, ToolOutput } from "../tool.js";
import { ToolExecutionError } from "../executor.js";

export interface SkillInput {
  name: string;
  arguments?: string;
}

export interface SkillOutput {
  /** 展开后的提示词模板（即回传给模型的 content）。 */
  expanded: string;
  skill: string;
}

export const skillTool: Tool<SkillInput, SkillOutput> = {
  name: "skill",
  description:
    "Invoke a reusable skill (a predefined prompt workflow) by name and continue with its instructions. " +
    "Available skills with descriptions are listed in your system prompt; pick the one matching the user's request. " +
    "The expanded skill template is returned as the tool result — follow it to complete the task.",
  parametersSchema: z.object({
    name: z
      .string()
      .min(1)
      .regex(/^[a-z0-9-]+$/, "skill name must match [a-z0-9-]+")
      .describe("Skill name (as listed in the system prompt catalog)"),
    arguments: z.string().optional().describe("Arguments passed to the skill template ($ARGUMENTS); omit for none"),
  }),
  metadata: {
    readOnly: true,
    destructive: false,
    sideEffectScope: "none",
    riskLevel: "low",
    // 展开只读不执行：模板仅作为回传文本，模型是否按指令行动仍受既有权限链约束
    needsApproval: false,
  },
  async execute(input: SkillInput, ctx: ToolExecutionContext): Promise<ToolOutput<SkillOutput>> {
    if (ctx.expandSkill === undefined) {
      throw new ToolExecutionError(
        TOOL_ERROR_CODES.UNAVAILABLE,
        "skill expansion unavailable: skills domain not assembled in this runtime",
      );
    }
    const result = await ctx.expandSkill({ name: input.name, arguments: input.arguments });
    if (!result.ok) {
      throw new ToolExecutionError(result.code, result.message);
    }
    return { data: { expanded: result.expanded, skill: input.name }, content: result.expanded };
  },
};
