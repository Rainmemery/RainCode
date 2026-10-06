/**
 * SessionTurnLoop 装配选项（从 turn-loop.ts 拆出，单文件 ≤500 行治理；04 §2.4 依赖经端口注入）。
 * 纯类型文件：无运行时行为。
 */
import type { MessageRecord } from "@raincode/shared";
import type { BackgroundTaskRegistry } from "@raincode/tools";
import type { CompactionOptions } from "../compact/service.js";
import type { HooksPort } from "../hooks/types.js";
import type { LlmPort, SessionEventPublisher, StoragePort, ToolPhaseDeps } from "../ports.js";
import type { McpToolCatalogPort } from "./mcp-catalog.js";

export interface SessionTurnLoopOptions {
  sessionId: string;
  /** 协作模式（checkpoint state 透传；权限判定链属后续波次）。 */
  mode: "normal" | "plan" | "auto-accept";
  /** null = 未配置 Provider（turn 以 LLM_NOT_CONFIGURED 失败收束）。 */
  llm: LlmPort | null;
  storage: StoragePort;
  publish: SessionEventPublisher;
  systemPrompt?: string;
  /** 逐 turn 系统提示提供者（T4.4：技能目录 digest 热变更重发布；优先于静态 systemPrompt）。 */
  systemPromptProvider?: () => Promise<string | undefined>;
  /** resume 场景的既有历史（内存态重建，server 从 JSONL 重放取得）。 */
  initialHistory?: MessageRecord[];
  /** resume 场景的 rpc 事件 seq 续起点（best-effort，见 server 侧注释）。 */
  initialEventSeq?: number;
  /** resume 场景的压缩代次起点（文件内最大 epoch；auto-compact epoch 单调合并基准）。 */
  initialEpoch?: number;
  deltaFlushMs?: number;
  /** 诊断出口（server 注入 stderr；默认 console.error）。 */
  onDiagnostic?: (message: string, err?: unknown) => void;
  /** 工具系统（本波注入；缺省保持 walking-skeleton 行为：模型发工具调用即失败收束）。 */
  tools?: ToolPhaseDeps & { background: BackgroundTaskRegistry };
  /** 工具执行 ctx 基准（workspace 越界校验 + bash cwd；缺省 process.cwd()）。 */
  workspaceRoot?: string;
  /** workspaceHash（权限判定链第 4 级 project 规则的判定域；缺省空串=无 project 规则域）。 */
  workspaceId?: string;
  /** turn 内模型轮次上限（02 §1.2.1：默认 32）。 */
  maxRoundsPerTurn?: number;
  /** auto-compact 选项（02 §1.2.5；缺省 = 不启用压缩）。 */
  compaction?: CompactionOptions;
  compactionOnBeforeReplace?: (prefix: MessageRecord[]) => Promise<void>; // 02 §7.2 compact 记忆抽取钩子（透传 CompactionDeps.onBeforeReplace）
  /** hooks 生命周期端口（T5.1；缺省 = 未装配，全部 no-op 零事件）。 */
  hooks?: HooksPort;
  /** MCP 工具目录端口（T5.6；缺省 = 目录模式未装配，MCP 工具全量 schema 照旧投影）。 */
  mcpToolCatalog?: McpToolCatalogPort;
}
