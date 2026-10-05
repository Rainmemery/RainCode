/**
 * 设置页 · 「Provider 与模型」Tab 内容（03 §6.2；UI 管理面板深化轮自整页迁入 SettingsView，
 * 自身头行「← 返回 / 设置 · Provider 与模型」上移至 SettingsView 头部，卡片与添加表单行为零变更）：
 * Provider 卡片列表（活跃项 accent 边框 + 徽章、非活跃项「切换」）+ 添加 Provider 表单
 * （成功后清空，错误就地呈现）。
 */
import { useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { useDesktop } from "../store.js";

const EMPTY_FORM = { name: "", baseURL: "", model: "", apiKey: "", maxContextTokens: "128000" };

const INPUT_CLASS =
  "h-8 w-full rounded-md border border-border-base bg-raised px-2 text-2xs text-hi outline-none placeholder:text-faint focus:border-accent-dim";

interface FieldProps {
  label: string;
  children: ReactNode;
}

function Field({ label, children }: FieldProps) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-2xs text-low">{label}</span>
      {children}
    </label>
  );
}

export default function ProviderSettings() {
  const providers = useDesktop((s) => s.providers);
  const activeProviderId = useDesktop((s) => s.activeProviderId);
  const addProvider = useDesktop((s) => s.addProvider);
  const switchProvider = useDesktop((s) => s.switchProvider);
  const [form, setForm] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) return;
    const name = form.name.trim();
    const baseURL = form.baseURL.trim();
    const model = form.model.trim();
    if (name === "" || baseURL === "" || model === "") {
      setFormError("名称、Base URL 与模型为必填项");
      return;
    }
    const parsedTokens = Number.parseInt(form.maxContextTokens, 10);
    setSubmitting(true);
    setFormError(null);
    try {
      await addProvider({
        name,
        baseURL,
        model,
        ...(form.apiKey.trim() !== "" && { apiKey: form.apiKey.trim() }),
        maxContextTokens: Number.isNaN(parsedTokens) ? 128000 : parsedTokens,
      });
      setForm(EMPTY_FORM);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {providers.map((provider) => {
        const active = provider.id === activeProviderId;
        return (
          <div
            key={provider.id}
            className={`rounded-lg border bg-card p-4 ${active ? "border-accent" : "border-border-base"}`}
          >
            <div className="flex items-center gap-2">
              <span className="font-medium text-hi">{provider.name}</span>
              <span className="mono rounded-sm border border-border-faint bg-[color-mix(in_srgb,var(--info)_8%,transparent)] px-1.5 py-0.5 text-2xs text-info">
                {provider.model}
              </span>
              {active ? (
                <span className="ml-auto rounded-sm border border-accent bg-accent-bg px-1.5 py-0.5 text-2xs text-accent">
                  活跃
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => void switchProvider(provider.id)}
                  className="ml-auto h-7 rounded-md border border-border-strong px-3 text-2xs text-mid hover:bg-hover"
                >
                  切换
                </button>
              )}
            </div>
            <div className="mono mt-1.5 truncate text-2xs text-low">{provider.baseURL}</div>
            <div className="mt-1.5 flex items-center gap-4 text-2xs">
              <span className={`flex items-center gap-1.5 ${provider.apiKeyConfigured ? "text-ok" : "text-warn"}`}>
                <span className={`dot ${provider.apiKeyConfigured ? "dot-ok" : "dot-warn"}`} />
                {provider.apiKeyConfigured ? "API Key 已配置" : "API Key 未配置"}
              </span>
              <span className="text-faint">上下文 {provider.maxContextTokens} tokens</span>
            </div>
          </div>
        );
      })}
      <form onSubmit={(event) => void handleSubmit(event)} className="rounded-lg border border-border-base bg-card p-4">
        <div className="mb-3 font-medium text-hi">添加 Provider</div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="名称">
            <input
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              className={INPUT_CLASS}
              placeholder="例如 deepseek"
            />
          </Field>
          <Field label="模型">
            <input
              value={form.model}
              onChange={(event) => setForm({ ...form, model: event.target.value })}
              className={INPUT_CLASS}
              placeholder="例如 deepseek-chat"
            />
          </Field>
          <div className="col-span-2">
            <Field label="Base URL">
              <input
                value={form.baseURL}
                onChange={(event) => setForm({ ...form, baseURL: event.target.value })}
                className={INPUT_CLASS}
                placeholder="https://api.example.com/v1"
              />
            </Field>
          </div>
          <Field label="API Key（可选）">
            <input
              type="password"
              value={form.apiKey}
              onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
              className={INPUT_CLASS}
              placeholder="留空则使用环境变量"
            />
          </Field>
          <Field label="最大上下文 tokens">
            <input
              type="number"
              value={form.maxContextTokens}
              onChange={(event) => setForm({ ...form, maxContextTokens: event.target.value })}
              className={INPUT_CLASS}
            />
          </Field>
        </div>
        {formError !== null && <div className="mt-2 text-2xs text-danger">{formError}</div>}
        <button
          type="submit"
          disabled={submitting}
          className="mt-3 h-8 rounded-md bg-accent px-4 text-2xs text-on-accent hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
        >
          添加 Provider
        </button>
      </form>
    </div>
  );
}
