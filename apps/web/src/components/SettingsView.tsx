/**
 * 设置页六组导航（ui-panel-deepening 轮主项）：顶行「← 返回」+ 标题「设定」，下方
 * 左侧垂直导航（通用 / Provider 与模型 / 命令权限 / MCP 服务器 / 快捷键 / 关于；激活项
 * text-hi + 2px accent 指示条，32px 行高）+ 右侧内容区。
 * - 通用：主题三态（与侧栏「◐」同状态源）+ 工作区只读行 + 语言静态行（en-US 预留）；
 * - Provider 与模型：ProviderSettings 主体迁入（行为零变更，头行已移除）；
 * - 命令权限 / MCP 服务器：SettingsPermissions / SettingsMcp 分区组件；
 * - 快捷键：静态两列表（.kbd 芯片）+ 浏览器保留键附注；
 * - 关于：system.version 四行 + docs 指引。
 */
import { useEffect, useState } from "react";
import { RpcCallError } from "@raincode/rpc/web";
import type { SystemVersionResult } from "@raincode/shared";
import { rpcCall, useWeb } from "../state.js";
import { THEME_LABEL } from "../theme.js";
import type { ThemePref } from "../theme.js";
import { ProviderSettings } from "./ProviderSettings.js";
import { SettingsPermissions } from "./SettingsPermissions.js";
import { SettingsMcp } from "./SettingsMcp.js";

type SettingsSection = "general" | "provider" | "permissions" | "mcp" | "shortcuts" | "about";

const SECTIONS: Array<{ key: SettingsSection; label: string }> = [
  { key: "general", label: "通用" },
  { key: "provider", label: "Provider 与模型" },
  { key: "permissions", label: "命令权限" },
  { key: "mcp", label: "MCP 服务器" },
  { key: "shortcuts", label: "快捷键" },
  { key: "about", label: "关于" },
];

const THEME_OPTIONS: ThemePref[] = ["dark", "light", "system"];

/** 快捷键两列表（静态；.kbd 芯片）。 */
const SHORTCUTS: Array<{ keys: string[]; desc: string }> = [
  { keys: ["Ctrl", "N"], desc: "新建会话" },
  { keys: ["Ctrl", "J"], desc: "右侧上下文面板" },
  { keys: ["Enter"], desc: "发送" },
  { keys: ["1–4"], desc: "审批直选" },
  { keys: ["Esc"], desc: "拒绝 · 关闭" },
  { keys: ["↑", "↓", "Tab"], desc: "斜杠面板" },
];

/** 通用分区：主题三态 / 工作区只读行 / 语言静态行。 */
function GeneralSection(): JSX.Element {
  const theme = useWeb((s) => s.theme);
  const setTheme = useWeb((s) => s.setTheme);
  const workspace = useWeb((s) => s.workspace);
  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-4 px-6 py-5">
      <section>
        <h3 className="pb-2 text-xs text-mid">主题</h3>
        <div className="flex w-fit gap-1 rounded-md border border-border-faint bg-card p-1">
          {THEME_OPTIONS.map((pref) => (
            <button
              key={pref}
              type="button"
              className={`h-7 rounded-sm px-3 text-2xs transition-colors duration-fast ${
                theme === pref ? "bg-accent text-on-accent" : "text-mid hover:bg-hover hover:text-hi"
              }`}
              onClick={() => setTheme(pref)}
              title={`主题偏好：${THEME_LABEL[pref]}（${pref === "system" ? "跟随系统深浅色" : pref === "dark" ? "深色优先" : "浅色辅助主题"}）`}
            >
              {THEME_LABEL[pref]}
            </button>
          ))}
        </div>
      </section>
      <section>
        <h3 className="pb-2 text-xs text-mid">工作区</h3>
        <div className="rounded-md border border-border-faint bg-card px-3 py-2">
          <div className="flex items-center gap-2 text-2xs">
            <span className="shrink-0 text-low">当前工作区</span>
            <span className="mono min-w-0 flex-1 truncate text-hi" title={workspace ?? undefined}>
              {workspace ?? "未设定"}
            </span>
          </div>
          <p className="mt-1 text-2xs text-faint">在侧栏工作区输入框填写目录（绝对路径）后「设定」。</p>
        </div>
      </section>
      <section>
        <h3 className="pb-2 text-xs text-mid">语言</h3>
        <div className="rounded-md border border-border-faint bg-card px-3 py-2 text-2xs">
          <div className="flex items-center gap-2">
            <span className="text-low">语言</span>
            <span className="text-hi">中文（zh-CN）</span>
          </div>
          <p className="mt-1 text-2xs text-faint">en-US 预留（i18n 资源未装载，界面文案暂仅中文）。</p>
        </div>
      </section>
    </div>
  );
}

