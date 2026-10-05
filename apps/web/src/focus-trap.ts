/**
 * 弹窗焦点陷阱纯函数（§8.1 焦点管理轮）：可聚焦元素收集 + Tab/Shift+Tab 循环索引。
 * 与桌面端同构镜像；DOM helper 轻量（仅属性判定，不做布局测量），便于单测以假根覆盖。
 */

/** 可聚焦元素选择器（原生控件 + 显式 tabindex；disabled / tabindex="-1" 由选择器与过滤双重排除）。 */
export const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** 单元素可聚焦判定：排除 disabled / tabindex="-1" / hidden / aria-hidden。 */
function isFocusable(el: HTMLElement): boolean {
  if (el.hasAttribute("disabled") || el.hidden || el.hasAttribute("hidden")) return false;
  if (el.getAttribute("tabindex") === "-1") return false;
  if (el.getAttribute("aria-hidden") === "true") return false;
  return true;
}

/** 根容器内按文档序收集可聚焦元素（disabled / tabindex="-1" / hidden 过滤）。 */
export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(isFocusable);
}

/**
 * Tab/Shift+Tab 焦点推进（回绕）：current 越界或 < 0 时落到首/末（Tab → 首个，Shift+Tab → 末个）。
 * 空集合（count === 0）安全返回 0。
 */
export function nextFocusIndex(current: number, count: number, shift: boolean): number {
  if (count <= 0) return 0;
  if (current < 0 || current >= count) return shift ? count - 1 : 0;
  return shift ? (current - 1 + count) % count : (current + 1) % count;
}
