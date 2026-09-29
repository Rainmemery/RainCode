/**
 * IpcBridgeTransport（06-api-spec §6.2）：renderer 侧 IMessageTransport——
 * 经 preload contextBridge 与 main 帧桥对接 agent 子进程 stdio，业务帧端到端透传，
 * main 不解析（04 §3.2）。逻辑上等价一条虚拟 stdio（kind: "stdio"）。
 */
import type { IMessageTransport, RpcFrame, Unsubscribe } from "@raincode/rpc";
import type { RaincodeBridgeApi } from "../main/preload.js";

declare global {
  interface Window {
    raincode: RaincodeBridgeApi;
  }
}

export class IpcBridgeTransport implements IMessageTransport {
  readonly kind = "stdio" as const;

  private readonly listeners = new Set<(frame: RpcFrame) => void>();
  private closed = false;

  constructor(private readonly bridge: RaincodeBridgeApi) {
    this.bridge.onFrame((line) => this.dispatch(line));
  }

  get isClosed(): boolean {
    return this.closed;
  }

  send(frame: RpcFrame): void {
    if (this.closed) {
      throw new Error("TRANSPORT_CLOSED: ipc bridge transport is closed");
    }
    this.bridge.sendFrame(JSON.stringify(frame));
  }

  onFrame(listener: (frame: RpcFrame) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 本地订阅退订；agent 子进程生命周期由 main 守护，此处不 end 通道。 */
  async close(_reason?: string): Promise<void> {
    this.closed = true;
    this.listeners.clear();
  }

  /** 恢复接收（agent 守护重启后复用同一通道——main 帧桥不变，仅子进程换新）。 */
  reopen(): void {
    this.closed = false;
  }

  private dispatch(line: string): void {
    if (this.closed) return;
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      console.error("[raincode/desktop renderer] malformed frame line dropped");
      return;
    }
    // 帧方向（06 §1.1）：端层只应收到 response/event
    const candidate = frame as { kind?: string };
    if (candidate.kind !== "response" && candidate.kind !== "event") {
      console.error("[raincode/desktop renderer] unexpected frame kind dropped", candidate.kind);
      return;
    }
    const rpcFrame = frame as RpcFrame;
    for (const listener of [...this.listeners]) {
      try {
        listener(rpcFrame);
      } catch (err) {
        console.error("[raincode/desktop renderer] frame listener threw", err);
      }
    }
  }
}

let bridgeSingleton: IpcBridgeTransport | null = null;

export function getBridge(): IpcBridgeTransport {
  if (bridgeSingleton === null) {
    bridgeSingleton = new IpcBridgeTransport(window.raincode);
  }
  return bridgeSingleton;
}
