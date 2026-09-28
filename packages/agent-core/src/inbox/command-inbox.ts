/**
 * CommandInbox 简化版（02-module-design §1.2.3）：同会话指令串行接纳。
 *
 * 接纳策略（「排队 or 拒绝」二选一的显式选择）：**运行中排队，不拒绝**。
 * 依据：02 §1.2.3 turn.new 的默认接纳策略即排队（"空闲则立即开 turn；运行中则排队
 * （或按配置拒绝/替换）"）；排队保证输入不丢（02 §1.4：收尾竞态窗口内到达的输入
 * 一律入队）。拒绝/替换策略待「队列策略」配置化时再补齐。
 *
 * 本波仅 turn.new 一类指令经此入队；turn.steer（steeringBuffer 注入通道）与
 * session.control（穿透队列）随后续波次补齐（本波 steer 直接落在会话缓冲，见 turn-loop）。
 */
export interface InboxAdmission {
  /** 排队位置（1 起始；1 = 队首，下一个被执行）。 */
  position: number;
}

export class CommandInbox<T> {
  private readonly items: T[] = [];

  enqueue(item: T): InboxAdmission {
    this.items.push(item);
    return { position: this.items.length };
  }

  dequeue(): T | undefined {
    return this.items.shift();
  }

  get size(): number {
    return this.items.length;
  }
}
