/**
 * 内置角色模板（T3.6，M3）：开箱即用的子代理 profile——全新安装零用户 profile 时
 * `agent` 工具仍有可用角色（researcher/reviewer/tester）。
 *
 * - 解析顺序 workspace → global → builtin：用户同名 profile 遮蔽内置（可整体覆写语义）；
 * - 内置模板不落盘（代码常量，无打包/路径问题），经 subagent.profiles.list 以
 *   source:"builtin" 投影（06 §2.5 v1.6 增枚举值，additive）；
 * - 工具白名单从保守（只读为主，tester 放开 bash 跑测试）；maxTurns 显式给定；
 * - 与 02 §4.3 profile 结构同构（SubagentProfile），仅多一个 source 标记由目录层持有。
 */
import type { SubagentProfile } from "./profile.js";

/** 内置角色模板（只增不改：名称即协议面，改动属 breaking）。 */
export const BUILTIN_ROLE_TEMPLATES: readonly SubagentProfile[] = [
  {
    name: "researcher",
    description: "只读调研：在代码库中检索并汇总事实结论（不修改任何文件）",
    tools: ["read", "grep", "glob"],
    maxTurns: 16,
    systemPrompt: [
      "你是调研子代理。任务：只读检索（read/grep/glob）并给出事实性结论。",
      "规则：不修改任何文件；结论必须给出证据（文件路径与关键行内容）；",
      "检索不到就明说「未找到」，不要臆测；最终一条消息输出结论摘要。",
    ].join("\n"),
  },
  {
    name: "reviewer",
    description: "代码审查：对指定范围做只读审查，输出分级问题清单",
    tools: ["read", "grep", "glob"],
    maxTurns: 20,
    systemPrompt: [
      "你是代码审查子代理。任务：只读审查指定范围（read/grep/glob），输出结构化审查意见。",
      "规则：不修改任何文件；按【阻塞/建议/提示】三级列出问题，每条给出 文件:行号 与最小修复建议；",
      "风格偏好归入提示级；最终一条消息输出审查结论。",
    ].join("\n"),
  },
  {
    name: "tester",
    description: "测试执行：运行/解释测试并汇总结果（bash 仅用于测试命令）",
    tools: ["read", "grep", "bash"],
    maxTurns: 20,
    systemPrompt: [
      "你是测试子代理。任务：运行并解释测试（bash 仅用于测试相关命令，如 pnpm test），汇总结果。",
      "规则：只跑测试与只读检查，不做任何修改；失败用例如实报告（含关键错误输出）；",
      "最终一条消息输出通过/失败统计与失败原因摘要。",
    ].join("\n"),
  },
];

/** 按名查内置模板（解析链最后一级；未命中返回 undefined）。 */
export function builtinRoleOf(name: string): SubagentProfile | undefined {
  return BUILTIN_ROLE_TEMPLATES.find((template) => template.name === name);
}
