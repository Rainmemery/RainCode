/** Provider 设置：列表/添加/切换（AC-10/AC-11；apiKey 经 RPC 内存传递，不落盘不落日志）。 */
import { useState } from "react";
import { useWeb } from "../state.js";

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
    <div className="flex-1 overflow-y-auto p-6">
      <h2 className="mb-4 text-lg font-semibold">Provider 设置</h2>
      <div className="mb-6 space-y-2">
        {providers.length === 0 ? <p className="text-sm text-gray-500">尚未配置 Provider</p> : null}
        {providers.map((p) => (
          <div key={p.id} className="flex items-center justify-between rounded border border-ink-700 bg-ink-900 px-3 py-2 text-sm">
            <div>
              <span className="font-medium">{p.name}</span>{" "}
              <span className="text-xs text-gray-500">{p.baseURL} · {p.model} · {p.maxContextTokens} tok</span>
              {p.apiKeyConfigured ? <span className="ml-2 text-xs text-ok">密钥已配置</span> : null}
            </div>
            {p.id === activeProviderId ? (
              <span className="rounded bg-ok/20 px-2 py-0.5 text-xs text-ok">活跃</span>
            ) : (
              <button className="rounded bg-ink-700 px-2 py-1 text-xs" onClick={() => void switchProvider(p.id)}>
                切换
              </button>
            )}
          </div>
        ))}
      </div>
      <h3 className="mb-2 text-sm font-semibold">添加 Provider</h3>
      <div className="grid max-w-xl grid-cols-2 gap-2 text-sm">
        <input className="rounded border border-ink-700 bg-ink-950 px-2 py-1.5" placeholder="名称" value={name} onChange={(e) => setName(e.target.value)} />
        <input className="rounded border border-ink-700 bg-ink-950 px-2 py-1.5" placeholder="Base URL" value={baseURL} onChange={(e) => setBaseURL(e.target.value)} />
        <input className="rounded border border-ink-700 bg-ink-950 px-2 py-1.5" placeholder="模型" value={model} onChange={(e) => setModel(e.target.value)} />
        <input
          className="rounded border border-ink-700 bg-ink-950 px-2 py-1.5"
          placeholder="maxContextTokens"
          value={String(maxContextTokens)}
          onChange={(e) => setMaxContextTokens(Number(e.target.value) || 32768)}
        />
        <input
          className="col-span-2 rounded border border-ink-700 bg-ink-950 px-2 py-1.5"
          placeholder="API Key（仅内存传递，服务端不落盘）"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
        <button
          className="col-span-2 rounded bg-accent-dim px-3 py-1.5 text-white"
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
