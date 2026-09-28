/**
 * MemoryRuntime：memory 域装配（06-api-spec §2.6 / 02-module-design §7）。
 *
 * - ProjectMemoryService 组装（04-architecture ADR-06：server 是唯一组装点）：
 *   MEMORY.md 文件真源 + memory_entries 抽取/召回；抽取的模型调用经 MemoryExtractPort
 *   端口注入（04 §2.2：memory 不可直接依赖 llm），本文件以 LLM 实现该端口；
 * - memory 域 5 协议方法（06 §2.6），形态对齐 mcp-runtime.methods；MemoryError →
 *   RpcCallError 统一映射（06 §4.3 段 6 业务码，风格同 mcp/subagent 错误映射）；
 * - memoryLoopEnhancements / onArchive：MEMORY.md 系统提示注入（04 L86）与会话结束 /
 *   compact 抽取钩子（02 §7.2/§7.4）；未装配（AgentServiceOptions.memory 缺省）时
 *   不注册方法、不注入 MEMORY.md、不挂抽取钩子。
 */
import { RpcCallError } from "@novacode/rpc";
import { memoryKindSchema } from "@novacode/shared";
import type {
  MemoryEntriesListParams,
  MemoryPromoteParams,
  MemoryReadParams,
  MemorySearchParams,
  MemoryWriteParams,
  MessageRecord,
} from "@novacode/shared";
import type { LlmPort } from "@novacode/agent-core";
import type { Storage } from "@novacode/storage";
import { MEMORY_TEMPLATE, MemoryError, createProjectMemoryService } from "@novacode/memory";
import type { ExtractedCandidate, MemoryExtractPort, ProjectMemoryService } from "@novacode/memory";

// ---------------------------------------------------------------------------
// LLM 抽取端口（02 §7.2：要点抽取 = 同会话模型一次调用）
// ---------------------------------------------------------------------------

/** 抽取超时（任务约定 30s；超时/网络失败 → null → 本次抽取跳过，02 §7.4）。 */
const EXTRACT_TIMEOUT_MS = 30_000;

const EXTRACT_SYSTEM_PROMPT = [
  "你是记忆抽取器：从会话记录提取值得跨会话记住的要点，只输出 JSON。",
  "kind 取值（五选一）：",
  "- decision：已经做出的决策（选型、方案、取舍）",
  "- convention：项目约定（命名规范、分支策略、提交规范、目录约定）",
  "- pitfall：踩坑记录（环境坑、依赖坑、反复出现的错误）",
  "- preference：用户偏好（沟通语言、回答风格、习惯）",
  "- todo：待办事项（未完成的任务、下一步计划）",
  "输出格式（不要输出 JSON 以外的任何文字）：",
  '{"entries":[{"kind":"decision","content":"单句要点≤200字","refs":["文件路径或会话id"],"confidence":0.0~1.0}]}',
  "没有值得记录的要点时输出：",
  '{"entries":[]}',
].join("\n");

/** 抽取响应宽容解析 + 逐条校验（截取首个 { 到末个 }；kind 复用 shared memoryKindSchema）。 */
function parseExtractResponse(text: string): ExtractedCandidate[] | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const entries = (raw as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) {
    return null;
  }
  const candidates: ExtractedCandidate[] = [];
  for (const item of entries) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const record = item as { kind?: unknown; content?: unknown; refs?: unknown; confidence?: unknown };
    // kind 用 shared schema 校验；content 非空（≤200 字截断与归一化由 settleCandidate 二次兜底）
    const kind = memoryKindSchema.safeParse(record.kind);
    if (!kind.success || typeof record.content !== "string" || record.content.trim().length === 0) {
      continue;
    }
    candidates.push({
      kind: kind.data,
      content: record.content,
      ...(Array.isArray(record.refs) && {
        refs: record.refs.filter((ref): ref is string => typeof ref === "string"),
      }),
      ...(typeof record.confidence === "number" &&
        Number.isFinite(record.confidence) && { confidence: record.confidence }),
    });
  }
  return candidates;
}

/**
 * LLM 抽取端口（02 §7.2 / 04 §2.2）：
 * LLM 不可用 / 调用失败（含 30s 超时）/ 解析失败 → null = 跳过本次抽取且不写幂等键（02 §7.4）。
 */
