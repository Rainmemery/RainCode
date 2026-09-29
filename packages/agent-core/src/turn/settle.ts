/*
 * @Author: 卢宇翔 luyuxiang@shwpg.com
 * @Date: 2026-09-28 16:16:29
 * @LastEditors: 卢宇翔 luyuxiang@shwpg.com
 * @LastEditTime: 2026-09-28 16:27:51
 * @FilePath: \MyClaudeCode\RainCode\packages\agent-core\src\turn\settle.ts
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
/**
 * Turn 收束家族（从 SessionTurnLoop 拆出，保持单文件 ≤500 行）：
 * cancelledEarly（T3）/ aborted（T5/T8）/ failed（T5'）/ abnormal（基础设施异常收敛）。
 * 循环只保留薄委托调用；落库（部分正文）经 host.persistPartialText 回到单写者链。
 */
import type { TurnOutcome } from "../ports.js";
import type { LoopEvents } from "./loop-events.js";
import type { TurnPhase, TurnTrigger } from "./phase.js";

/** 收束宿主（SessionTurnLoop 实现）：相位读写与部分正文落库。 */
export interface SettleHost {
  phase(): TurnPhase;
  toPhase(from: TurnPhase, trigger: TurnTrigger, turnId: string): void;
  assistantText(): string;
  persistPartialText(): Promise<unknown>;
}

export class TurnSettler {
  constructor(
    private readonly host: SettleHost,
    private readonly events: LoopEvents,
  ) {}

  /** T3：用户输入已落盘、模型请求未发出前的取消。 */
  cancelledEarly(turnId: string): TurnOutcome {
    this.host.toPhase("ProcessingInput", "turn.cancelled", turnId);
    this.events.emitDone(turnId, { outcome: "cancelled", at: "ProcessingInput" });
    this.host.toPhase("TurnComplete", "settle.done", turnId); // T15
    return { status: "cancelled", at: "ProcessingInput" };
  }

  /** T5（请求期取消）/ T8（流式中断）：部分正文落库不丢（02 §1.4）。 */
  async aborted(turnId: string): Promise<TurnOutcome> {
    const at = this.host.phase(); // ModelRequest（T5）| Streaming（T8）
    this.host.toPhase(at, at === "Streaming" ? "turn.cancelled" : "request.failed", turnId);
    if (this.host.assistantText().length > 0) {
      await this.host.persistPartialText();
    }
    this.events.emitDone(turnId, { outcome: "cancelled", at });
    this.host.toPhase("TurnComplete", "settle.done", turnId); // T15
    return { status: "cancelled", at };
  }

  /** T5'：模型请求失败（LlmError / 未配置）。 */
  async failed(turnId: string, code: string, message: string): Promise<TurnOutcome> {
    const at = this.host.phase(); // ModelRequest | Streaming
    this.host.toPhase(at, "request.failed", turnId);
    if (this.host.assistantText().length > 0) {
      await this.host.persistPartialText();
    }
    this.events.emitError(turnId, code, message); // error（scope=turn）
    this.events.emitDone(turnId, { outcome: "failed", at });
    this.host.toPhase("TurnComplete", "settle.done", turnId); // T15
    return { status: "failed", error: { code, message } };
  }

  /** 基础设施异常 / 未配置 Provider / 轮次超限的兜底收束：经合法迁移收敛到 TurnComplete。 */
  async abnormal(turnId: string, code: string, message: string): Promise<TurnOutcome> {
    const phase = (): TurnPhase => this.host.phase();
    if (phase() === "ToolSchedule") {
      this.host.toPhase("ToolSchedule", "schedule.all_blocked", turnId);
    }
    if (phase() === "ToolExecution") {
      this.host.toPhase("ToolExecution", "batch.settled", turnId);
    }
    if (phase() === "AggregatingResults") {
      this.host.toPhase("AggregatingResults", "followup.not_required", turnId); // T14 异常收敛
    }
    switch (phase()) {
      case "ProcessingInput":
        this.host.toPhase("ProcessingInput", "turn.cancelled", turnId); // T3 收敛
        break;
      case "ModelRequest":
      case "Streaming":
        this.host.toPhase(phase(), "request.failed", turnId);
        break;
      default:
        break; // TurnComplete / Idle：已收束或未开始
    }
    if (phase() === "TurnComplete") {
      this.events.emitError(turnId, code, message);
      this.events.emitDone(turnId, { outcome: "failed", at: "TurnComplete" });
      this.host.toPhase("TurnComplete", "settle.done", turnId); // T15
    }
    return { status: "failed", error: { code, message } };
  }
}
