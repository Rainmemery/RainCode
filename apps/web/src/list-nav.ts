/**
 * 列表键盘导航纯函数（§8.1 键盘可达轮）：↑↓/Home/End 的索引推进与回绕语义。
 * 与桌面端同构镜像（同一 API、同一回绕语义）；纯函数、无 DOM 依赖，node 单测直跑。
 */

/** 索引钳制到 [0, count-1]；空列表（count === 0）安全返回 0，越界/非法值回落边界。 */
export function clampIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  if (!Number.isFinite(index) || index < 0) return 0;
  if (index >= count) return count - 1;
  return Math.trunc(index);
}

/**
 * 相对步进（回绕）：nextIndex(current, count, delta)。
 * current < 0（尚无高亮）落到首项；否则先钳制到合法区间再按 delta 取模回绕（负数取模已修正）。
 * 空列表安全返回 0。
 */
export function nextIndex(current: number, count: number, delta: number): number {
  if (count <= 0) return 0;
  if (!Number.isFinite(current) || current < 0) return 0;
  const base = clampIndex(current, count);
  return (((base + delta) % count) + count) % count;
}

/**
 * 按键 → 目标索引：ArrowUp/ArrowDown/Home/End 返回下一步索引，其余键返回 null（不接管）。
 * 空列表（count === 0）对导航键返回 0，由调用方按 count 判定是否消费。
 */
export function nextIndexFromKey(key: string, current: number, count: number): number | null {
  switch (key) {
    case "ArrowDown":
      return nextIndex(current, count, 1);
    case "ArrowUp":
      return nextIndex(current, count, -1);
    case "Home":
      return 0;
    case "End":
      return count <= 0 ? 0 : count - 1;
    default:
      return null;
  }
}
