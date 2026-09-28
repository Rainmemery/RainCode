/**
 * message.delta 批量节流（06-api-spec §3.4）：
 * 批量窗口 ≤50ms（in-memory 绑定亦执行，保证与跨进程绑定行为一致）；
 * 窗口内同 turn 同类型 delta 合并为单事件；text 与 reasoning 各自独立合并。
 * delta 为 UI 瞬态，不落盘（05-database §4.2）。
 */
export type DeltaKind = "text" | "reasoning";

export interface DeltaSink {
  (kind: DeltaKind, mergedText: string): void;
}

export class DeltaBatcher {
  private text = "";
  private reasoning = "";
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly flushMs: number,
    private readonly sink: DeltaSink,
  ) {}

  add(kind: DeltaKind, text: string): void {
    if (kind === "text") {
      this.text += text;
    } else {
      this.reasoning += text;
    }
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, this.flushMs);
    }
  }

  /** 立即投递积压 delta（06 §3.4 flush 边界：边界事件必须先 flush 再投递自身）。 */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.text.length > 0) {
      const merged = this.text;
      this.text = "";
      this.sink("text", merged);
    }
    if (this.reasoning.length > 0) {
      const merged = this.reasoning;
      this.reasoning = "";
      this.sink("reasoning", merged);
    }
  }

  /** turn 收束兜底：清计时器与残留缓冲（通常 flush 已清空）。 */
  dispose(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.text = "";
    this.reasoning = "";
  }
}
