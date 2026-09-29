/**
 * 流式 markdown 渲染器（ADR-02 中间形态：readline REPL + ANSI 富文本渲染层）。
 *
 * 行缓冲状态机：delta 到达 → 缓冲 → 凑齐完整行逐行渲染；end() 冲刷半行并复位围栏状态
 * （消息边界：工具行 / 审批单 / turn 终态打印前调用，避免输出拼接在未收口的正文后）。
 * 支持：ATX 标题（加粗 + accent）、围栏代码块（栅栏行 cyan / 内容 mint，保持缩进，栅栏开合
 * 状态机，无语法高亮）、无序/有序列表（列表符 accent，内容走行内样式）、引用（▌ 前缀 + dim），
 * 行内 code（ok 绿）/ **bold** / *italic*。
 * 行内处理从简（MiMo print 模式调研结论）：先按行内 code 分段，非 code 段做 bold/italic
 * 单层替换；不做完整 markdown 解析器。非 TTY 时 theme 样式恒等，输出纯文本。
 */
import type { Style, Styles } from "./theme.js";

const FENCE = "```";

export class StreamMarkdownRenderer {
  private readonly stream: NodeJS.WriteStream;
  private readonly s: Styles;
  private buffer = "";
  private inCode = false;

  constructor(stream: NodeJS.WriteStream, styles: Styles) {
    this.stream = stream;
    this.s = styles;
  }

  /** 追加增量；缓冲凑齐完整行即逐行渲染（行缓冲，半行留待后续 delta 或 end()）。 */
  feed(delta: string): void {
    this.buffer += delta;
    for (;;) {
      const idx = this.buffer.indexOf("\n");
      if (idx < 0) break;
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      this.renderLine(line);
    }
  }

  /** 冲刷半行缓冲并复位围栏状态（消息边界 / turn 终态前调用；重复调用无害）。 */
  end(): void {
    if (this.buffer.length > 0) {
      const tail = this.buffer;
      this.buffer = "";
      this.renderLine(tail);
    }
    this.inCode = false;
  }

  /** 单行渲染：围栏状态机 → 标题 → 列表 → 引用 → 普通段落（正文默认色）。 */
  private renderLine(line: string): void {
    const trimmed = line.trimStart();
    if (this.inCode) {
      // 围栏内容：保持缩进原样输出（mint）；栅栏闭合行（cyan）
      if (trimmed.startsWith(FENCE)) {
        this.inCode = false;
        this.emit(this.s.cyan(line));
      } else {
        this.emit(this.s.mint(line));
      }
      return;
    }
    if (trimmed.startsWith(FENCE)) {
      this.inCode = true;
      this.emit(this.s.cyan(line));
      return;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading !== null && heading[2] !== undefined) {
      this.emit(this.s.bold(this.s.accent(heading[2])));
      return;
    }
    const list = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(line);
    if (list !== null && list[1] !== undefined && list[2] !== undefined && list[3] !== undefined) {
      this.emit(`${list[1]}${this.s.accent(list[2])} ${this.inline(list[3])}`);
      return;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote !== null && quote[1] !== undefined) {
      // 引用：▌ 前缀 dim；内容以 dim 为基色走行内样式（行内 code 段保持 ok 绿弹出）
      this.emit(`${this.s.dim("▌ ")}${this.inline(quote[1], this.s.dim)}`);
      return;
    }
    this.emit(this.inline(line));
  }

  /** 行内样式：先按 `code` 分段（ok 绿），非 code 段以 base 色做 bold/italic 单层替换。 */
  private inline(text: string, base?: Style): string {
    const paintPlain: Style = base ?? ((t: string) => t);
    return text
      .split(/(`[^`\n]*`)/)
      .map((seg) =>
        seg.length > 2 && seg.startsWith("`") && seg.endsWith("`")
          ? this.s.ok(seg.slice(1, -1))
          : paintPlain(this.boldItalic(seg)),
      )
      .join("");
  }

  /** bold/italic 单层替换（先 **bold** 后 *italic*，替换产物不含 * 不会互相误配）。 */
  private boldItalic(text: string): string {
    return text
      .replace(/\*\*([^*\n]+)\*\*/g, (_match, inner: string) => this.s.bold(inner))
      .replace(/\*([^*\n]+)\*/g, (_match, inner: string) => this.s.italic(inner));
  }

  private emit(line: string): void {
    this.stream.write(`${line}\n`);
  }
}
