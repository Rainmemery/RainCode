/**
 * Provider 设置（AC-10/AC-11；UI 重设计轮对齐赤陶磷光 v2；ui-panel-deepening 轮迁入
 * SettingsView 作为「Provider 与模型」Tab 内容——「← 返回」头行移除，头部职责归 SettingsView）：
 * Provider 卡片列表（活跃项 accent 边框 + 活跃徽章、模型 info 徽标）+ 添加表单。
 * apiKey 经 RPC 内存传递，不落盘不落日志。
 */
import { useState } from "react";
import { useWeb } from "../state.js";

const INPUT_CLASS =
  "h-8 w-full rounded-md border border-border-base bg-raised px-2 text-2xs text-hi outline-none placeholder:text-faint transition-colors duration-fast focus:border-accent-dim";

export function ProviderSettings(): JSX.Element {
  const providers = useWeb((s) => s.providers);
  const activeProviderId = useWeb((s) => s.activeProviderId);
  const addProvider = useWeb((s) => s.addProvider);
  const switchProvider = useWeb((s) => s.switchProvider);
  const [name, setName] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [maxContextTokens, setMaxContextTokens] = useState(32768);

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-3 px-6 py-5">
      {providers.length === 0 ? (
        <div className="rounded-lg border border-border-faint bg-card px-4 py-3 text-2xs text-faint">尚未配置 Provider</div>
      ) : null}
      {providers.map((p) => {
        const active = p.id === activeProviderId;
        return (
          <div key={p.id} className={`rounded-lg border bg-card p-4 ${active ? "border-accent" : "border-border-base"}`}>
            <div className="flex items-center gap-2">
              <span className="text-2xs font-medium text-hi">{p.name}</span>
              <span className="mono rounded-sm border border-border-faint bg-info/10 px-1.5 py-0.5 text-2xs text-info">
                {p.model}
              </span>
              {active ? (
                <span className="ml-auto rounded-sm border border-accent bg-accent-bg px-1.5 py-0.5 text-2xs text-accent">活跃</span>
              ) : (
                <button
                  className="ml-auto h-7 rounded-md border border-border-strong px-3 text-2xs text-mid transition-colors duration-fast hover:bg-hover"
                  onClick={() => void switchProvider(p.id)}
                >
                  切换
                </button>
              )}
            </div>
            <div className="mono mt-1.5 truncate text-2xs text-low">{p.baseURL}</div>
            <div className="mt-1.5 flex items-center gap-4 text-2xs">
              {p.apiKeyConfigured ? (
                <span className="flex items-center gap-1.5 text-ok">
                  <span className="dot dot-ok" />
                  密钥已配置
                </span>
              ) : (
                <span className="flex items-center gap-1.5 text-warn">
                  <span className="dot dot-warn" />
                  密钥未配置
                </span>
              )}
              <span className="text-faint">上下文 {p.maxContextTokens} tokens</span>
            </div>
          </div>
        );
      })}
      <h3 className="mt-2 text-2xs font-medium text-mid">添加 Provider</h3>
      <div className="grid max-w-xl grid-cols-2 gap-2.5 text-sm">
        <input className={INPUT_CLASS} placeholder="名称" value={name} onChange={(e) => setName(e.target.value)} />
        <input className={INPUT_CLASS} placeholder="Base URL" value={baseURL} onChange={(e) => setBaseURL(e.target.value)} />
        <input className={INPUT_CLASS} placeholder="模型" value={model} onChange={(e) => setModel(e.target.value)} />
        <input
          className={INPUT_CLASS}
          placeholder="maxContextTokens"
          value={String(maxContextTokens)}
          onChange={(e) => setMaxContextTokens(Number(e.target.value) || 32768)}
        />
        <input
          className={`${INPUT_CLASS} col-span-2`}
          placeholder="API Key（仅内存传递，服务端不落盘）"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
        <button
          className="col-span-2 h-8 rounded-md bg-accent px-3 text-2xs text-on-accent transition-colors duration-fast hover:bg-accent-hover"
          onClick={() => {
            if (name.length === 0 || baseURL.length === 0 || model.length === 0) return;
            void addProvider({
              name,
              baseURL,
              model,
              maxContextTokens,
              ...(apiKey.length > 0 && { apiKey }),
            });
            setName("");
            setBaseURL("");
            setModel("");
            setApiKey("");
          }}
        >
          添加
        </button>
      </div>
    </div>
  );
}
