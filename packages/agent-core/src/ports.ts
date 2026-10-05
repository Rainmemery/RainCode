/**
 * agent-core 端口定义（04-architecture §2.4 铁律 5：端口注入精神）。
 *
 * - LlmPort：包 @raincode/llm 的 LlmClient 结构子集（本波直接复用其请求/结果类型，接口保持薄）；
 * - StoragePort：包 @raincode/storage 的 Storage 结构子集（appendMessage / appendEvent / writeCheckpoint）；
 * - SessionEventPublisher：会话事件出口，由 server 注入（agent-core 对传输不可知，禁止 import rpc）；
 * - PermissionPort：权限三态判定的窄端口（02 §6）。真实实现由 packages/permission 注入
 *   （五级判定链 + 审批闭环在实现内部收敛）；ask 态经 evaluate 返回 grantId 后由
 *   awaitApproval 挂起等待（tool-phase 收敛点），测试实现 createMetadataPermissionPort 保留。
 *
 * 真实实现（Storage / LlmClient / PermissionService）结构化满足端口，server 装配时直接注入。
 */
import type {
  ChatCompletionStreamRequest,
  LlmStreamResult,
} from "@raincode/llm";
import type { ToolExecutor, ToolMetadata, ToolRegistry } from "@raincode/tools";
import type {
  AppendResult,
  CheckpointResult,
  CheckpointState,
} from "@raincode/storage";
import type { CollaborationMode, MessageRecord, TokenUsage } from "@raincode/shared";
import type { TurnPhase } from "./turn/phase.js";

/** 模型流式端口（@raincode/llm LlmClient 的唯一被消费方法）。 */
export interface LlmPort {
  streamChat(request: ChatCompletionStreamRequest): Promise<LlmStreamResult>;
}

/** Turn 输入（06 §2.1 session.send / session.steer 的 input 投影）。 */
export interface TurnInput {
  text: string;
  attachments?: Array<{ path: string; mediaType?: string }>;
}

/** Turn 终态（02 §1.2.1：completed / cancelled[T3/T5/T8/T12] / failed）。 */
export type TurnOutcome =
  | { status: "completed"; usage?: TokenUsage; rounds: number }
  | { status: "cancelled"; at: TurnPhase }
  | { status: "failed"; error: { code: string; message: string } };

/** submit/steer 受理结果（06 §2.1：受理即返，turn 进展全部走事件）。 */
export interface TurnAdmission {
  turnId: string;
  admission: "started" | "queued";
  queuePosition?: number;
  done: Promise<TurnOutcome>;
}

/** 持久化端口（@raincode/storage Storage 的写路径子集；历史常驻内存，恢复由 server 完成）。 */
export interface StoragePort {
  appendMessage(
    sessionId: string,
    message: MessageRecord,
    options?: { epoch?: number },
  ): Promise<AppendResult>;
  appendEvent(
    sessionId: string,
    name: string,
    payload: unknown,
    options?: { epoch?: number },
  ): Promise<AppendResult>;
  writeCheckpoint(
    sessionId: string,
    state: CheckpointState,
    options?: { epoch?: number },
  ): Promise<CheckpointResult>;
}

/** 会话事件发布器（server 注入；06-api-spec §3 数据面事件经此投递到端层）。 */
export type SessionEventPublisher = (event: { name: string; payload: unknown }) => void;

// ---------------------------------------------------------------------------
// 权限端口（02 §6 三态；ask 态收敛点 = tool-phase awaitApproval）
// ---------------------------------------------------------------------------

/** 审批持久事件出口（permission.requested / permission.resolved 先落 JSONL 再发布）。 */
export interface PermissionEventSink {
  emit(
    name: "permission.requested" | "permission.resolved",
    build: (seq: number, ts: number) => unknown,
  ): void;
}

