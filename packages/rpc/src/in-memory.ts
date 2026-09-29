import type { IMessageTransport, RpcFrame, Unsubscribe } from "./transport.js";

/**
 * in-memory 绑定（04 §4.4 / 06-api-spec §6.1）：进程内直调 + 事件回调，零序列化。
 * CLI 单进程内嵌 Agent Service（04 §3.1）使用本绑定。
 *
 * 投递语义：send 经微任务异步投递到对端（06 §6.2「进程内回调（微任务异步）」），
 * 单端 send 顺序 = 对端收到顺序（FIFO），不引入同步重入栈。
 */
export class InMemoryTransport implements IMessageTransport {
  readonly kind = "in-memory" as const;

  private peer: InMemoryTransport | null = null;
  private readonly listeners = new Set<(frame: RpcFrame) => void>();
  private closed = false;

  /** 创建一对互连的端（[client, server]），进程内直调通道。 */
  static createPair(): [InMemoryTransport, InMemoryTransport] {
    const a = new InMemoryTransport();
    const b = new InMemoryTransport();
    a.peer = b;
    b.peer = a;
    return [a, b];
  }

  get isClosed(): boolean {
    return this.closed;
  }

  send(frame: RpcFrame): void {
    if (this.closed) {
      throw new Error("TRANSPORT_CLOSED: cannot send on a closed in-memory transport");
    }
    const peer = this.peer;
    if (!peer || peer.closed) {
      throw new Error("TRANSPORT_CLOSED: peer in-memory transport is closed");
    }
    const target = peer;
    queueMicrotask(() => target.deliver(frame));
  }

  onFrame(listener: (frame: RpcFrame) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** in-memory 无待发缓冲，关闭即标记；reason 仅保留接口一致性（04 §4.1）。 */
  async close(_reason?: string): Promise<void> {
    this.closed = true;
    this.listeners.clear();
  }

  private deliver(frame: RpcFrame): void {
    if (this.closed) return; // 关闭后的迟到帧直接丢弃
    for (const listener of [...this.listeners]) {
      try {
        listener(frame);
      } catch (err) {
        // 单个 listener 异常不破坏通道（stderr 告警，06 §1.3：诊断日志走 stderr）
        console.error("[raincode/rpc in-memory] frame listener threw", err);
      }
    }
  }
}

/** 创建一对互连的 in-memory 传输端（[client, server]）。 */
export function createInMemoryTransportPair(): [InMemoryTransport, InMemoryTransport] {
  return InMemoryTransport.createPair();
}
