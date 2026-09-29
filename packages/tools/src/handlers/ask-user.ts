/**
 * ask_user_question 工具（T2.7 P1；02-module-design §2.3 清单 / §1.4 L322「向用户提出结构化问题
 * 并挂起等答」的简化落地）。
 *
 * 偏差注记（交付报告申报）：02 L322 原设计为「T14 收束当前 turn（结果标记 awaiting_user）；
 * 应答经 session.control/respond 开新 turn 续答」——T14 awaiting_user 状态机改动大；本实现
 * 复用权限审批闭环（ApprovalBroker 单消费/超时 deny/事件持久化），等答与审批挂起同构：
 * 工具挂起等待 → 用户应答作为工具结果回传 → 同一 turn 内续答（应答经 permission.respond 的
 * answerText 传输，06 §2.2 capability: permission.respond.answer）。审批放行语义（allow/deny）
 * 不适用于提问本身：metadata needsApproval=false（等答走 askUser 通道，不进五级判定链）。
 *
 * fail-safe（02 §2.4）：ctx.askUser 缺省（headless/无 UI）→ TOOL_UNAVAILABLE；用户拒绝/超时
 * （broker 120s 默认）→ { cancelled } → TOOL_PERMISSION_DENIED。
 */
import { z } from "zod";
import { TOOL_ERROR_CODES } from "@raincode/shared";
import type { Tool, ToolOutput, ToolExecutionContext } from "../tool.js";
import { ToolExecutionError } from "../executor.js";

export interface AskUserInput {
  question: string;
  choices?: string[];
}

export interface AskUserOutput {
  answer: string;
  choices?: string[];
}

export const askUserTool: Tool<AskUserInput, AskUserOutput> = {
  name: "ask_user_question",
  description:
    "Ask the user a single question and wait for their answer. " +
    "Optionally provide up to 6 short choices; the user may also reply with free text. " +
    "Use sparingly: only when a decision cannot be inferred from context. " +
    "The answer text is returned as the tool result.",
  parametersSchema: z.object({
    question: z.string().min(1).describe("The question to ask the user (single question)"),
    choices: z
      .array(z.string().min(1))
      .min(1)
      .max(6)
      .optional()
      .describe("Up to 6 selectable options; free-text answers are also accepted"),
  }),
  metadata: {
    readOnly: true,
    destructive: false,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  async execute(
    input: AskUserInput,
    ctx: ToolExecutionContext,
  ): Promise<ToolOutput<AskUserOutput>> {
    // questions[] 多问扩展为后续波次（单问题最小实现，02 §2.3 清单参数形态的收敛子集）
    if (ctx.askUser === undefined) {
      throw new ToolExecutionError(
        TOOL_ERROR_CODES.UNAVAILABLE,
        "ask_user_question 需要交互通道（当前环境无 UI 客户端）",
      );
    }
    const answer = await ctx.askUser({
      question: input.question,
      ...(input.choices !== undefined && { choices: input.choices }),
      sessionId: ctx.sessionKey,
    });
    if ("cancelled" in answer) {
      throw new ToolExecutionError(TOOL_ERROR_CODES.PERMISSION_DENIED, "用户未应答（拒绝或等待超时）");
    }
    return {
      data: {
        answer: answer.answerText,
        ...(input.choices !== undefined && { choices: input.choices }),
      },
      // 应答即工具结果参与下轮模型请求；命中选项时附 choice 前缀语义由模型自读
      content: answer.answerText,
    };
  },
};
