/**
 * ToolExecutor（02-module-design §2.1/§2.3）：入参 zod 校验 → 受控执行 → 结果统一格式与预算裁剪。
 *
 * - 不决定「是否允许执行」：三态判定在 agent-core 调度阶段完成，本执行器只跑已放行的调用；
 * - 未知工具 / 入参非法 / 超时 / 取消 / 内部错误一律收敛为 isError 结果，绝不抛出（02 §2.4）；
 * - 并行规则（02 §2.2）：readOnly 工具并行执行（上限 4），有副作用的工具按模型给出顺序串行；
 *   批内任一失败不影响其余调用。
 */
import { TOOL_ERROR_CODES } from "@raincode/shared";
import type { ToolErrorCode } from "@raincode/shared";
import type {
  ToolCallRequest,
  ToolExecutionContext,
  ToolProgressEvent,
  ToolResult,
} from "./tool.js";
import type { ToolRegistry } from "./registry.js";
import { truncateToByteBudget } from "./truncate.js";
import { sandboxDenialMarker, SANDBOX_RETRY_HINT } from "./sandbox/enforcement.js";

/** 默认输出预算（02 §2.3：缺省 256KB）。 */
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
/** 默认超时（02 §5.3：timeoutMs 默认 120000，上限 600000）。 */
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
/** 单批并发上限（04 §2.1 / 任务约定：并发执行同 turn 多工具，上限 4）。 */
const MAX_CONCURRENCY = 4;
/** 模型可见内容的兜底序列化上限（无显式 content 时）。 */
const SERIALIZED_CONTENT_MAX_BYTES = 256 * 1024;

/** 工具内部可抛的业务错误：execute 可用它在结果中携带精确错误码。 */
export class ToolExecutionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = "ToolExecutionError";
  }
}

export interface ToolExecutorOptions {
  registry: ToolRegistry;
  defaultTimeoutMs?: number;
  defaultMaxOutputBytes?: number;
  /** 只读工具并发上限（02 §2.2；缺省 4，最小 1 防御）。 */
  maxConcurrency?: number;
}

export interface ToolRunContext extends ToolExecutionContext {
  /** 单调用收敛回调（tool_call.completed 事件源；agent-core 注入）。 */
  onSettled?: (result: ToolResult) => void;
  /**
   * 带调用归属的进度回调（tool_call.progress 事件源；由执行器按 toolCallId 归因，
   * 批内并行多调用时互不串扰）。
   */
  onToolProgress?: (event: ToolProgressEvent & { toolCallId: string }) => void;
}

/** 简单 FIFO 信号量（只读工具并发上限）。 */
class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => {
        this.queue.push(resolve);
      });
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.queue.shift()?.();
    }
  }
}

export class ToolExecutor {
  private readonly registry: ToolRegistry;
  private readonly defaultTimeoutMs: number;
  private readonly defaultMaxOutputBytes: number;
  private readonly limit: Semaphore;

  constructor(options: ToolExecutorOptions) {
    this.registry = options.registry;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.defaultMaxOutputBytes = options.defaultMaxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    // 并发上限从模块常量改为实例配置（缺省仍 4；Math.max(1, n) 防御非法值）
    this.limit = new Semaphore(Math.max(1, options.maxConcurrency ?? MAX_CONCURRENCY));
  }

  /** 批执行：只读并行（≤maxConcurrency，缺省 4）、写工具按调用顺序串行；全部收敛后按入参顺序返回。 */
  async runBatch(calls: ToolCallRequest[], ctx: ToolRunContext): Promise<ToolResult[]> {
    let writeChain: Promise<unknown> = Promise.resolve();
    const results = await Promise.all(
      calls.map((call) => {
        const tool = this.registry.get(call.toolName);
        if (tool !== undefined && !tool.metadata.readOnly) {
          const chained = writeChain.then(
            () => this.limit.run(() => this.execute(call, ctx)),
            () => this.limit.run(() => this.execute(call, ctx)),
          );
          writeChain = chained.then(
            () => undefined,
            () => undefined,
          );
          return chained;
        }
        return this.limit.run(() => this.execute(call, ctx));
      }),
    );
    return results;
  }

  /** 单调用执行：永不抛出（02 §2.4：失败以 isError 结果回模型，不影响其余调用）。 */
  async execute(call: ToolCallRequest, ctx: ToolRunContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const result = await this.executeInner(call, ctx);
    const final: ToolResult = { ...result, durationMs: Date.now() - startedAt };
    try {
      ctx.onSettled?.(final);
    } catch {
      // 收敛回调失败不影响结果交付
    }
    return final;
  }

