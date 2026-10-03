/**
 * @raincode/rpc/web —— 浏览器安全子路径（T3.8）：只导出不依赖 node 内建的模块
 * （client / transport 抽象 / websocket 绑定 / 重连客户端）。
 * index.ts 引入 stdio.js（node:string_decoder），不可进浏览器图——Web 端只从本入口导入。
 */
export { createRpcClient, RpcCallError } from "./client.js";
export type { RpcClient, RpcClientCallOptions, RpcClientOptions } from "./client.js";

export type { IMessageTransport, RpcFrame, Unsubscribe } from "./transport.js";

export { WebSocketTransport } from "./websocket.js";
export type { WebSocketTransportOptions, WsSocketLike } from "./websocket.js";

export { createReconnectingRpcClient } from "./web-client.js";
export type {
  ReconnectingRpcClient,
  ReconnectingRpcClientOptions,
  WebConnectionState,
} from "./web-client.js";
