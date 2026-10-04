/**
 * 主题偏好（03 §3.2 浅色主题落地轮）：深色 / 浅色 / 跟随系统三态。
 *
 * 设计口径：浅色为辅助主题，同一套语义 token 重映射（组件不写死色值）；
 * 持久化走 localStorage（Web 端无宿主配置面）；「跟随系统」经
 * prefers-color-scheme 实时重映射（桌面端同语义，各端独立实现不抽公共包）。
 *
 * 纯函数（resolveTheme / nextTheme / 校验与存取）与 DOM 侧薄封装分离，
 * node 单测无需 DOM 环境。
 */

export type ThemePref = "dark" | "light" | "system";

/** localStorage 键（桌面端同名同值，排障口径一致）。 */
export const THEME_STORAGE_KEY = "raincode.theme";

export const THEME_LABEL: Record<ThemePref, string> = {
  dark: "深色",
  light: "浅色",
  system: "跟随系统",
};

export function isThemePref(value: unknown): value is ThemePref {
  return value === "dark" || value === "light" || value === "system";
}

/** 偏好 → 实际主题（system 跟随 prefers-color-scheme）。 */
export function resolveTheme(pref: ThemePref, prefersLight: boolean): "dark" | "light" {
  if (pref === "system") return prefersLight ? "light" : "dark";
  return pref;
}

/** 切换循环：深色 → 浅色 → 跟随系统 → 深色。 */
export function nextTheme(pref: ThemePref): ThemePref {
  return pref === "dark" ? "light" : pref === "light" ? "system" : "dark";
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 读取持久化偏好：缺省/损坏值回退深色（03 §2.2 深色优先）。 */
export function loadThemePref(storage: Pick<StorageLike, "getItem">): ThemePref {
  const raw = storage.getItem(THEME_STORAGE_KEY);
  return isThemePref(raw) ? raw : "dark";
}

export function saveThemePref(storage: Pick<StorageLike, "setItem">, pref: ThemePref): void {
  storage.setItem(THEME_STORAGE_KEY, pref);
}

/** 将偏好落到 <html data-theme>（CSS 侧由 [data-theme="light"] 重映射 token）。 */
export function applyTheme(pref: ThemePref): void {
  const prefersLight = window.matchMedia("(prefers-color-scheme: light)").matches;
  document.documentElement.dataset.theme = resolveTheme(pref, prefersLight);
}
