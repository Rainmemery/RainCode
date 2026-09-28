/**
 * agent-core 端口定义（04-architecture §2.4 铁律 5：端口注入精神）。
 *
 * - LlmPort：包 @novacode/llm 的 LlmClient 结构子集（本波直接复用其请求/结果类型，接口保持薄）；
 * - StoragePort：包 @novacode/storage 的 Storage 结构子集（appendMessage / appendEvent / writeCheckpoint）；
 * - SessionEventPublisher：会话事件出口，由 server 注入（agent-core 对传输不可知，禁止 import rpc）。
 *
 * 真实实现（Storage / LlmClient）结构化满足端口，server 装配时直接注入，无需适配层。
 */
import type {
  ChatCompletionStreamRequest,
  LlmStreamResult,
} from "@novacode/llm";
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
