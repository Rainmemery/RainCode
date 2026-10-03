/**
 * @raincode/rpc —— 传输无关 RPC 层（04-architecture §4）。
 *
 * 本包唯一 publicEntrypoint（architecture/policy.yaml）。对业务零感知：
 * 方法/事件 payload 的语义与 zod schema 归 @raincode/shared。
 * 绑定进度：in-memory（P0）、stdio（T2.8）与 websocket（T3.8）已落地。
 */

export type { IMessageTransport, RpcFrame, Unsubscribe } from "./transport.js";

export { InMemoryTransport, createInMemoryTransportPair } from "./in-memory.js";

export { StdioTransport } from "./stdio.js";
export type { StdioTransportOptions } from "./stdio.js";

export { WebSocketTransport } from "./websocket.js";
export type { WebSocketTransportOptions, WsSocketLike } from "./websocket.js";

export { createReconnectingRpcClient } from "./web-client.js";
export type {
  ReconnectingRpcClient,
  ReconnectingRpcClientOptions,
  WebConnectionState,
} from "./web-client.js";

export { createRpcClient, RpcCallError } from "./client.js";
export type { RpcClient, RpcClientCallOptions, RpcClientOptions } from "./client.js";

export { createServiceBinding } from "./server.js";
export type {
  CallContext,
  CreateServiceBindingOptions,
  RpcMethodHandler,
  RpcServiceBinding,
} from "./server.js";
