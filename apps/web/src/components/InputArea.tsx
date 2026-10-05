/**
 * 输入区（03 §6.5 Web 适配；T4.5 斜杠命令面板对齐桌面端 UI-4；refine-ui-context-panel 轮
 * 增 ctx 用量提示行）：Enter 发送 / Shift+Enter 换行 / IME 组合中不发送 / 流式中发送钮变
 * 「停止」；输入以「/」开头时浮出技能面板（skills.list，workspace+global 双层），↑↓ 选择 /
 * Tab 补全 / Enter 执行 / Esc 关闭；发送路径解析 /name args → skills.invoke（展开在 server 侧，
 * 06 §2.9，与 CLI/桌面端同语义）。
 * polish-ui-states-and-runtime 轮 C4~C5：ctx 行模型名改按钮 → 快切弹层（config.providers.list →
 * config.providers.switch，仅影响后续请求、会话历史不动 04 §5.2）；无活跃 Provider / 列表为空时
 * 输入区置灰停用 + StatusBanner 引导跳设置页（03 §7）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RpcCallError } from "@raincode/rpc/web";
import type { ProviderInfo, SkillSummary } from "@raincode/shared";
import { parseSlashInvocation } from "../session-view.js";
import { ctxLevel } from "../subagent-view.js";
import { rpcCall, useWeb } from "../state.js";
import { StatusBanner } from "./StatusBanner.js";

const MAX_HEIGHT_PX = 168;

export function InputArea(): JSX.Element {
  const send = useWeb((s) => s.send);
  const cancel = useWeb((s) => s.cancel);
  const invokeSkill = useWeb((s) => s.invokeSkill);
  const streaming = useWeb((s) => s.streaming);
  const activeId = useWeb((s) => s.activeId);
  const compactSession = useWeb((s) => s.compactSession);
  const setView = useWeb((s) => s.setView);
  const providers = useWeb((s) => s.providers);
  const activeProviderId = useWeb((s) => s.activeProviderId);
  const switchProvider = useWeb((s) => s.switchProvider);
  // ctx 用量条数据源（refine-ui-context-panel 轮，03 §7）：sessions 行 contextUsage + 活跃 Provider 模型名
  const contextUsage = useWeb((s) => (s.activeId !== null ? s.sessions.find((row) => row.id === s.activeId)?.contextUsage : undefined));
  const model = useWeb((s) => s.providers.find((p) => p.id === s.activeProviderId)?.model);
  const [draft, setDraft] = useState("");
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [paletteDismissed, setPaletteDismissed] = useState(false);
  const [highlight, setHighlight] = useState(0);
  /** Provider 投影是否已成功拉取（未拉取前不启用「未配置」禁用，避免首载竞态误锁输入）。 */
  const [providerLoaded, setProviderLoaded] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  /** Provider 投影刷新（config.providers.list；模型快切与未配置引导共用同一数据源）。 */
  const loadProviders = useCallback(async (): Promise<void> => {
    try {
      const list = await rpcCall<{ providers: ProviderInfo[]; activeProviderId?: string }>("config.providers.list", {});
      useWeb.setState({ providers: list.providers, activeProviderId: list.activeProviderId ?? null });
      setProviderLoaded(true);
    } catch {
      // 拉取失败不阻断输入（连接态横幅负责报错）；保持现有投影
    }
  }, []);

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  // 未配置 Provider 引导（03 §7）：成功拉取且（列表为空 / 无活跃项）→ 输入区置灰停用
  const providerReady = !providerLoaded || (providers.length > 0 && activeProviderId !== null);

  // ctx 百分比（clamp 0-100）；maxTokens 缺失/为 0 时不显示用量段
  const pct =
    contextUsage !== undefined && contextUsage.maxTokens > 0
      ? Math.min(100, Math.max(0, Math.round((contextUsage.tokens / contextUsage.maxTokens) * 100)))
      : null;
  const level = pct !== null ? ctxLevel(pct) : null;

  const slashMode = draft.startsWith("/");
  const query = slashMode ? draft.slice(1).replace(/\s+[\s\S]*$/, "") : "";
  const paletteOpen = slashMode && !paletteDismissed && activeId !== null;
  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return skills.filter((skill) => q === "" || skill.name.startsWith(q));
  }, [skills, query]);

  useEffect(() => {
    const el = areaRef.current;
    if (el === null) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [draft]);

  // 面板打开时拉取技能清单（含当前会话 workspace 层，06 §2.9；低频拉取成本可忽略）
  useEffect(() => {
    if (!paletteOpen || activeId === null) return;
    let cancelled = false;
    void rpcCall<{ items: SkillSummary[] }>("skills.list", { sessionId: activeId })
      .then((result) => {
        if (!cancelled) setSkills(result.items);
      })
      .catch(() => undefined); // 清单拉取失败不阻塞输入；发送路径由服务端权威判定
    return () => {
      cancelled = true;
    };
  }, [paletteOpen, activeId]);

  useEffect(() => {
    setHighlight(0);
  }, [query, skills.length]);

  function completeWith(skill: SkillSummary): void {
    setDraft(`/${skill.name} `);
    areaRef.current?.focus();
  }

  /** 模型快切弹层开合：打开即刷新 Provider 投影（config.providers.list）。 */
  function toggleModelMenu(): void {
    if (modelMenuOpen) {
      setModelMenuOpen(false);
      return;
    }
    setModelMenuOpen(true);
    void loadProviders();
  }

  /** 切换活跃 Provider（config.providers.switch）：仅影响后续请求的客户端绑定，会话历史不动（04 §5.2）。 */
  async function pickProvider(providerId: string): Promise<void> {
    setModelMenuOpen(false);
    if (providerId === activeProviderId) return;
    try {
      await switchProvider(providerId); // 成功后回填 activeProviderId（ctx 行模型名即时更新）
      await loadProviders(); // 再拉一次权威投影（列表 + 活跃项），下一次发送使用新 Provider
    } catch (err) {
      useWeb.setState({ error: err instanceof RpcCallError ? `${err.code}: ${err.message}` : String(err) });
    }
  }

  function submit(): void {
    const text = draft.trim();
    if (text.length === 0 || streaming || !providerReady) return;
    if (text.startsWith("/")) {
      const invocation = parseSlashInvocation(text);
      if (invocation === null) {
        useWeb.setState({ error: "无效的斜杠命令（名字域 [a-z0-9-]，输入 / 查看可用技能）" });
        return;
      }
      void invokeSkill(invocation.name, invocation.args);
    } else {
      void send(text);
    }
    setDraft("");
    setPaletteDismissed(false);
  }

  return (
    <div className="border-t border-border-base bg-panel px-4 pb-3 pt-2.5">
      {/* 未配置 Provider 引导（03 §7）：无活跃 / 列表为空 → 引导条跳设置页「Provider 与模型」组 */}
      {!providerReady && (
        <div className="mb-2">
          <StatusBanner
            tone="warn"
            text="未配置模型 Provider，输入区已停用"
            action={{ label: "先配置模型 Provider →", onClick: () => setView("settings") }}
          />
        </div>
      )}
      <div className="relative">
        {paletteOpen && filtered.length > 0 && (
          <div className="anim-rise absolute bottom-full left-0 right-0 mb-1.5 overflow-hidden rounded-lg border border-border-base bg-popover shadow-2">
            {filtered.slice(0, 8).map((skill, index) => (
              <button
                key={skill.name}
                type="button"
                onClick={() => completeWith(skill)}
                onMouseEnter={() => setHighlight(index)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors duration-fast ${
                  index === highlight ? "bg-selected" : ""
                }`}
              >
                <span className="mono shrink-0 text-2xs text-accent">/{skill.name}</span>
                {skill.argumentHint !== undefined && <span className="mono shrink-0 text-2xs text-faint">{skill.argumentHint}</span>}
                <span className="shrink-0 rounded-sm border border-border-strong px-1 text-2xs text-low">{skill.source}</span>
                <span className="min-w-0 flex-1 truncate text-2xs text-mid">{skill.description}</span>
              </button>
            ))}
            <div className="flex items-center gap-1 border-t border-border-faint px-3 py-1 text-2xs text-faint">
              <span className="kbd">↑</span>
              <span className="kbd">↓</span>
              <span>选择 ·</span>
              <span className="kbd">Tab</span>
              <span>补全 ·</span>
              <span className="kbd">Enter</span>
              <span>执行 ·</span>
              <span className="kbd">Esc</span>
              <span>关闭</span>
            </div>
          </div>
        )}
        <div className="flex items-end gap-2 rounded-lg border border-border-base bg-raised px-3 py-2 transition-colors duration-fast focus-within:border-accent-dim">
          <textarea
            ref={areaRef}
            className="max-h-[168px] min-h-[44px] flex-1 resize-none bg-transparent text-sm text-hi outline-none placeholder:text-faint disabled:cursor-not-allowed disabled:opacity-40"
            placeholder="输入指令，/ 唤起技能命令（Enter 发送，Shift+Enter 换行）"
            value={draft}
            rows={2}
            disabled={!providerReady}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              const enterPressed = e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing;
              if (paletteOpen && filtered.length > 0) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setHighlight((prev) => (prev + 1) % Math.min(filtered.length, 8));
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setHighlight((prev) => (prev - 1 + Math.min(filtered.length, 8)) % Math.min(filtered.length, 8));
                  return;
                }
                if (e.key === "Tab") {
                  e.preventDefault();
                  completeWith(filtered[highlight]!);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setPaletteDismissed(true);
                  return;
                }
                if (enterPressed && !/\s/.test(draft.slice(1))) {
                  // 命令名未敲完（无参）：Enter 补全；已在输参（含尾随空格）则落到正常发送
                  e.preventDefault();
                  completeWith(filtered[highlight]!);
                  return;
                }
              }
              if (enterPressed) {
                e.preventDefault();
                submit();
              }
            }}
          />
          {streaming ? (
            <button
              className="h-8 shrink-0 rounded-md bg-danger px-3 text-2xs text-on-accent transition-colors duration-fast hover:opacity-90"
              onClick={() => void cancel()}
              title="停止生成"
            >
              <span className="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm bg-current align-middle" />
              停止
            </button>
          ) : (
            <button
              className="h-8 shrink-0 rounded-md bg-accent px-3 text-2xs text-on-accent transition-colors duration-fast hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
              onClick={submit}
              disabled={activeId === null || draft.trim() === "" || streaming || !providerReady}
            >
              发送
            </button>
          )}
        </div>
      </div>
      {/* ctx 用量提示行（03 §7）：「模型 · ctx N%」+ 微型进度条；>80% 琥珀、>95% 红；无数据不渲染 */}
      {model !== undefined || pct !== null ? (
        <div className="relative mt-1.5 flex items-center gap-2 px-1 text-2xs text-faint">
          {modelMenuOpen && (
            <div className="anim-rise absolute bottom-full left-0 z-10 mb-1.5 w-64 overflow-hidden rounded-lg border border-border-base bg-popover shadow-2">
              <div className="border-b border-border-faint px-3 py-1.5 text-2xs text-faint">
                切换 Provider（仅影响后续请求，会话历史不动）
              </div>
              {providers.length === 0 ? (
                <div className="px-3 py-2 text-2xs text-faint">暂无已配置 Provider</div>
              ) : (
                providers.map((provider) => (
                  <button
                    key={provider.id}
                    type="button"
                    onClick={() => void pickProvider(provider.id)}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors duration-fast hover:bg-hover ${
                      provider.id === activeProviderId ? "bg-selected" : ""
                    }`}
                  >
                    <span className={`min-w-0 flex-1 truncate text-2xs ${provider.id === activeProviderId ? "text-hi" : "text-mid"}`}>
                      {provider.name}
                    </span>
                    <span className="mono min-w-0 shrink-0 truncate text-2xs text-faint">{provider.model}</span>
                    {provider.id === activeProviderId && (
                      <span className="shrink-0 rounded-sm border border-accent px-1 text-2xs text-accent">活跃</span>
                    )}
                  </button>
                ))
              )}
            </div>
          )}
          {model !== undefined && (
            <button
              type="button"
              onClick={toggleModelMenu}
              className="mono min-w-0 truncate text-2xs text-faint transition-colors duration-fast hover:text-hi"
              title="活跃 Provider 模型（点击快切）"
            >
              {model}
            </button>
          )}
          {pct !== null && level !== null && contextUsage !== undefined && (
            <>
              {model !== undefined && <span>·</span>}
              <span className={`shrink-0 ${level === "ok" ? "text-low" : level === "warn" ? "text-warn" : "text-danger"}`}>
                ctx {pct}%
              </span>
              <span
                className="h-1 w-16 shrink-0 rounded bg-raised"
                title={`上下文用量估算：累计 ${contextUsage.tokens} tokens / 窗口 ${contextUsage.maxTokens} tokens`}
              >
                <span
                  className={`block h-1 rounded ${level === "ok" ? "bg-ok" : level === "warn" ? "bg-warn" : "bg-danger"}`}
                  style={{ width: `${pct}%` }}
                />
              </span>
            </>
          )}
          <span className="min-w-0 flex-1" />
          <button
            type="button"
            className="shrink-0 text-2xs text-low transition-colors duration-fast hover:text-hi disabled:cursor-not-allowed disabled:opacity-40"
            disabled={streaming}
            onClick={() => void compactSession()}
            title="压缩上下文（总结历史释放窗口）"
          >
            压缩
          </button>
        </div>
      ) : null}
    </div>
  );
}
