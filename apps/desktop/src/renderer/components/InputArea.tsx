/**
 * 底部输入区（03 §6.1 第 6 条）：bg-raised 圆角框聚焦转 accent-dim 边框；textarea 自适应
 * 3~8 行，Enter 发送（Shift+Enter 换行，IME 组合中不发送）；流式中发送钮变「停止」；
 * 下方弱化提示行显示当前模型或 Provider 引导；ctx 用量条（refine-ui-context-panel 轮 §7）：
 * 「模型 · ctx N%」+ 微型进度条（N=累计 tokens/窗口 tokens，服务端已算好），
 * >80% 琥珀 >95% 红（ctxLevel 分档）；无 contextUsage 数据仅显示模型名。
 * T3.9 斜杠命令面板（UI-4）：输入以「/」开头时浮出技能面板（skills.list，含 workspace 层），
 * ↑↓ 选择 / Tab 补全 / Enter 直发；发送路径解析 /name args → skills.invoke（展开在 server 侧，
 * 06 §2.9，与 CLI 同语义），SKILL_NOT_FOUND 经错误横条呈现。
 * polish-ui-states-and-runtime C4/C5（§6.1 / §7）：提示行模型名改按钮 → 弹层列
 * `config.providers.list`（名称 + 模型，活跃标记）→ 点选 `config.providers.switch` 并刷新投影
 * （仅影响后续请求，04 §5.2）；无活跃 Provider / 列表为空时文本域与发送钮置灰禁用 + 引导条跳设置页。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RpcCallError } from "@raincode/rpc/client";
import type { SkillSummary } from "@raincode/shared";
import { parseSlashInvocation } from "../session-view.js";
import type { ProviderRow } from "../session-view.js";
import { ctxLevel } from "../subagent-view.js";
import { rpcCall, useDesktop } from "../store.js";
import { StatusBanner } from "./StatusBanner.js";

const MAX_HEIGHT_PX = 168;

export default function InputArea() {
  const streaming = useDesktop((s) => s.streaming);
  const activeId = useDesktop((s) => s.activeId);
  const providers = useDesktop((s) => s.providers);
  const activeProviderId = useDesktop((s) => s.activeProviderId);
  // 活跃会话 ctx 用量（session.list/snapshot 随行，服务端已算好；refine-ui-context-panel 轮）
  const contextUsage = useDesktop((s) =>
    s.activeId === null ? undefined : s.sessions.find((row) => row.id === s.activeId)?.contextUsage,
  );
  const send = useDesktop((s) => s.send);
  const invokeSkill = useDesktop((s) => s.invokeSkill);
  const cancel = useDesktop((s) => s.cancel);
  const setView = useDesktop((s) => s.setView);
  const compactSession = useDesktop((s) => s.compactSession);
  const switchProvider = useDesktop((s) => s.switchProvider);
  const [text, setText] = useState("");
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
      const list = await rpcCall<{ providers: ProviderRow[]; activeProviderId?: string }>("config.providers.list", {});
      useDesktop.setState({ providers: list.providers, activeProviderId: list.activeProviderId ?? null });
      setProviderLoaded(true);
    } catch {
      // 拉取失败不阻断输入（连接态横幅负责报错）；保持现有投影
    }
  }, []);

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  const provider = providers.find((p) => p.id === activeProviderId) ?? null;
  // 未配置 Provider 引导（03 §7）：成功拉取且（列表为空 / 无活跃项）→ 输入区置灰停用
  const providerReady = !providerLoaded || (providers.length > 0 && activeProviderId !== null);
  const canSend = activeId !== null && providerReady && text.trim() !== "" && !streaming;

  const slashMode = text.startsWith("/");
  const query = slashMode ? text.slice(1).replace(/\s+[\s\S]*$/, "") : "";
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
  }, [text]);

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
    setText(`/${skill.name} `);
    areaRef.current?.focus();
  }

  function handleSend(): void {
    if (activeId === null || !providerReady || streaming) return;
    const trimmed = text.trim();
    if (trimmed === "") return;
    if (trimmed.startsWith("/")) {
      const invocation = parseSlashInvocation(trimmed);
      if (invocation === null) {
        useDesktop.setState({ error: "无效的斜杠命令（名字域 [a-z0-9-]，输入 / 查看可用技能）" });
        return;
      }
      void invokeSkill(invocation.name, invocation.args);
    } else {
      void send(trimmed);
    }
    setText("");
    setPaletteDismissed(false);
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
      await switchProvider(providerId); // 成功即回填 activeProviderId（Provider 投影刷新）
    } catch (err) {
      useDesktop.setState({ error: err instanceof RpcCallError ? `${err.code}: ${err.message}` : String(err) });
    }
  }

  // ctx 用量条（§7）：pct = tokens/maxTokens*100 clamp 0-100；无 contextUsage 数据不渲染该段
  const maxTokens = contextUsage?.maxTokens ?? 0;
  const ctxPct =
    contextUsage !== undefined && maxTokens > 0
      ? Math.min(100, Math.max(0, Math.round((contextUsage.tokens / maxTokens) * 100)))
      : null;
  const level = ctxPct !== null ? ctxLevel(ctxPct) : "ok";

  return (
    <div className="px-6 pb-3 pt-2">
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
          <div className="absolute bottom-full left-0 right-0 mb-1 overflow-hidden rounded-md border border-border-base bg-popover shadow-lg">
            {filtered.slice(0, 8).map((skill, index) => (
              <button
                key={skill.name}
                type="button"
                onClick={() => completeWith(skill)}
                onMouseEnter={() => setHighlight(index)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${index === highlight ? "bg-selected" : ""}`}
              >
                <span className="mono shrink-0 text-2xs text-hi">/{skill.name}</span>
                {skill.argumentHint !== undefined && <span className="shrink-0 text-2xs text-faint">{skill.argumentHint}</span>}
                <span className="rounded border border-border-strong px-1 text-2xs text-faint">{skill.source}</span>
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
        <div className="flex items-end gap-2 rounded-lg border border-border-base bg-raised px-3 py-2 focus-within:border-accent-dim">
          <textarea
            ref={areaRef}
            rows={3}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              const enterPressed = event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing;
              if (paletteOpen && filtered.length > 0) {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setHighlight((prev) => (prev + 1) % Math.min(filtered.length, 8));
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setHighlight((prev) => (prev - 1 + Math.min(filtered.length, 8)) % Math.min(filtered.length, 8));
                  return;
                }
                if (event.key === "Tab") {
                  event.preventDefault();
                  completeWith(filtered[highlight]!);
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setPaletteDismissed(true);
                  return;
                }
                if (enterPressed && !/\s/.test(text.slice(1))) {
                  // 命令名未敲完（无参）：Enter 补全；已在输参（含尾随空格）则落到下方正常发送
                  event.preventDefault();
                  completeWith(filtered[highlight]!);
                  return;
                }
              }
              if (enterPressed) {
                event.preventDefault();
                handleSend();
              }
            }}
            disabled={!providerReady}
            placeholder={providerReady ? "输入消息，/ 唤起技能命令，Enter 发送" : "先配置模型 Provider…"}
            className="min-h-[60px] max-h-[168px] flex-1 resize-none bg-transparent text-hi outline-none placeholder:text-faint disabled:cursor-not-allowed disabled:opacity-50"
          />
          {streaming ? (
            <button
              type="button"
              onClick={() => void cancel()}
              className="h-8 shrink-0 rounded-md bg-accent px-3 text-2xs text-on-accent hover:bg-accent-hover"
              title="停止生成"
            >
              <span className="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm bg-current align-middle" />
              停止
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSend}
              disabled={!canSend}
              className="h-8 shrink-0 rounded-md bg-accent px-3 text-2xs text-on-accent hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
            >
              发送
            </button>
          )}
        </div>
      </div>
      {provider !== null && (
        <div className="relative flex items-center px-1 pt-1 text-2xs">
          <span className="min-w-0 flex-1 truncate text-faint">
            <button
              type="button"
              onClick={toggleModelMenu}
              onKeyDown={(event) => {
                if (event.key === "Escape") setModelMenuOpen(false);
              }}
              title="活跃 Provider 模型（点击快切，仅影响后续请求）"
              className="max-w-full truncate align-baseline transition-colors duration-fast hover:text-mid"
            >
              {provider.name} · {provider.model}
            </button>
            {ctxPct !== null && contextUsage !== undefined && (
              <span
                className="ml-2 inline-flex items-center gap-1.5 align-middle"
                title={`上下文用量估算：累计 ${String(contextUsage.tokens)} tokens / 窗口 ${String(contextUsage.maxTokens)} tokens`}
              >
                ctx {String(ctxPct)}%
                <span className="inline-block h-1 w-16 rounded bg-raised">
                  <span
                    className={`block h-1 rounded ${level === "danger" ? "bg-danger" : level === "warn" ? "bg-warn" : "bg-ok"}`}
                    style={{ width: `${String(ctxPct)}%` }}
                  />
                </span>
              </span>
            )}
          </span>
          {/* 压缩入口（UI 管理面板深化轮）：ctx 用量行右侧幽灵按钮；流式中禁用 */}
          {activeId !== null && (
            <button
              type="button"
              onClick={() => void compactSession()}
              disabled={streaming}
              className="shrink-0 text-2xs text-low transition-colors duration-fast hover:text-hi disabled:cursor-not-allowed disabled:opacity-40"
              title="压缩上下文（总结历史释放窗口）"
            >
              压缩
            </button>
          )}
          {modelMenuOpen && (
            <div className="anim-rise absolute bottom-full left-0 z-10 mb-1.5 w-64 overflow-hidden rounded-lg border border-border-base bg-popover shadow-2">
              <div className="border-b border-border-faint px-3 py-1.5 text-2xs text-faint">
                切换 Provider（仅影响后续请求，会话历史不动）
              </div>
              {providers.length === 0 ? (
                <div className="px-3 py-2 text-2xs text-faint">暂无已配置 Provider</div>
              ) : (
                providers.map((row) => (
                  <button
                    key={row.id}
                    type="button"
                    onClick={() => void pickProvider(row.id)}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors duration-fast hover:bg-hover ${
                      row.id === activeProviderId ? "bg-selected" : ""
                    }`}
                  >
                    <span className={`min-w-0 flex-1 truncate text-2xs ${row.id === activeProviderId ? "text-hi" : "text-mid"}`}>
                      {row.name}
                    </span>
                    <span className="mono min-w-0 shrink-0 truncate text-2xs text-faint">{row.model}</span>
                    {row.id === activeProviderId && (
                      <span className="shrink-0 rounded-sm border border-accent px-1 text-2xs text-accent">活跃</span>
                    )}
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
