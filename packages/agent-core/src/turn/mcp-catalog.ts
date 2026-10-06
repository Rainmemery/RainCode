/**
 * MCP 工具目录化的 turn 侧机制（T5.6；07-dev-plan §11.2，MiMo mcp-tool-search 参照形态）：
 *
 * - 目录模式生效时，MCP 工具完整参数 schema 不再全量进模型载荷——载荷 = 非 MCP 工具 +
 *   `mcp_tool_search`（description 承载预算化目录摘要，MiMo S2 形态）+ 已激活 MCP 工具；
 * - 请求域激活（S3）：搜索命中自**下一轮**起可按名调用，新 turn（round===1）重置激活集，
 *   目录 digest 变化整体失效（热变更重发布，server 侧负责诊断）；单请求累计激活有界（32）；
 * - 激活重导出不信任模型可见输出：turn-loop 以同索引对搜索调用**确定性重导出**登记，
 *   digest 一致方为有效（S4：同轮并行 search+MCP 调用中后者在调度期被守卫拒绝）；
 * - 调度守卫由 tool-phase 消费（eligibility）：未激活 `mcp__*` 调用 → TOOL_MCP_NOT_LOADED，
 *   先于 zod/hook/permission（未在载荷中声明的调用无需进入审批闭环）。
 *
 * 目录本体与 BM25 索引在 server（mcp-tool-catalog.ts）；本模块只消费 McpToolCatalogPort。
 */
import type { LlmFunctionTool } from "@raincode/llm";
import type { ToolResult } from "@raincode/shared";
import { MCP_TOOL_SEARCH_MAX_LIMIT, MCP_TOOL_SEARCH_NAME, type ToolRegistry } from "@raincode/tools";
import { parseLooseJson, toLlmFunctionTools } from "./round-helpers.js";

/** 目录快照（server McpToolCatalog 每轮现取；digest 变化 = 目录热变更）。 */
export interface McpToolCatalogSnapshot {
  /** 目录指纹（sha256 前 12 位，T4.4 同款短摘要）。 */
  digest: string;
  /** 目录渲染文本（预算降级已应用）——mcp_tool_search 的模型可见 description。 */
  description: string;
  /** 目录条目（激活成员校验域；name 唯一、字典序确定）。 */
  entries: ReadonlyArray<{ name: string; description: string }>;
}

/** 目录检索结果（与 tools 包 McpToolSearchChannel 结果同构；agent-core 端口保持独立声明）。 */
export type McpToolCatalogSearchResult =
  | { ok: true; digest: string; matches: Array<{ name: string; description: string; score: number }> }
  | { ok: false; code: string; message: string };

/** MCP 工具目录端口（server McpToolCatalog 结构化满足；缺省 = 目录模式未装配，全量投影照旧）。 */
export interface McpToolCatalogPort {
  /** 当前目录快照；null = 目录模式未生效（未启用或无生效 MCP 工具）。 */
  snapshot(): McpToolCatalogSnapshot | null;
  /** BM25 检索（处理器通道与激活重导出共用同一索引，同输入必得同输出）。 */
  search(query: string, limit?: number): Promise<McpToolCatalogSearchResult>;
}

/** 单请求（turn）累计激活上限（MiMo S3「加载有界总量」；与单次检索上限 32 同口径申报）。 */
const MAX_ACTIVATED_PER_REQUEST = 32;

/** 目录模式载荷：非 MCP 工具（检索工具换目录摘要 description）+ 已激活 MCP 工具。 */
export function toCatalogedLlmFunctionTools(
  registry: ToolRegistry,
  catalog: McpToolCatalogSnapshot,
  activated: ReadonlySet<string>,
): LlmFunctionTool[] {
  const out: LlmFunctionTool[] = [];
  for (const descriptor of registry.list()) {
    if (descriptor.source === "mcp") {
      // 未激活 MCP 工具不进载荷：schema 私有，由目录摘要 + mcp_tool_search 检索激活代替
      if (activated.has(descriptor.name)) {
        out.push({
          type: "function",
          function: {
            name: descriptor.name,
            description: descriptor.description,
            parameters: descriptor.parametersSchema,
          },
        });
      }
      continue;
    }
    out.push({
      type: "function",
      function: {
        name: descriptor.name,
        // 目录模式：检索工具 description 承载目录摘要（非目录模式该工具自载荷剔除）
        description: descriptor.name === MCP_TOOL_SEARCH_NAME ? catalog.description : descriptor.description,
        parameters: descriptor.parametersSchema,
      },
    });
  }
  return out;
}

