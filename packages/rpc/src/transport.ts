import type { RpcFrame } from "@raincode/shared";

/**
 * 传输抽象（04-architecture §4.1）：rpc 层只关心「帧」，对业务零感知（不解析方法名与 payload 语义）。
 * RpcFrame 的 zod schema 真源在 @raincode/shared（06-api-spec §5 common.ts），
 * 此处按 04 §4.1 原样导出类型，供端层与 server 从本包导入。
 */
export type { RpcFrame };

export type Unsubscribe = () => void;

export interface IMessageTransport {
  /** 发送一帧；transport 不感知业务语义，仅负责序列化与投递。 */
  send(frame: RpcFrame): void;
  /** 订阅到达帧；实现方保证同一会话的事件按产生顺序投递。 */
  onFrame(listener: (frame: RpcFrame) => void): Unsubscribe;
  /** 优雅关闭：flush 待发帧后断开。 */
  close(reason?: string): Promise<void>;
  readonly isClosed: boolean;
  readonly kind: "in-memory" | "stdio" | "websocket";
}
