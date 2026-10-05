/**
 * 设置页 · 命令权限分区（ui-panel-deepening 轮）：permission.rules.list 投影（behavior 徽章 /
 * 等宽表达式 / 作用域 / 来源 / 删除）+ 新建规则折叠表单（scope 仅 project/global——session
 * 驻内存不入库，落点为审批 respond always）。分区局部错误行（同 MemoryManager 局部错误模式），
 * 不污染全局 chat 错误横幅。
 */
import { memo, useCallback, useEffect, useState } from "react";
import { RpcCallError } from "@raincode/rpc/web";
import type { PermissionRule, PermissionRulesListResult, RuleMatchType } from "@raincode/shared";
import { rpcCall } from "../state.js";

/** behavior 徽章（allow=ok / ask=warn / deny=danger 色芯片）。 */
const BEHAVIOR_BADGE: Record<PermissionRule["behavior"], string> = {
  allow: "border-ok/40 bg-ok/10 text-ok",
  ask: "border-warn/40 bg-warn/10 text-warn",
  deny: "border-danger/40 bg-danger/10 text-danger",
};

/** 规则来源（user=手动 / allow-always=会话决策 / import=导入）。 */
const SOURCE_LABEL: Record<PermissionRule["source"], string> = {
  user: "手动",
  "allow-always": "会话决策",
  import: "导入",
};

const INPUT_CLASS =
  "h-8 w-full rounded-md border border-border-base bg-raised px-2 text-2xs text-hi outline-none placeholder:text-faint transition-colors duration-fast focus:border-accent-dim";

const ROW_BUTTON_CLASS =
  "h-6 rounded-md border border-border-strong px-2 text-2xs text-mid transition-colors duration-fast hover:bg-hover disabled:opacity-50";

/** 规则行（memo：列表刷新时未变更行不重渲染，与既有组件一致）。 */
const RuleRow = memo(function RuleRow({
  rule,
  busy,
  onRemove,
}: {
  rule: PermissionRule;
  busy: boolean;
  onRemove: (id: string) => void;
}) {
  return (
    <div className="flex h-8 items-center gap-2 border-b border-border-faint px-3 text-2xs last:border-b-0">
      <span className={`shrink-0 rounded-sm border px-1.5 py-0.5 ${BEHAVIOR_BADGE[rule.behavior]}`}>{rule.behavior}</span>
      <span className="mono min-w-0 flex-1 truncate text-hi" title={`${rule.tool}:${rule.pattern ?? "*"}`}>
        {rule.tool}:{rule.pattern ?? "*"}
      </span>
      <span className="shrink-0 rounded-sm border border-border-base bg-raised px-1 text-[10px] text-low" title="规则作用域">
        {rule.scope}
      </span>
      <span className="w-16 shrink-0 truncate text-right text-faint" title={rule.source}>
        {SOURCE_LABEL[rule.source]}
      </span>
      <button
        type="button"
        className={`${ROW_BUTTON_CLASS} shrink-0`}
        disabled={busy}
        onClick={() => onRemove(rule.id)}
        title="删除规则（permission.rules.remove）"
      >
        删除
      </button>
    </div>
  );
});

