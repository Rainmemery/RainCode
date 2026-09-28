/**
 * agent-core 端口定义（04-architecture §2.4 铁律 5：端口注入精神）。
 *
 * - LlmPort：包 @novacode/llm 的 LlmClient 结构子集（本波直接复用其请求/结果类型，接口保持薄）；
 * - StoragePort：包 @novacode/storage 的 Storage 结构子集（appendMessage / appendEvent / writeCheckpoint）；
 * - SessionEventPublisher：会话事件出口，由 server 注入（agent-core 对传输不可知，禁止 import rpc）；
 * - PermissionPort：工具权限三态判定的本波窄端口（allow/deny；ask 由实现内部经 ApprovePort 收敛，
 *   完整五级判定链与审批闭环属 packages/permission 波次，02 §6）。
 *
 * 真实实现（Storage / LlmClient）结构化满足端口，server 装配时直接注入，无需适配层。
 */
import type {
  ChatCompletionStreamRequest,
  LlmStreamResult,
} from "@novacode/llm";
import type { ToolExecutor, ToolMetadata, ToolRegistry } from "@novacode/tools";
import type {
  AppendResult,
  CheckpointResult,
  CheckpointState,
} from "@novacode/storage";
import type { MessageRecord } from "@novacode/shared";

/** 模型流式端口（@novacode/llm LlmClient 的唯一被消费方法）。 */
export interface LlmPort {
  streamChat(request: ChatCompletionStreamRequest): Promise<LlmStreamResult>;
}

/** 持久化端口（@novacode/storage Storage 的写路径子集；历史常驻内存，恢复由 server 完成）。 */
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
// 工具阶段端口（本波注入实现：readOnly → allow；否则 ask → ApprovePort 应答）
// ---------------------------------------------------------------------------

/** 权限判定入参（02 §6.3 ToolPermissionRequest 的窄投影；模式/规则链随 permission 包补齐）。 */
export interface ToolPermissionRequest {
  toolName: string;
  input: unknown;
  metadata: ToolMetadata;
}

/** 本波三态收敛为二值：allow / deny（ask 由 ApprovePort 实现内部应答）。 */
export type PermissionVerdict = "allow" | "deny";

/** 审批应答端口（本波测试实现：always-allow / always-deny；生产 UI 审批闭环随 permission 包）。 */
export type ApprovePort = (request: ToolPermissionRequest) => Promise<PermissionVerdict>;

export interface PermissionPort {
  evaluate(request: ToolPermissionRequest): Promise<PermissionVerdict>;
}

/** 审批测试实现：一律 allow。 */
export const alwaysAllowApprover: ApprovePort = () => Promise.resolve("allow");

/** 审批测试实现：一律 deny（headless/不可达客户端的 fail-safe 兜底，02 §2.4）。 */
export const alwaysDenyApprover: ApprovePort = () => Promise.resolve("deny");

/**
 * 默认判定链（本波最小实现）：metadata.readOnly === true → allow 快速通道（02 §6.2）；
 * 否则视为 ask → ApprovePort 应答。
 */
export function createMetadataPermissionPort(approve: ApprovePort): PermissionPort {
  return {
    evaluate(request: ToolPermissionRequest): Promise<PermissionVerdict> {
      if (request.metadata.readOnly) {
        return Promise.resolve("allow");
      }
      return approve(request);
    },
  };
}

/** 工具阶段依赖（server 装配注入；registry/executor 见 @novacode/tools）。 */
export interface ToolPhaseDeps {
  registry: ToolRegistry;
  executor: ToolExecutor;
  permission: PermissionPort;
}