  private async executeInner(
    call: ToolCallRequest,
    ctx: ToolRunContext,
  ): Promise<Omit<ToolResult, "durationMs">> {
    const tool = this.registry.get(call.toolName);
    if (tool === undefined) {
      return errorResult(call, TOOL_ERROR_CODES.UNKNOWN, `unknown tool: ${call.toolName}`);
    }

    // 1) 入参 zod 校验（02 §2.4：失败不进权限与执行，附 schema 摘要帮助模型自纠）
    const parsed = tool.parametersSchema.safeParse(call.args);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 10)
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ");
      return errorResult(
        call,
        TOOL_ERROR_CODES.INVALID_INPUT,
        `invalid input for ${call.toolName}: ${issues}`,
        issues,
      );
    }

    // 2) 受控执行：外部取消信号 + 工具级超时 贯穿同一 AbortController
    const timeoutMs = Math.min(tool.metadata.timeoutMs ?? this.defaultTimeoutMs, MAX_TIMEOUT_MS);
    const linked = new AbortController();
    let timedOut = false;
    const onExternalAbort = () => linked.abort();
    ctx.signal.addEventListener("abort", onExternalAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      linked.abort();
    }, timeoutMs);
    try {
      const output = await tool.execute(parsed.data, {
        signal: linked.signal,
        workspaceRoot: ctx.workspaceRoot,
        cwd: ctx.cwd,
        sessionKey: ctx.sessionKey,
        background: ctx.background,
        ...(ctx.pathPolicy !== undefined && { pathPolicy: ctx.pathPolicy }),
        ...(ctx.askUser !== undefined && { askUser: ctx.askUser }),
        ...(ctx.expandSkill !== undefined && { expandSkill: ctx.expandSkill }),
        ...(ctx.searchHistory !== undefined && { searchHistory: ctx.searchHistory }),
        ...(ctx.onToolProgress !== undefined && {
          onProgress: (event: ToolProgressEvent) => {
            ctx.onToolProgress?.({ ...event, toolCallId: call.toolCallId });
          },
        }),
      });
      const rawContent =
        output.content ??
        JSON.stringify(output.data ?? null, null, 0).slice(
          0,
          SERIALIZED_CONTENT_MAX_BYTES,
        );
      const maxOutputBytes = tool.metadata.maxOutputBytes ?? this.defaultMaxOutputBytes;
      const { text, truncated } = truncateToByteBudget(rawContent, maxOutputBytes);
      return {
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        content: text,
        isError: false,
        truncated,
      };
    } catch (reason: unknown) {
      return this.mapFailure(call, reason, timedOut, ctx.signal.aborted);
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onExternalAbort);
    }
  }

  private mapFailure(
    call: ToolCallRequest,
    reason: unknown,
    timedOut: boolean,
    externallyAborted: boolean,
  ): Omit<ToolResult, "durationMs"> {
    if (timedOut) {
      return errorResult(call, TOOL_ERROR_CODES.TIMEOUT, `tool ${call.toolName} timed out`);
    }
    if (externallyAborted || isAbortLike(reason)) {
      return errorResult(call, TOOL_ERROR_CODES.CANCELLED, `tool ${call.toolName} cancelled`);
    }
    if (reason instanceof ToolExecutionError) {
      return errorResult(call, reason.code as ToolErrorCode, reason.message, reason.detail);
    }
    const message = reason instanceof Error ? reason.message : String(reason);
    return errorResult(call, TOOL_ERROR_CODES.INTERNAL, message);
  }
}

function isAbortLike(reason: unknown): boolean {
  return (
    reason instanceof Error &&
    (reason.name === "AbortError" || reason.name === "TimeoutError")
  );
}

function errorResult(
  call: ToolCallRequest,
  code: ToolErrorCode,
  message: string,
  detail?: string,
): Omit<ToolResult, "durationMs"> {
  // 沙箱约束面拒绝标记（T5.2）：path-guard 是应用层预检（02 §5.1 约束非隔离），由此产生的
  // PATH_ESCAPED 一律 partial 并附同轮重试提示——与执行域是否 docker 无关（拒绝发生在投递前）。
  // 中央接线覆盖全部 guardPath 拒绝点（含未来新增处理器）；标记已存在时不重复追加。
  const finalMessage =
    code === TOOL_ERROR_CODES.PATH_ESCAPED && !message.includes("[sandbox:")
      ? `${message} ${sandboxDenialMarker()} ${SANDBOX_RETRY_HINT}`
      : message;
  const toolError: NonNullable<ToolResult["error"]> = {
    code,
    message: finalMessage,
    ...(detail !== undefined && { detail }),
  };
  return {
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    content: `${code}: ${finalMessage}`,
    error: toolError,
    isError: true,
    truncated: false,
  };
}