export function SettingsPermissions(): JSX.Element {
  const [rules, setRules] = useState<PermissionRule[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // 新建规则折叠表单（matchType 空串 = 缺省 wildcard，不随 payload 发送）
  const [formOpen, setFormOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tool, setTool] = useState("");
  const [pattern, setPattern] = useState("");
  const [matchType, setMatchType] = useState<"" | RuleMatchType>("");
  const [behavior, setBehavior] = useState<PermissionRule["behavior"]>("ask");
  const [scope, setScope] = useState<"project" | "global">("project");

  const refresh = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const result = await rpcCall<PermissionRulesListResult>("permission.rules.list", {});
      setUnavailable(false);
      setRules(result.rules);
    } catch (err) {
      if (err instanceof RpcCallError && err.code === "METHOD_NOT_FOUND") setUnavailable(true);
      else setError(err instanceof RpcCallError ? `${err.code}: ${err.message}` : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function removeRule(id: string): Promise<void> {
    setBusyId(id);
    try {
      await rpcCall("permission.rules.remove", { id });
      await refresh();
    } catch (err) {
      setError(err instanceof RpcCallError ? `${err.code}: ${err.message}` : String(err));
    } finally {
      setBusyId(null);
    }
  }

  async function submitRule(): Promise<void> {
    const trimmedTool = tool.trim();
    if (trimmedTool.length === 0) {
      setFormError("tool 必填");
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      await rpcCall("permission.rules.add", {
        scope,
        tool: trimmedTool,
        ...(pattern.trim().length > 0 && { pattern: pattern.trim() }),
        ...(matchType !== "" && { matchType }),
        behavior,
      });
      setTool("");
      setPattern("");
      setMatchType("");
      setBehavior("ask");
      setFormOpen(false);
      await refresh();
    } catch (err) {
      setFormError(err instanceof RpcCallError ? `${err.code}: ${err.message}` : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-4 px-6 py-5">
      <section>
        <h3 className="pb-2 text-xs text-mid">命令权限</h3>
        {/* 危险示例提示行（warn 色） */}
        <div className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-2xs text-warn">
          高危命令（如 rm -rf）建议显式 deny 规则置顶防护
        </div>
        {error !== null && <div className="mt-2 text-2xs text-danger">{error}</div>}
        {unavailable ? (
          <div className="mt-2 rounded-md border border-border-faint bg-card px-3 py-2 text-2xs text-faint">
            权限域未装配（当前宿主未启用）
          </div>
        ) : (
          <>
            <div className="mt-2 rounded-md border border-border-faint bg-card">
              {rules.length === 0 ? (
                <div className="px-3 py-2 text-2xs text-faint">暂无规则（审批「总是允许」与新建规则落库后在此列出）</div>
              ) : (
                rules.map((rule) => (
                  <RuleRow key={rule.id} rule={rule} busy={busyId === rule.id} onRemove={(id) => void removeRule(id)} />
                ))
              )}
            </div>
            <div className="mt-2">
              <button
                type="button"
                className={ROW_BUTTON_CLASS}
                onClick={() => {
                  setFormOpen(!formOpen);
                  setFormError(null);
                }}
                title="新建规则（permission.rules.add）"
              >
                {formOpen ? "收起表单" : "新建规则"}
              </button>
            </div>
            {formOpen && (
              <div className="anim-rise mt-2 rounded-md border border-border-faint bg-card p-3">
                <div className="grid grid-cols-2 gap-2.5">
                  <input className={INPUT_CLASS} placeholder="tool（必填，如 bash）" value={tool} onChange={(e) => setTool(e.target.value)} />
                  <input
                    className={INPUT_CLASS}
                    placeholder="pattern（可选，缺省匹配全部）"
                    value={pattern}
                    onChange={(e) => setPattern(e.target.value)}
                  />
                  <select
                    className={INPUT_CLASS}
                    value={matchType}
                    onChange={(e) => setMatchType(e.target.value as "" | RuleMatchType)}
                    title="匹配语义（缺省 wildcard）"
                  >
                    <option value="">matchType（缺省 wildcard）</option>
                    <option value="wildcard">wildcard</option>
                    <option value="exact">exact</option>
                    <option value="regex">regex</option>
                  </select>
                  <select
                    className={INPUT_CLASS}
                    value={behavior}
                    onChange={(e) => setBehavior(e.target.value as PermissionRule["behavior"])}
                    title="规则行为"
                  >
                    <option value="allow">allow</option>
                    <option value="ask">ask</option>
                    <option value="deny">deny</option>
                  </select>
                  <select
                    className={INPUT_CLASS}
                    value={scope}
                    onChange={(e) => setScope(e.target.value as "project" | "global")}
                    title="scope：session 驻内存不入库，此处仅 project / global"
                  >
                    <option value="project">project</option>
                    <option value="global">global</option>
                  </select>
                  <button
                    type="button"
                    className="h-8 rounded-md bg-accent px-3 text-2xs text-on-accent transition-colors duration-fast hover:bg-accent-hover disabled:opacity-40"
                    disabled={busy}
                    onClick={() => void submitRule()}
                  >
                    添加规则
                  </button>
                </div>
                <p className="mt-2 text-2xs text-faint">
                  scope 仅 project / global：session 规则驻内存不入库（落点为审批「总是允许」选择会话作用域）。
                </p>
                {formError !== null && <p className="mt-1 text-2xs text-danger">{formError}</p>}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
