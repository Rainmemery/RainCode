/**
 * 弹窗焦点管理纯函数（polish-ui-states-and-runtime A6；03-ui-design §8.1）。
 * 与 Web 端 focus-trap 同构镜像（同 API / 同循环语义）。`nextFocusIndex` 为纯数学（可单测），
 * `focusableWithin` 依赖 DOM（渲染层消费）。
 */

/** 可聚焦元素选择器（disabled / tabindex="-1" / hidden 由 focusableWithin 另行过滤）。 */
export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/**
 * 收集 root 内可聚焦元素（文档顺序）：过滤 disabled / `tabindex="-1"` / hidden 属性 / 不可见
 * （offsetParent 与布局盒均为空）。供弹窗焦点陷阱在按钮组间循环。
 */
export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((el) => {
    if (el.hasAttribute("disabled")) return false;
    if (el.getAttribute("tabindex") === "-1") return false;
    if (el.hidden) return false;
    return el.offsetParent !== null || el.getClientRects().length > 0;
  });
}

/** Tab / Shift+Tab 循环索引（环绕，shift 反向）；count<=0 安全返回 0。 */
export function nextFocusIndex(current: number, count: number, shift: boolean): number {
  if (count <= 0) return 0;
  const delta = shift ? -1 : 1;
  return (((current + delta) % count) + count) % count;
}