export function createLlmExtractPort(
  getLlm: () => LlmPort | null,
  diag: (message: string, err?: unknown) => void,
): MemoryExtractPort {
  return {
    async extract({ transcript }) {
      const llm = getLlm();
      if (llm === null) {
        return null; // 未配置 Provider：抽取跳过、会话正常结束（02 §7.4）
      }
      let text = "";
      try {
        await llm.streamChat({
          messages: [
            { role: "system", content: EXTRACT_SYSTEM_PROMPT },
            { role: "user", content: transcript },
          ],
          includeUsage: false,
          signal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS),
          onEvent: (event) => {
            if (event.type === "delta.text") {
              text += event.text;
            }
          },
        });
      } catch (reason: unknown) {
        diag("memory extract llm call failed; skipped", reason);
        return null;
      }
      const candidates = parseExtractResponse(text);
      if (candidates === null) {
        diag("memory extract response parse failed; skipped");
      }
      return candidates;
    },
  };
}

/** MemoryError → RpcCallError 业务码映射（06 §4.3 段 6；风格同 mcp-runtime.mapMcpError）。 */
export function mapMemoryError(err: unknown): unknown {
  if (err instanceof MemoryError) {
    return new RpcCallError(err.code, err.message);
  }
  return err;
}

// ---------------------------------------------------------------------------
// MemoryRuntime（memory 域装配）
// ---------------------------------------------------------------------------

/** memory 域装配依赖（agent-service 注入；风格对齐 McpRuntimeOptions）。 */
export interface MemoryRuntimeOptions {
  storage: Storage;
  /** LLM 解析（02 §7.2 抽取用同会话模型）；null = 未配置 Provider → 抽取跳过。 */
  llmFor: () => LlmPort | null;
  /** 实例绑定 workspace 根（promote 反查兜底域；缺省经 storage.workspaceRootByHash）。 */
  workspaceRoot?: string;
  /** 诊断出口（缺省 console.error，风格同 mcp-runtime）。 */
  onDiagnostic?: (message: string, err?: unknown) => void;
}

/** 会话循环装配增量（memoryLoopEnhancements 返回，agent-service 展开进 createSessionLoop）。 */
export interface MemoryLoopEnhancements {
  systemPrompt?: string;
  compactionOnBeforeReplace?: (prefix: MessageRecord[]) => Promise<void>;
}

export class MemoryRuntime {
  private currentWorkspaceId: string | null = null;
  /** memory 域服务门面（协议方法与抽取钩子共用）。 */
  readonly service: ProjectMemoryService;

  constructor(private readonly options: MemoryRuntimeOptions) {
    this.service = createProjectMemoryService({
      storage: options.storage,
      extractPort: createLlmExtractPort(options.llmFor, (message, err) => this.diag(message, err)),
      ...(options.workspaceRoot !== undefined && { workspaceRoot: options.workspaceRoot }),
    });
  }

  /** workspace 上下文登记（memory.search / memory.entries.list 判定域；由 memoryLoopEnhancements 调用）。 */
  setCurrentWorkspace(workspaceId: string): void {
    this.currentWorkspaceId = workspaceId;
  }

  /**
   * 会话结束抽取（archive 钩子，02 §7.4）：归档前取 history 全量抽取；
   * 失败仅诊断、不阻塞归档；幂等由 settings 键 memory.extracted.<sessionId> 保证（05 §5.4 末行）。
   */
  async onArchive(sessionId: string, workspaceId: string): Promise<void> {
    try {
      const replay = await this.options.storage.resumeSession(sessionId);
      await this.service.extractFromSession({
        sessionId,
        workspaceId,
        transcript: replay.history,
        source: "session-end",
      });
    } catch (reason: unknown) {
      this.diag("memory extract (session-end) skipped; archive continues", reason);
    }
  }

