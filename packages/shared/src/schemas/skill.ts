import { z } from "zod";

/**
 * skills 域（T3.4，06-api-spec §2.9）：技能与斜杠命令。
 * 技能 = markdown + frontmatter 提示词模板（`.raincode/skills/<name>.md` 双源，
 * workspace 优先；解析语义见 agent-core skills/skill.ts）。展开在 server 侧
 * （skills.invoke 提交展开后文本起 turn），保证 CLI / 桌面端同语义。
 * 本域无新事件（turn 事件流与 session.send 完全一致），无新 capability
 * （端层经方法探测：未装配调用报 METHOD_NOT_FOUND）。
 */

/** 技能清单摘要（skills.list 项；frontmatter 投影，不含模板正文）。 */
export const skillSummarySchema = z.object({
  name: z.string(),
  description: z.string(),
  source: z.enum(["workspace", "global"]),
  /** 参数形状提示（如 "<file>"；缺省无参技能）。 */
  argumentHint: z.string().optional(),
  /** 模型侧可调用开关（T4.4，v1.10；缺省 true）——仅约束模型经 skill 工具的调用，斜杠命令不受限。 */
  modelInvocable: z.boolean(),
});
export type SkillSummary = z.infer<typeof skillSummarySchema>;

export const skillsListParamsSchema = z.strictObject({
  /** 提供时含该会话 workspace 层技能目录（storage.workspaceRootOf 解析）；缺省仅 global 层。 */
  sessionId: z.string().optional(),
});
export type SkillsListParams = z.infer<typeof skillsListParamsSchema>;

export const skillsListResultSchema = z.object({
  items: z.array(skillSummarySchema),
});
export type SkillsListResult = z.infer<typeof skillsListResultSchema>;

export const skillsInvokeParamsSchema = z.strictObject({
  sessionId: z.string(),
  /** 技能名（[a-z0-9-]+，即斜杠命令名）。 */
  name: z.string().min(1),
  /** 调用参数（斜杠命令名后的其余文本，缺省无参）。 */
  arguments: z.string().optional(),
});
export type SkillsInvokeParams = z.infer<typeof skillsInvokeParamsSchema>;

/** 受理即返，与 session.send 同形（turn 事件流一致，端层复用同一渲染管线）。 */
export const skillsInvokeResultSchema = z.object({
  turnId: z.string(),
  admission: z.enum(["started", "queued"]),
  queuePosition: z.number().int().min(1).optional(),
});
export type SkillsInvokeResult = z.infer<typeof skillsInvokeResultSchema>;
