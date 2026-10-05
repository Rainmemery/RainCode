/**
 * 统一通知条（polish-ui-states-and-runtime 轮 A1；双端同构）：tone `info | warn | danger` +
 * 可选动作按钮 + 可选关闭按钮。仅用既有语义 token 类（无硬编码色值，随深浅主题自动重映射）。
 * 接入：ChatFlow 重连条 / App 全局错误条 / ExtensionsPanel 错误行；既有文案保持不变。
 */
import type { ReactNode } from "react";

export interface StatusBannerAction {
  label: string;
  onClick: () => void;
}

export interface StatusBannerProps {
  tone: "info" | "warn" | "danger";
  /** 内容（或经 children 传入富文本）；二选一。 */
  text?: ReactNode;
  children?: ReactNode;
  action?: StatusBannerAction;
  onDismiss?: () => void;
}

/** tone → 语义色类（容器 + 状态点 + 文字色；全部为既有 token 类）。 */
const TONE_CLASS: Record<StatusBannerProps["tone"], { wrap: string; dot: string }> = {
  info: { wrap: "border-info/40 bg-info/5 text-mid", dot: "dot dot-run" },
  warn: { wrap: "border-warn/40 bg-warn/5 text-warn", dot: "dot dot-warn" },
  danger: { wrap: "border-danger bg-danger/10 text-danger", dot: "dot dot-err" },
};

export function StatusBanner({ tone, text, children, action, onDismiss }: StatusBannerProps) {
  const toneClass = TONE_CLASS[tone];
  return (
    <div className={`anim-rise flex items-start gap-2 rounded-md border px-3 py-2 text-2xs ${toneClass.wrap}`} role="status">
      <span className={`mt-1 shrink-0 ${toneClass.dot}`} aria-hidden="true" />
      <div className="min-w-0 flex-1 break-words">{children ?? text}</div>
      {action !== undefined && (
        <button
          type="button"
          onClick={action.onClick}
          className="shrink-0 rounded-md border border-current px-2 py-0.5 transition-colors duration-fast hover:bg-hover"
        >
          {action.label}
        </button>
      )}
      {onDismiss !== undefined && (
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 text-low transition-colors duration-fast hover:text-hi"
          title="关闭"
        >
          关闭
        </button>
      )}
    </div>
  );
}
