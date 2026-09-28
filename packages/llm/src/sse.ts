/**
 * SSE 帧解析器：把字节流按 SSE 规范切成 data 事件（RFC 9110 text/event-stream 惯例子集）。
 *
 * 覆盖 OpenAI 兼容端的实际用法：
 * - 帧以空行分隔（\n\n 或 \r\n\r\n），逐行解析；
 * - `data:` 行（可多行，按 SSE 规范以 \n 连接）承载 payload；`[DONE]` 哨兵由上层识别；
 * - `event:` / `id:` / `retry:` 行与 `:` 开头的注释/keep-alive 行（如 OpenRouter）忽略。
 * 解析器只做分帧，不感知 JSON 与业务语义（llm 包纯转换层约束）。
 */

export interface SseDataEvent {
  data: string;
}

export class SseParser {
  private buffer = "";
  private dataLines: string[] = [];

  /** 喂入一段解码后的文本，返回其中完成的 data 事件（可能 0..n 个）。 */
  push(text: string): SseDataEvent[] {
    this.buffer += text;
    const events: SseDataEvent[] = [];
    let nl = this.buffer.indexOf("\n");
    while (nl !== -1) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, "");
      this.buffer = this.buffer.slice(nl + 1);
      this.handleLine(line, events);
      nl = this.buffer.indexOf("\n");
    }
    return events;
  }

  /** 流结束时调用：处理残存缓冲（无结尾换行的最后一段），返回兜底事件。 */
  flush(): SseDataEvent[] {
    const events: SseDataEvent[] = [];
    if (this.buffer.length > 0) {
      const line = this.buffer.replace(/\r$/, "");
      this.buffer = "";
      this.handleLine(line, events);
    }
    this.endFrame(events);
    return events;
  }

  private handleLine(line: string, out: SseDataEvent[]): void {
    if (line === "") {
      // 空行 = 帧边界：交付当前帧
      this.endFrame(out);
      return;
    }
    if (line.startsWith(":")) {
      return; // 注释 / keep-alive
    }
    if (line.startsWith("data:")) {
      this.dataLines.push(line.slice(5).replace(/^ /, ""));
      return;
    }
    // event:/id:/retry: 等其他字段对本包无意义，忽略
  }

  private endFrame(out: SseDataEvent[]): void {
    if (this.dataLines.length === 0) {
      return;
    }
    const data = this.dataLines.join("\n");
    this.dataLines = [];
    out.push({ data });
  }
}
