/**
 * 设置页（UI 管理面板深化轮；polish-ui-states-and-runtime 扩至七组）：顶行「← 返回」+ 标题「设定」；
 * 左侧 200px 垂直导航七组（通用 / Provider 与模型 / 命令权限 / MCP 服务器 / 快捷键 / 关于 / 工具，
 * 激活项左侧 2px accent 指示条），右侧内容区 flex-1 overflow-y-auto（区块标题 + 卡片 rounded-md）。
 * 「Provider 与模型」Tab 迁入 ProviderSettings（行为零变更）；命令权限 / MCP 服务器拆分至
 * SettingsPermissions.tsx / SettingsMcp.tsx（500 行治理）；「工具」组拆至 SettingsTools.tsx；
 * 「← 返回」自 ProviderSettings 头行上移至此。默认组：无活跃 Provider 时开「Provider 与模型」
 * （自包含规则，仅本文件，用于引导首次配置）。
 */
import { useEffect, useState } from "react";
import { RpcCallError } from "@raincode/rpc/client";
import type { SystemVersionResult } from "@raincode/shared";
import { rpcCall, useDesktop } from "../store.js";
import { THEME_LABEL } from "../theme.js";
import type { ThemePref } from "../theme.js";
import ProviderSettings from "./ProviderSettings.js";
import SettingsPermissions from "./SettingsPermissions.js";
import SettingsMcp from "./SettingsMcp.js";
import SettingsTools from "./SettingsTools.js";
import { SettingsCard } from "./SettingsCard.js";

type SettingsTab = "general" | "provider" | "permissions" | "mcp" | "shortcuts" | "about" | "tools";

const NAV: Array<{ key: SettingsTab; label: string }> = [
  { key: "general", label: "通用" },
  { key: "provider", label: "Provider 与模型" },
  { key: "permissions", label: "命令权限" },
  { key: "mcp", label: "MCP 服务器" },
  { key: "shortcuts", label: "快捷键" },
  { key: "about", label: "关于" },
  { key: "tools", label: "工具" },
];

/** 主题三态 segmented（深色/浅色/跟随系统）：与侧栏「◐」同一 store 状态源，激活项 accent 底。 */
function GeneralTab() {
  const theme = useDesktop((s) => s.theme);
  const setTheme = useDesktop((s) => s.setTheme);
  const workspace = useDesktop((s) => s.workspace);
  return (
    <>
      <SettingsCard title="主题">
        <div className="inline-flex items-center gap-0.5 rounded-md border border-border-faint bg-raised p-0.5">
          {(Object.keys(THEME_LABEL) as ThemePref[]).map((pref) => (
            <button
              key={pref}
              type="button"
              onClick={() => setTheme(pref)}
              className={`h-7 rounded-sm px-3 text-2xs transition-colors duration-fast ${
                theme === pref ? "bg-accent text-on-accent" : "text-mid hover:text-hi"
              }`}
              title={`切换为${THEME_LABEL[pref]}主题`}
            >
              {THEME_LABEL[pref]}
            </button>
          ))}
        </div>
      </SettingsCard>
      <SettingsCard title="工作区">
        <div className="mono truncate text-2xs text-mid" title={workspace ?? undefined}>
          {workspace ?? "未选择（侧栏点击切换项目目录）"}
        </div>
      </SettingsCard>
      <SettingsCard title="语言">
        <div className="flex items-center gap-2 text-2xs">
          <span className="text-hi">中文（zh-CN）</span>
          <span className="text-faint">en-US 预留</span>
        </div>
      </SettingsCard>
    </>
  );
}

/** 快捷键静态两列表（.kbd 芯片；UI 管理面板深化轮）。 */
const SHORTCUT_ROWS: Array<[string[], string]> = [
  [["Ctrl", "N"], "新建会话"],
  [["Ctrl", "J"], "右侧上下文面板"],
  [["Enter"], "发送"],
  [["1–4"], "审批直选"],
  [["Esc"], "拒绝 · 关闭"],
  [["↑↓", "Tab"], "斜杠面板"],
];

