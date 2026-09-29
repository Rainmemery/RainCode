/**
 * ToolDomain：tool 域 P0 4 方法（06-api-spec §2.7：tools.list + 后台任务 list/kill/output）。
 * tool.call（受限直接调用）属 P1 不在本波；handler 为 registry/background 的薄委托。
 */
import type {
  ToolBackgroundKillParams,
  ToolBackgroundOutputParams,
  ToolToolsListParams,
} from "@raincode/shared";
import type { BackgroundTaskRegistry, ToolRegistry } from "@raincode/tools";

export class ToolDomain {
  constructor(private readonly deps: { registry: ToolRegistry; background: BackgroundTaskRegistry }) {}

  /** 方法表接线（agent-service buildMethods 展开；schema 校验由 METHOD_SCHEMAS 单点承担）。 */
  methods(register: (method: string, handler: (params: unknown) => Promise<unknown>) => unknown): Record<string, unknown> {
    return {
      "tool.tools.list": register("tool.tools.list", async (params) => {
        const p = params as ToolToolsListParams;
        return { tools: this.deps.registry.list(p.source !== undefined ? { source: p.source } : undefined) };
      }),
      // 会话级过滤随任务归属波次补齐（registry 当前全局共享，02 §5.3）
      "tool.background.list": register("tool.background.list", async () => ({
        tasks: this.deps.background.list(),
      })),
      "tool.background.kill": register("tool.background.kill", async (params) =>
        this.deps.background.kill((params as ToolBackgroundKillParams).taskId)),
      "tool.background.output": register("tool.background.output", async (params) => {
        const p = params as ToolBackgroundOutputParams;
        return this.deps.background.readOutput(p.taskId, p.tail !== undefined ? { tail: p.tail } : undefined);
      }),
    };
  }
}
