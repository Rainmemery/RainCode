/**
 * CLI 渲染主题（ADR-02 中间形态：readline REPL + ANSI 富文本渲染层）。
 *
 * 色值与桌面端 tokens 严格同源（03-ui-design §3.1 色板）：truecolor 前景 `\x1b[38;2;R;G;Bm`
 * 由 hex 转换（hexToAnsi）。样式常量表与 glyph 表参考 MiMo-Code print 模式调研结论
 * （其 cli/ui.ts 的 TEXT_HIGHLIGHT/DIM/WARNING/… 常量表 → 本表用 RainCode tokens 重映射）。
 *
 * 非 TTY 退化（管道 / smoke 输出捕获安全）：isTTY=false 时全部样式函数恒等、glyph 保留，
 * 纯文本仍可读。关闭序列用精确 SGR（颜色 39、加粗 22、斜体 23、删除线 29），
 * 保证颜色与字型属性可嵌套叠加而不互相清除。
 */

/** hex（#RRGGBB）→ truecolor 前景开启序列（03 §3.1 tokens 色值直转）。 */
export function hexToAnsi(hex: string): string {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `\x1b[38;2;${r};${g};${b}m`;
}

/** 样式函数：包裹文本（非 TTY 时恒等）。 */
export type Style = (text: string) => string;

/** 样式集：模块标识色 + 字型属性（显式接口，避免 ReturnType 自引用环）。 */
export interface Styles {
  accent: Style; // Agent 会话 / 品牌标记 = 赤陶橙 --accent
  cyan: Style; // 工具调用 --cyan
  info: Style; // MCP --info
  violet: Style; // 子代理 --violet
  mint: Style; // 沙箱 / 代码块 --mint
  warn: Style; // 等待审批 --warn
  ok: Style; // 成功 --ok
  danger: Style; // 错误 --danger
  dim: Style; // 思考 / 次要元数据 --text-low
  bold: Style;
  italic: Style;
  strike: Style; // 「已作废」删除线（被拒/取消的工具行）
}

/** 按 TTY 能力构造样式集；颜色关闭用 39（回默认前景）、字型关闭用 22/23/29，嵌套安全。 */
export function createStyles(isTTY: boolean): Styles {
  const color = (hex: string): Style => (isTTY ? (t) => `${hexToAnsi(hex)}${t}\x1b[39m` : (t) => t);
  const attr = (open: string, close: string): Style => (isTTY ? (t) => `${open}${t}${close}` : (t) => t);
  return {
    // 模块标识色（03 §3.1 七大模块标识色速查）
    accent: color("#E0784F"),
    cyan: color("#4EC9D4"),
    info: color("#58A6F5"),
    violet: color("#A48AFA"),
    mint: color("#4FCFA0"),
    warn: color("#E0B354"),
    ok: color("#53C383"),
    danger: color("#E4655E"),
    dim: color("#66798F"),
    bold: attr("\x1b[1m", "\x1b[22m"),
    italic: attr("\x1b[3m", "\x1b[23m"),
    strike: attr("\x1b[9m", "\x1b[29m"),
  };
}

/** stdout / stderr 各自检测 TTY（两通道独立退化，stderr 走 reasoning 与错误行）。 */
export const out = createStyles(process.stdout.isTTY === true);
export const err = createStyles(process.stderr.isTTY === true);

/** 模块色索引键（toolStyleKeyFor 的返回值，经 Styles 取样式函数）。 */
export type StyleKey = "cyan" | "info" | "violet";

/** 工具模块标识色：MCP 工具=info 蓝、子代理=violet 紫、内置工具=cyan 青（03 §3.1 模块色速查）。 */
export function toolStyleKeyFor(toolName: string): StyleKey {
  if (toolName.startsWith("mcp__")) return "info";
  if (toolName.includes("agent")) return "violet";
  return "cyan";
}

/** 工具类型 glyph（1 字符；MiMo print 模式调研结论 → RainCode 工具名域：read/grep/glob/write/edit/bash/todo_write/agent/mcp__*）。 */
export function glyphFor(toolName: string): string {
  if (toolName.startsWith("mcp__")) return "◇"; // MCP 工具
  const name = toolName.toLowerCase();
  if (name.startsWith("agent")) return "◈"; // 子代理派发
  if (name.startsWith("todo")) return "✓"; // todo 读写
  if (name.startsWith("read") || name.startsWith("grep") || name.startsWith("glob")) return "✱"; // 检索类
  if (name.startsWith("write") || name.startsWith("edit")) return "←"; // 写入类
  if (name.startsWith("bash")) return "$"; // 命令执行
  return "⚙"; // 兜底
}