  /** 控制面方法表（06 §2.6 memory 域 5 方法；形态对齐 mcp-runtime.methods）。 */
  methods(register: (method: string, handler: (params: unknown) => Promise<unknown>) => unknown): Record<string, unknown> {
    return {
      "memory.read": register("memory.read", async (params) => {
        const { workspaceRoot } = params as MemoryReadParams;
        return this.service.loadProjectMemory(workspaceRoot);
      }),
      "memory.write": register("memory.write", async (params) => {
        const { workspaceRoot, section, content } = params as MemoryWriteParams;
        try {
          await this.service.writeAgentSection(workspaceRoot, section, content);
          return { updated: true };
        } catch (reason: unknown) {
          throw mapMemoryError(reason); // MEMORY_SECTION_FORBIDDEN / MEMORY_WRITE_CONFLICT（06 §2.6）
        }
      }),
      "memory.search": register("memory.search", async (params) => {
        const { query, kind, limit } = params as MemorySearchParams;
        return { entries: await this.service.search(this.requireWorkspaceId(), query, { kind, limit }) };
      }),
      "memory.entries.list": register("memory.entries.list", async (params) => {
        const { kind, source, since, page } = params as MemoryEntriesListParams;
        // page.cursor/limit 拆平（06 §2.6 params 投影）；workspaceId 用当前 workspace 上下文
        return this.service.listEntries(this.requireWorkspaceId(), {
          kind,
          source,
          since,
          ...(page?.cursor !== undefined && { cursor: page.cursor }),
          ...(page?.limit !== undefined && { limit: page.limit }),
        });
      }),
      "memory.promote": register("memory.promote", async (params) => {
        const { entryId, section } = params as MemoryPromoteParams;
        try {
          await this.service.promote(entryId, section);
          return { promoted: true };
        } catch (reason: unknown) {
          throw mapMemoryError(reason); // MEMORY_ENTRY_NOT_FOUND（06 §2.6）
        }
      }),
    };
  }

  /** 优雅停机（与 McpRuntime/SubagentRuntime 的 shutdown 接线风格一致）：无长驻资源，最小实现。 */
  async dispose(): Promise<void> {
    this.currentWorkspaceId = null; // 会话上下文随服务关闭释放
  }

  private requireWorkspaceId(): string {
    if (this.currentWorkspaceId === null) {
      throw new RpcCallError("INVALID_PARAMS", "no workspace context: create or resume a session first");
    }
    return this.currentWorkspaceId;
  }

  private diag(message: string, err?: unknown): void {
    const sink =
      this.options.onDiagnostic ??
      ((text: string, error?: unknown) => console.error(`[novacode/server] ${text}`, error ?? ""));
    sink(message, err);
  }
}

// ---------------------------------------------------------------------------
// 会话装配增量（agent-service.createSession / resume 共用）
// ---------------------------------------------------------------------------

/** 注入标题行（说明文件来源与 Agent 专用章节边界，02 §7.1/§7.3）。 */
const MEMORY_INJECTION_HEADER =
  "# 项目记忆（MEMORY.md，用户与 Agent 共同维护；'当前进行'/'Agent 备忘'为 Agent 专用章节）";

/**
 * MEMORY.md 系统提示注入（04-architecture L86 / 02 §7.4 / ADR-06 唯一组装点，agent-core 零感知）：
 * - memory 未装配 → 原样透传 base systemPrompt（可能 undefined）；
 * - MEMORY.md 不存在/为空 → 注入模板骨架（空章节说明，02 §7.4）——统一注入；
 * - 拼接格式：base + 空行分隔 + 标题行 + 文件全文；
 * - 顺带登记 workspace 上下文（memory.search/entries.list 判定域），并挂 compact 抽取钩子
 *   （02 §7.2：抽取先于历史替换、以快照 prefix 为准；失败由 compact 侧捕获不阻塞提交）。
 */
export async function memoryLoopEnhancements(
  memory: MemoryRuntime | null,
  baseSystemPrompt: string | undefined,
  workspaceRoot: string,
  sessionId: string,
  workspaceId: string,
): Promise<MemoryLoopEnhancements> {
  if (memory === null) {
    return { ...(baseSystemPrompt !== undefined && { systemPrompt: baseSystemPrompt }) };
  }
  memory.setCurrentWorkspace(workspaceId);
  const snapshot = await memory.service.loadProjectMemory(workspaceRoot);
  const content = snapshot.content.trim().length > 0 ? snapshot.content : MEMORY_TEMPLATE;
  const memoryBlock = `${MEMORY_INJECTION_HEADER}\n\n${content}`;
  return {
    systemPrompt: baseSystemPrompt !== undefined ? `${baseSystemPrompt}\n\n${memoryBlock}` : memoryBlock,
    compactionOnBeforeReplace: async (prefix: MessageRecord[]): Promise<void> => {
      // 抽取结果（新增条目）在此无需回传；幂等与去重由 service 内部收敛（02 §7.4）
      await memory.service.extractFromSession({ sessionId, workspaceId, transcript: prefix, source: "compact" });
    },
  };
}
