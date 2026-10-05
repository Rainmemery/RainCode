/**
 * 设置页共享卡片（UI 管理面板深化轮）：区块标题（text-xs text-mid）+ 卡片容器
 * （bg-card border-border-faint rounded-md），SettingsView 六组 Tab 内容共用。
 */
import type { ReactNode } from "react";

export function SettingsCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <div className="pb-2 text-xs text-mid">{title}</div>
      <div className="rounded-md border border-border-faint bg-card p-4">{children}</div>
    </section>
  );
}

/** 设置页表单字段标签（与 ProviderSettings Field 同款）。 */
export function SettingsField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-2xs text-low">{label}</span>
      {children}
    </label>
  );
}

/** 设置页输入框统一样式（与 ProviderSettings INPUT_CLASS 同款）。 */
export const SETTINGS_INPUT_CLASS =
  "h-8 w-full rounded-md border border-border-base bg-raised px-2 text-2xs text-hi outline-none placeholder:text-faint focus:border-accent-dim";

export function rpcErrorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