/** 权限判定入参（02 §6.3 ToolPermissionRequest 的运行期投影）。 */
export interface ToolPermissionRequest {
  toolName: string;
  /** 归一化后的执行输入（与最终执行同字节，approve-what-runs）。 */
  input: unknown;
  metadata: ToolMetadata;
  mode: CollaborationMode;
  sessionId: string;
  turnId?: string;
  toolCallId?: string;
  workspaceRoot: string;
  /** workspaceHash（project 规则判定域，05 §3.6）。 */
  workspaceId: string;
  /**
   * 越界路径预检结果（02 §5.4「命令读写 workspace 外路径 → 权限层 ask；审批通过后放行」）：
   * tool-phase 对显式路径工具（read/grep/glob/write/edit）预检注入；permission 侧据此
   * 跳过一切静默放行路径强制逐次审批。
   */
  pathEscape?: { absolutePath: string };
  /** ask 态审批事件的持久化出口。 */
  events?: PermissionEventSink;
}

/** 三态判定结果（02 §6.3 PermissionVerdict；matchedBy/reason 供诊断与测试断言）。 */
export interface PermissionVerdict {
  decision: "allow" | "ask" | "deny";
  matchedBy?: "metadata" | "mode" | "session-rule" | "project-rule" | "global-rule" | "default";
  ruleId?: string;
  /** decision=ask 时由实现下发，tool-phase 经 awaitApproval 挂起收敛。 */
  grantId?: string;
  reason?: string;
}

export interface PermissionPort {
  evaluate(request: ToolPermissionRequest): Promise<PermissionVerdict>;
  /** ask 态收敛：挂起等待审批应答/超时，返回最终 allow|deny（闭环事件与审计由实现负责）。 */
  awaitApproval(grantId: string): Promise<"allow" | "deny">;
}

/** 审批测试应答端口（always-allow / always-deny；headless fail-safe 兜底用，02 §2.4）。 */
export type ApprovePort = (request: ToolPermissionRequest) => Promise<"allow" | "deny">;

/** 审批测试实现：一律 allow。 */
export const alwaysAllowApprover: ApprovePort = () => Promise.resolve("allow");

/** 审批测试实现：一律 deny（headless/不可达客户端的 fail-safe 兜底，02 §2.4）。 */
export const alwaysDenyApprover: ApprovePort = () => Promise.resolve("deny");

/**
 * 测试/降级判定链（default-allow 策略的最小形态）：metadata.readOnly === true → allow 快速通道
 * （02 §6.2）；否则视为 ask → ApprovePort 立即应答收敛（不产生审批单）。
 */
export function createMetadataPermissionPort(approve: ApprovePort): PermissionPort {
  return {
    async evaluate(request: ToolPermissionRequest): Promise<PermissionVerdict> {
      if (request.metadata.readOnly) {
        return { decision: "allow", matchedBy: "metadata", reason: "只读工具快速通道" };
      }
      const final = await approve(request);
      return {
        decision: final,
        matchedBy: "default",
        reason: final === "allow" ? "测试审批实现放行" : "测试审批实现拒绝",
      };
    },
    // ask 不外露（evaluate 内部已收敛）；防御性 fail-safe deny
    awaitApproval: () => Promise.resolve("deny"),
  };
}

/** 工具阶段依赖（server 装配注入；registry/executor 见 @raincode/tools）。 */
export interface ToolPhaseDeps {
  registry: ToolRegistry;
  executor: ToolExecutor;
  permission: PermissionPort;
  /**
   * ask_user_question 交互通道（T2.7 P1；可选——缺省即 headless，工具以 TOOL_UNAVAILABLE 收敛）。
   * 真实实现由 server 装配（PermissionRuntime.askUser = ApprovalBroker 闭环复用），与权限
   * evaluate/awaitApproval 判定链独立（提问本身无副作用，不进五级判定）。
   */
  askUser?: AskUserChannel;
  /**
   * skill 工具展开通道（T4.4；可选——缺省 skills 域未装配，工具以 TOOL_UNAVAILABLE 收敛）。
   * 真实实现由 server 装配（SkillRuntime.expandForModel = skills.invoke 同链路：双源解析 →
   * modelInvocable 开关 → 模板展开，展开单点在 server 侧）；结果形态不复用异常（跨包错误类
   * 不越 port），以 ok/code 投影交由工具侧收敛为 ToolResult.error。
   */
  expandSkill?: SkillExpansionChannel;
  /**
   * session_search 会话历史检索通道（T5.3；可选——缺省未装配，工具以 TOOL_UNAVAILABLE 收敛）。
   * 真实实现由 server 装配（storage.searchHistory 薄投影：part 级 FTS + 相对分数地板，
   * 会话归属与 workspace 判定域由 tool-phase 注入）；结果形态不复用异常（同 expandSkill 口径）。
   */
  searchHistory?: SessionHistorySearchChannel;
}