function ShortcutsTab() {
  return (
    <SettingsCard title="键盘快捷键">
      <div className="flex flex-col">
        {SHORTCUT_ROWS.map(([keys, action]) => (
          <div key={action} className="flex h-8 items-center gap-3 border-b border-border-faint last:border-b-0">
            <span className="flex w-40 shrink-0 items-center gap-1">
              {keys.map((key, index) => (
                <span key={key} className="flex items-center gap-1">
                  {index > 0 && <span className="text-2xs text-faint">+</span>}
                  <span className="kbd">{key}</span>
                </span>
              ))}
            </span>
            <span className="text-2xs text-mid">{action}</span>
          </div>
        ))}
      </div>
      <div className="mt-2 text-2xs text-faint">浏览器端可能保留 Ctrl+N / Ctrl+J（桌面端完整可用）</div>
    </SettingsCard>
  );
}

/** 关于（system.version）：协议/应用/配置/Node 四行（nodeVersion 缺省省略）+ 文档指引。 */
function AboutTab() {
  const [version, setVersion] = useState<SystemVersionResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void rpcCall<SystemVersionResult>("system.version", {})
      .then((result) => {
        if (!cancelled) setVersion(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof RpcCallError ? `${err.code}: ${err.message}` : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <SettingsCard title="关于">
      {error !== null && <div className="text-2xs text-danger">{error}</div>}
      {version === null && error === null && (
        <div className="flex flex-col gap-2" role="status" aria-label="加载中">
          <div className="skeleton h-5 w-full" aria-hidden="true" />
          <div className="skeleton h-5 w-2/3" aria-hidden="true" />
        </div>
      )}
      {version !== null && (
        <div className="flex flex-col">
          <AboutRow label="协议版本" value={version.protocolVersion} />
          <AboutRow label="应用版本" value={version.appVersion} />
          <AboutRow label="配置版本" value={String(version.configVersion)} />
          {version.nodeVersion !== undefined && <AboutRow label="Node 版本" value={version.nodeVersion} />}
        </div>
      )}
      <div className="mt-2 border-t border-border-faint pt-2 text-2xs text-faint">
        docs/ 目录：01-PRD · 03-ui-design · 06-api-spec
      </div>
    </SettingsCard>
  );
}

function AboutRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex h-8 items-center gap-3 border-b border-border-faint last:border-b-0">
      <span className="w-20 shrink-0 text-2xs text-low">{label}</span>
      <span className="mono text-2xs text-hi">{value}</span>
    </div>
  );
}

export default function SettingsView() {
  const setView = useDesktop((s) => s.setView);
  // 无活跃 Provider（含 providers 为空）时默认开「Provider 与模型」引导配置；否则开「通用」（只读初值，自包含）
  const [tab, setTab] = useState<SettingsTab>(() =>
    useDesktop.getState().activeProviderId === null ? "provider" : "general",
  );

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-base">
      <header className="flex h-10 shrink-0 items-center gap-3 border-b border-border-base bg-panel px-4">
        <button type="button" onClick={() => setView("chat")} className="text-2xs text-mid hover:text-hi" title="返回主工作区">
          ← 返回
        </button>
        <span className="text-2xs text-hi">设定</span>
      </header>
      <div className="flex min-h-0 flex-1">
        {/* 左侧垂直导航（32px 行；激活项 text-hi + 2px accent 指示条） */}
        <nav className="flex w-[200px] shrink-0 flex-col border-r border-border-base bg-panel py-2">
          {NAV.map((item) => {
            const active = item.key === tab;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => setTab(item.key)}
                className={`relative flex h-8 shrink-0 items-center px-4 text-left text-2xs transition-colors duration-fast ${
                  active ? "text-hi" : "text-mid hover:text-hi"
                }`}
              >
                {active && <span className="absolute inset-y-1 left-0 w-0.5 bg-accent" />}
                {item.label}
              </button>
            );
          })}
        </nav>
        {/* 右侧内容区 */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4 px-6 py-5">
            {tab === "general" && <GeneralTab />}
            {tab === "provider" && (
              <>
                <div className="text-xs text-mid">Provider 与模型</div>
                <ProviderSettings />
              </>
            )}
            {tab === "permissions" && <SettingsPermissions />}
            {tab === "mcp" && <SettingsMcp />}
            {tab === "shortcuts" && <ShortcutsTab />}
            {tab === "about" && <AboutTab />}
            {tab === "tools" && <SettingsTools />}
          </div>
        </div>
      </div>
    </div>
  );
}