/** 快捷键分区：静态两列表 + 浏览器保留键附注。 */
function ShortcutsSection(): JSX.Element {
  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-3 px-6 py-5">
      <section>
        <h3 className="pb-2 text-xs text-mid">快捷键</h3>
        <div className="rounded-md border border-border-faint bg-card">
          {SHORTCUTS.map((shortcut) => (
            <div key={shortcut.desc} className="flex h-8 items-center gap-2 border-b border-border-faint px-3 last:border-b-0">
              <span className="flex w-32 shrink-0 gap-1">
                {shortcut.keys.map((key) => (
                  <kbd key={key} className="kbd">
                    {key}
                  </kbd>
                ))}
              </span>
              <span className="text-2xs text-mid">{shortcut.desc}</span>
            </div>
          ))}
        </div>
        <p className="mt-2 text-2xs text-faint">浏览器可能保留 Ctrl+N/Ctrl+J（桌面端完整可用）。</p>
      </section>
    </div>
  );
}

/** 关于分区：system.version 四行（nodeVersion 缺省省略行）+ docs 指引。 */
function AboutSection(): JSX.Element {
  const [info, setInfo] = useState<SystemVersionResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    rpcCall<SystemVersionResult>("system.version", {})
      .then((result) => {
        if (!cancelled) setInfo(result);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof RpcCallError ? `${err.code}: ${err.message}` : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const rows: Array<[string, string]> =
    info === null
      ? []
      : [
          ["协议版本", info.protocolVersion],
          ["应用版本", info.appVersion],
          ["配置版本", String(info.configVersion)],
          ...(info.nodeVersion !== undefined ? ([["Node 版本", info.nodeVersion]] as Array<[string, string]>) : []),
        ];

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-3 px-6 py-5">
      <section>
        <h3 className="pb-2 text-xs text-mid">关于</h3>
        {error !== null ? (
          <div className="rounded-md border border-border-faint bg-card px-3 py-2 text-2xs text-danger">{error}</div>
        ) : info === null ? (
          <div className="rounded-md border border-border-faint bg-card px-3 py-2 text-2xs text-faint">版本信息加载中…</div>
        ) : (
          <div className="rounded-md border border-border-faint bg-card">
            {rows.map(([label, value]) => (
              <div key={label} className="flex h-8 items-center gap-2 border-b border-border-faint px-3 text-2xs last:border-b-0">
                <span className="w-20 shrink-0 text-low">{label}</span>
                <span className="mono min-w-0 flex-1 truncate text-hi">{value}</span>
              </div>
            ))}
          </div>
        )}
        <p className="mt-2 text-2xs text-faint">docs/ 目录：01-PRD · 03-ui-design · 06-api-spec</p>
      </section>
    </div>
  );
}

export function SettingsView(): JSX.Element {
  const setView = useWeb((s) => s.setView);
  const [section, setSection] = useState<SettingsSection>("general");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-10 shrink-0 items-center gap-3 border-b border-border-base bg-panel px-4">
        <button
          type="button"
          onClick={() => setView("chat")}
          className="text-2xs text-mid transition-colors duration-fast hover:text-hi"
          title="返回主工作区"
        >
          ← 返回
        </button>
        <span className="text-2xs text-hi">设定</span>
      </header>
      <div className="flex min-h-0 flex-1">
        {/* 左侧垂直导航（激活项 text-hi + 2px accent 指示条，32px 行高） */}
        <nav className="flex w-[200px] shrink-0 flex-col gap-0.5 border-r border-border-faint bg-panel px-2 py-3">
          {SECTIONS.map((item) => {
            const active = item.key === section;
            return (
              <button
                key={item.key}
                type="button"
                className={`relative flex h-8 items-center rounded-md px-3 text-left text-2xs transition-colors duration-fast ${
                  active ? "text-hi" : "text-mid hover:bg-hover hover:text-hi"
                }`}
                onClick={() => setSection(item.key)}
              >
                {active && <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-accent" />}
                {item.label}
              </button>
            );
          })}
        </nav>
        {/* 右侧内容区 */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {section === "general" ? (
            <GeneralSection />
          ) : section === "provider" ? (
            <ProviderSettings />
          ) : section === "permissions" ? (
            <SettingsPermissions />
          ) : section === "mcp" ? (
            <SettingsMcp />
          ) : section === "shortcuts" ? (
            <ShortcutsSection />
          ) : (
            <AboutSection />
          )}
        </div>
      </div>
    </div>
  );
}
