/**
 * 列表键盘导航纯函数（polish-ui-states-and-runtime A5；03-ui-design §8.1「列表 ↑↓ 移动 + Enter 进入」）。
 * 与 Web 端 list-nav 同构镜像（同 API / 同 wrap-around 语义）。纯函数（不依赖 DOM / React），
 * 供会话列表 / 规则表 / 记忆条目 / MCP 行等各列表复用键盘导航。
 */

/** 索引夹取：count<=0 返回 0；否则落到 [0, count-1]（越界即夹取，不环绕）。 */
export function clampIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  if (index < 0) return 0;
  if (index >= count) return count - 1;
  return index;
}

/**
 * 下一高亮索引（环绕）：delta 可正可负；越界 current 先夹取；首↔尾环绕。
 * current<0 表示「当前无高亮」：前进到首项，后退到末项。count<=0 安全返回 0。
 */
export function nextIndex(current: number, count: number, delta: number): number {
  if (count <= 0) return 0;
  if (current < 0) return delta >= 0 ? 0 : count - 1;
  const base = clampIndex(current, count);
  return (((base + delta) % count) + count) % count;
}

/**
 * 导航按键 → 目标索引（ArrowUp / ArrowDown / Home / End）；非导航键返回 null
 * （调用方自行处理 Enter / Delete）。count<=0 时仍安全返回 0。
 */
export function nextIndexFromKey(key: string, current: number, count: number): number | null {
  switch (key) {
    case "ArrowUp":
      return nextIndex(current, count, -1);
    case "ArrowDown":
      return nextIndex(current, count, 1);
    case "Home":
      return 0;
    case "End":
      return count <= 0 ? 0 : count - 1;
    default:
      return null;
  }
}