// ---------------------------------------------------------------------------
// skill 工具展开通道（T4.4；skills.invoke 同链路的端口投影）
// ---------------------------------------------------------------------------

/** skill 工具调用请求（tool-phase 由 ToolExecutionContext 注入会话归属）。 */
export interface SkillExpansionRequest {
  sessionId: string;
  /** 技能名（[a-z0-9-]+，同斜杠命令名）。 */
  name: string;
  /** 调用参数（$ARGUMENTS 替换；缺省无参）。 */
  arguments?: string;
}

/** 展开结果：ok = 模板展开文本（模型作为工具结果续答）；!ok = 域码投影（工具侧收敛为错误结果）。 */
export type SkillExpansionResult = { ok: true; expanded: string } | { ok: false; code: string; message: string };

/** skill 展开通道（server 注入；SkillRuntime.expandForModel 薄投影）。 */
export type SkillExpansionChannel = (request: SkillExpansionRequest) => Promise<SkillExpansionResult>;

// ---------------------------------------------------------------------------
// ask_user_question 通道（T2.7 P1；02 §1.4 L322 简化落地的端口投影）
// ---------------------------------------------------------------------------

/** 提问请求（tool-phase 由 ToolExecutionContext 注入会话归属与事件出口）。 */
export interface AskUserChannelRequest {
  sessionId: string;
  /** workspaceHash（approvals 表归属列，05 §3.7）。 */
  workspaceId: string;
  question: string;
  choices?: string[];
  /** ask 态审批事件的持久化出口（permission.requested/resolved 与工具事件共用 seq 链）。 */
  events?: PermissionEventSink;
}

/** 应答形态：正常文本应答；或 cancelled（deny/超时/空应答——工具侧收敛为 TOOL_PERMISSION_DENIED）。 */
export type AskUserAnswer = { answerText: string } | { cancelled: true };

/** ask_user_question 通道（server 注入；approval-broker.request + askAndWait 的薄封装）。 */
export type AskUserChannel = (request: AskUserChannelRequest) => Promise<AskUserAnswer>;

// ---------------------------------------------------------------------------
// session_search 会话历史检索通道（T5.3；02 §7 检索真源在 storage，server 装配注入）
// ---------------------------------------------------------------------------

/** 检索请求（tool-phase 由 turn ctx 注入会话归属与 workspace 判定域）。 */
export interface SessionHistorySearchRequest {
  sessionId: string;
  /** workspaceHash（历史检索判定域；05 §3.12 history_parts 归属列）。 */
  workspaceId: string;
  query: string;
  limit?: number;
}

/** 命中投影（索引细节 seq/bm25 分数不外露工具面；已按相关性排序、分数地板裁剪）。 */
export interface SessionHistoryHitView {
  sessionId: string;
  role: string;
  kind: "text" | "tool";
  content: string;
  ts: number;
}

/** 结果：ok = 命中列表；!ok = 域码投影（同 expandSkill，跨包错误类不越 port）。 */
export type SessionHistorySearchResult =
  | { ok: true; hits: SessionHistoryHitView[] }
  | { ok: false; code: string; message: string };

/** 检索通道（server 注入；storage.searchHistory 薄投影）。 */
export type SessionHistorySearchChannel = (request: SessionHistorySearchRequest) => Promise<SessionHistorySearchResult>;