/**
 * 单循环实例的目录状态机（SessionTurnLoop 持有）：payloadFor（每轮载荷 + digest 失效）+
 * eligibility（调度守卫）+ captureSearches（激活重导出）。激活集生命周期 = 单个 turn
 * （请求域），round===1 视为新用户请求起点整体重置。
 */
export class McpRequestCatalog {
  private digest: string | null = null;
  private readonly activated = new Set<string>();

  /**
   * 每轮模型载荷：目录模式未生效 → 全量投影（仅剔除无用武之地的检索工具，MCP schema 照旧）；
   * 生效 → 目录化载荷。round===1 重置请求域激活（MiMo S3「新用户消息重置加载」）。
   */
  payloadFor(
    port: McpToolCatalogPort | undefined,
    registry: ToolRegistry | undefined,
    round: number,
  ): LlmFunctionTool[] | undefined {
    if (registry === undefined) return undefined;
    if (round === 1) {
      this.activated.clear();
      this.digest = null;
    }
    const catalog = port?.snapshot() ?? null;
    if (catalog === null) {
      this.activated.clear();
      this.digest = null; // 目录失效（全断连/关闭）：守卫同步解除，回退全量投影
      return toLlmFunctionTools(registry).filter((tool) => tool.function.name !== MCP_TOOL_SEARCH_NAME);
    }
    if (catalog.digest !== this.digest) {
      // 目录热变更：已加载集整体失效（重发布诊断由 server 侧 digest 变更时输出）
      this.activated.clear();
      this.digest = catalog.digest;
    }
    return toCatalogedLlmFunctionTools(registry, catalog, this.activated);
  }

  /** 调度期守卫（tool-phase ctx 注入；目录模式未生效返回 undefined = 不设防）。 */
  eligibility(): ((toolName: string) => string | undefined) | undefined {
    if (this.digest === null) return undefined;
    return (toolName: string) => {
      if (!toolName.startsWith("mcp__") || this.activated.has(toolName)) return undefined;
      return (
        `tool not loaded for this request: ${toolName} — call ${MCP_TOOL_SEARCH_NAME} ` +
        "with matching keywords first, then invoke it on the next round"
      );
    };
  }

  /**
   * 激活重导出（tool-phase 收敛后调用）：对本轮成功的 mcp_tool_search 调用，以同索引重导出
   * 命中并登记（不解析模型可见 content）；digest 与载荷轮不一致 → 目录已变更，激活作废。
   */
  async captureSearches(
    port: McpToolCatalogPort | undefined,
    calls: ReadonlyArray<{ toolCallId: string; toolName: string; argumentsJSON: string }>,
    results: ReadonlyArray<ToolResult>,
  ): Promise<void> {
    if (port === undefined || this.digest === null) return;
    for (const call of calls) {
      if (call.toolName !== MCP_TOOL_SEARCH_NAME) continue;
      const result = results.find((item) => item.toolCallId === call.toolCallId);
      if (result === undefined || result.isError) continue;
      const args = parseLooseJson(call.argumentsJSON);
      if (typeof args !== "object" || args === null || typeof (args as { query?: unknown }).query !== "string") continue;
      const query = (args as { query: string }).query;
      const rawLimit = (args as { limit?: unknown }).limit;
      const limit =
        typeof rawLimit === "number" && Number.isInteger(rawLimit) && rawLimit >= 1
          ? Math.min(rawLimit, MCP_TOOL_SEARCH_MAX_LIMIT)
          : undefined;
      const [search, snapshot] = [await port.search(query, limit), port.snapshot()];
      if (!search.ok || search.digest !== this.digest || snapshot === null || snapshot.digest !== this.digest) continue;
      const members = new Set(snapshot.entries.map((entry) => entry.name));
      for (const match of search.matches) {
        if (this.activated.size >= MAX_ACTIVATED_PER_REQUEST) break;
        if (members.has(match.name)) this.activated.add(match.name);
      }
    }
  }
}
