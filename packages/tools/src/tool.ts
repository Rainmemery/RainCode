/**
 * 工具契约（02-module-design §2.3 对外接口）。
 *
 * - Tool：name / description / zod parametersSchema / 声明式 metadata / execute；
 * - ToolExecutionContext：signal（贯穿取消）、workspaceRoot（路径校验基准）、cwd、sessionKey、onProgress；
 * - 工具自身只产出 ToolOutput；统一 ToolResult（含裁剪/时长/错误码）由 ToolExecutor 组装。
 * - 权限判定不属于本包（02 §2.1：三态判定在 permission 侧，本系统只消费其结果）。
 */
import type { z } from "zod";
import type { ToolErrorCode, ToolMetadata } from "@raincode/shared";
import type { BackgroundTaskRegistry } from "./sandbox/background.js";
import type { PathPolicyHook } from "./path-guard.js";

/** 工具来源（02 §2.3：builtin | mcp | plugin；MCP 工具名形如 mcp__<serverKey>__<toolName>）。 */
export type ToolSource = "builtin" | "mcp" | "plugin";

export type { ToolErrorCode, ToolMetadata };

/** 长耗时工具的进度输出（tool_call.progress 事件数据源；上游负责节流，06 §3.4）。 */
export interface ToolProgressEvent {
  stream: "stdout" | "stderr" | "generic";
  text: string;
}

// ---------------------------------------------------------------------------
// ask_user_question 通道（T2.7 P1；02 §1.4 L322 简化落地：等答与权限审批同构）
// ---------------------------------------------------------------------------

/** ask_user_question 提问请求（execute 由 ctx 填充会话归属；通道实现据此路由审批单）。 */
export interface AskUserRequest {
  question: string;
  choices?: string[];
  /** 会话键（turn 路径 = sessionId；审批单归属域）。 */
  sessionId: string;
}

/**
 * 应答形态：正常文本应答；或 cancelled（deny/超时/空应答——工具侧收敛为 TOOL_PERMISSION_DENIED）。
 * 偏差注记（交付报告申报）：02 L322 原设计为 T14 收束 turn（awaiting_user）+ session.control/respond
 * 开新 turn 续答；本实现复用审批闭环，应答即工具结果在同一 turn 内续答（见 handlers/ask-user.ts）。
 */
export type AskUserAnswer = { answerText: string } | { cancelled: true };

export interface ToolExecutionContext {
  /** 贯穿取消（02 §1.4 T12：中断信号广播到工具执行器）。 */
  signal: AbortSignal;
  /** 会话 workspace 根（相对路径基准 + 越界校验，见 path-guard）。 */
  workspaceRoot: string;
  /** 本次执行的当前目录（缺省 workspaceRoot；bash 进程 cwd）。 */
  cwd: string;
  /** 会话键（todo 等会话级状态隔离；缺省 "default"）。 */
  sessionKey: string;
  /** 后台任务 registry（bash runInBackground 使用；装配方注入同一单例，tool.background.* 方法共享）。 */
  background: BackgroundTaskRegistry;
  /** 越界路径放行钩子（权限层接入点，path-guard；缺省不放行）。 */
  pathPolicy?: PathPolicyHook;
  /**
   * ask_user_question 交互通道（T2.7 P1；agent-core tool-phase 从 ToolPhaseDeps 注入）。
   * 缺省 = headless/无 UI，ask_user_question 以 TOOL_UNAVAILABLE 收敛（02 §2.4 fail-safe）。
   */
  askUser?: (question: AskUserRequest) => Promise<AskUserAnswer>;
  /** 进度回调（长耗时工具周期性产出）。 */
  onProgress?: (event: ToolProgressEvent) => void;
}

export interface ToolOutput<TOutput = unknown> {
  data: TOutput;
  /** 模型可见文本；缺省由执行器按序列化规则生成（02 §2.3）。 */
  content?: string;
  /** UI 渲染辅助（diff、表格等，P1）。 */
  display?: unknown;
}

export interface Tool<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  /** 运行时校验 + JSON Schema 投影（见 json-schema.ts，后续可替换 zod-to-json-schema）。 */
  parametersSchema: z.ZodType<TInput>;
  /**
   * 原始 JSON Schema 直通（可选；MCP 工具使用——远端 inputSchema 原样作为 provider function
   * parameters，运行时校验由远端 server 承担，parametersSchema 仅保留宽松 object 形状校验）。
   */
  parametersJsonSchema?: Record<string, unknown>;
  metadata: ToolMetadata;
  execute(input: TInput, ctx: ToolExecutionContext): Promise<ToolOutput<TOutput>>;
}

/** 注册表描述符（06 §2.7 tool.tools.list 返回项；parameters 为 JSON Schema 投影对象）。 */
export interface ToolDescriptor {
  name: string;
  description: string;
  source: ToolSource;
  metadata: ToolMetadata;
  parametersSchema: Record<string, unknown>;
}

/** 工具调用请求（模型 tool_call 或受限直接调用的归一形态）。 */
export interface ToolCallRequest {
  toolCallId: string;
  toolName: string;
  args: unknown;
}

/** 统一结果格式（02 §2.3 ToolResult 逐字段一致）。 */
export interface ToolResult {
  toolCallId: string;
  toolName: string;
  /** 模型可见内容（已裁剪）。 */
  content: string;
  error?: { code: ToolErrorCode; message: string; detail?: string };
  isError: boolean;
  truncated: boolean;
  durationMs: number;
}
