/**
 * @raincode/rpc —— 传输无关 RPC 层（04-architecture §4）。
 *
 * 本包唯一 publicEntrypoint（architecture/policy.yaml）。对业务零感知：
 * 方法/事件 payload 的语义与 zod schema 归 @raincode/shared。
 * 绑定进度：in-memory 已落地（P0）；stdio 占位于 ./stdio.ts（P1）；websocket 预留（P2）。
 */

export type { IMessageTransport, RpcFrame, Unsubscribe } from "./transport.js";

export { InMemoryTransport, createInMemoryTransportPair } from "./in-memory.js";

export { createRpcClient, RpcCallError } from "./client.js";
export type { RpcClient, RpcClientCallOptions, RpcClientOptions } from "./client.js";

export { createServiceBinding } from "./server.js";
export type {
  CallContext,
  CreateServiceBindingOptions,
  RpcMethodHandler,
  RpcServiceBinding,
} from "./server.js";
