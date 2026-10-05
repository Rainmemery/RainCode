/**
 * 设置页 · 「命令权限」Tab（06 §2.2 permission.rules.list / add / remove；UI 管理面板深化轮）：
 * 危险示例提示行（warn）+ 规则表（behavior 徽章 + 等宽 tool:pattern + 作用域/来源 + 删除）
 * +「新建规则」折叠表单（scope 仅 project|global——session 驻内存不入库，由审批「始终允许」产生）。
 * 组内局部错误红字行（勿污染全局 chat 横幅）。
 * polish-ui-states-and-runtime A5（§8.1）：规则表 ↑↓ 移动高亮；Enter/Delete 触发该行删除动作
 * （删除改两段确认，确认后经 permission.rules.remove 删除）；高亮行滚动入视。
 * polish-ui-states-and-runtime Task 4.4：组内嵌「决策审计」子区（SettingsAudit.tsx，只读）。
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import type { PermissionRule } from "@raincode/shared";
import { nextIndexFromKey } from "../list-nav.js";
import { rpcCall } from "../store.js";
import { SETTINGS_INPUT_CLASS, SettingsCard, SettingsField, rpcErrorText } from "./SettingsCard.js";
import SettingsAudit from "./SettingsAudit.js";

const BEHAVIOR_BADGE: Record<PermissionRule["behavior"], string> = {
  allow: "border-ok text-ok",
  ask: "border-warn text-warn",
  deny: "border-danger text-danger",
};

const BEHAVIOR_LABEL: Record<PermissionRule["behavior"], string> = {
  allow: "允许",
  ask: "询问",
  deny: "拒绝",
};

const SCOPE_LABEL: Record<PermissionRule["scope"], string> = {
  session: "会话",
  project: "项目",
  global: "全局",
};

/** 来源中文口径（UI 管理面板深化轮）：user=手动 / allow-always=会话决策 / import=导入。 */
const SOURCE_LABEL: Record<PermissionRule["source"], string> = {
  user: "手动",
  "allow-always": "会话决策",
  import: "导入",
};

const EMPTY_FORM = { tool: "", pattern: "", matchType: "", behavior: "ask", scope: "project" };

/** 规则行（memo）：behavior 徽章 + 等宽 `tool:pattern`（缺省 *）+ 作用域 + 来源 + 删除（两段确认）。 */
const RuleRow = memo(function RuleRow({
  rule,
  highlighted,
  onRemove,
}: {
  rule: PermissionRule;
  highlighted: boolean;
  onRemove: (id: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div
      data-nav-row
      className={`flex h-8 items-center gap-2 border-b border-border-faint px-1 last:border-b-0 ${
        highlighted ? "bg-selected" : ""
      }`}
    >
      <span className={`shrink-0 rounded border px-1 text-2xs ${BEHAVIOR_BADGE[rule.behavior]}`}>
        {BEHAVIOR_LABEL[rule.behavior]}
      </span>
      <span className="mono min-w-0 flex-1 truncate text-2xs text-hi" title={`${rule.tool}:${rule.pattern ?? "*"}`}>
        {rule.tool}:{rule.pattern ?? "*"}
      </span>
      <span className="w-10 shrink-0 text-right text-2xs text-faint">{SCOPE_LABEL[rule.scope]}</span>
      <span className="w-16 shrink-0 text-right text-2xs text-faint">{SOURCE_LABEL[rule.source]}</span>
      {confirming ? (
        <>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="h-6 shrink-0 rounded border border-border-strong px-2 text-2xs text-mid transition-colors duration-fast hover:bg-hover"
          >
            取消
          </button>
          <button
            type="button"
            data-nav-primary
            onClick={() => {
              setConfirming(false);
              onRemove(rule.id);
            }}
            className="h-6 shrink-0 rounded border border-danger px-2 text-2xs text-danger transition-colors duration-fast hover:bg-hover"
            title="经 permission.rules.remove 删除该规则"
          >
            确认删除？
          </button>
        </>
      ) : (
        <button
          type="button"
          data-nav-primary
          onClick={() => setConfirming(true)}
          className="h-6 shrink-0 rounded border border-border-strong px-2 text-2xs text-mid transition-colors duration-fast hover:border-danger hover:text-danger"
          title="删除该规则"
        >
          删除
        </button>
      )}
    </div>
  );
});

export default function SettingsPermissions() {
  const [rules, setRules] = useState<PermissionRule[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  // 规则表键盘导航（A5）：高亮索引
  const [navIndex, setNavIndex] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const result = await rpcCall<{ rules: PermissionRule[] }>("permission.rules.list", {});
      setRules(result.rules);
      setError(null);
    } catch (err) {
      setError(rpcErrorText(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleRemove(id: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await rpcCall("permission.rules.remove", { id });
      await refresh();
    } catch (err) {
      setError(rpcErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    const tool = form.tool.trim();
    if (tool === "") {
      setError("tool 为必填项");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await rpcCall("permission.rules.add", {
        scope: form.scope,
        tool,
        ...(form.pattern.trim() !== "" && { pattern: form.pattern.trim() }),
        ...(form.matchType !== "" && { matchType: form.matchType }),
        behavior: form.behavior,
      });
      setForm(EMPTY_FORM);
      setFormOpen(false);
      await refresh();
    } catch (err) {
      setError(rpcErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  /** 键盘导航：高亮行滚动入视（block:nearest，最小滚动）。 */
  function scrollRowIntoView(index: number): void {
    listRef.current?.querySelectorAll<HTMLElement>("[data-nav-row]")[index]?.scrollIntoView({ block: "nearest" });
  }

  /** 规则表键盘：↑↓/Home/End 移动高亮；Enter / Delete 触发该行删除动作（两段确认）。 */
  function handleListKey(event: KeyboardEvent<HTMLElement>): void {
    const target = event.target;
    // 表单控件（新建规则输入 / 下拉）聚焦时不劫持按键
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;
    const next = nextIndexFromKey(event.key, navIndex ?? -1, rules.length);
    if (next !== null) {
      event.preventDefault();
      setNavIndex(next);
      scrollRowIntoView(next);
      return;
    }
    if ((event.key === "Enter" || event.key === "Delete") && navIndex !== null) {
      const row = listRef.current?.querySelectorAll<HTMLElement>("[data-nav-row]")[navIndex];
      if (row === undefined || row === null) return;
      event.preventDefault();
      row.querySelector<HTMLButtonElement>("[data-nav-primary]")?.click();
    }
  }

  return (
    <>
      <SettingsCard title="命令权限规则">
        {/* 危险示例提示（UI 管理面板深化轮）：deny 置顶防护口径 */}
        <div className="mb-3 flex items-start gap-2 rounded-md border border-warn bg-[color-mix(in_srgb,var(--warn)_8%,transparent)] px-2.5 py-1.5 text-2xs text-warn">
          <span className="dot dot-warn mt-1" />
          <span>高危命令（如 rm -rf）建议显式 deny 规则置顶防护</span>
        </div>
        {error !== null && <div className="mb-2 text-2xs text-danger">{error}</div>}
        <div
          ref={listRef}
          tabIndex={0}
          onKeyDown={handleListKey}
          aria-label="命令权限规则"
          className="flex flex-col"
        >
          {rules.length === 0 && (
            <div className="py-2 text-2xs text-faint">暂无规则（会话内「始终允许」决策与导入规则在此呈现）</div>
          )}
          {rules.map((rule, index) => (
            <RuleRow
              key={rule.id}
              rule={rule}
              highlighted={navIndex === index}
              onRemove={(id) => void handleRemove(id)}
            />
          ))}
        </div>
        <div className="mt-3">
          {formOpen ? (
            <form onSubmit={(event) => void handleSubmit(event)} className="rounded-md border border-border-faint bg-raised p-3">
              <div className="grid grid-cols-2 gap-3">
                <SettingsField label="tool（必填）">
                  <input
                    value={form.tool}
                    onChange={(event) => setForm({ ...form, tool: event.target.value })}
                    className={SETTINGS_INPUT_CLASS}
                    placeholder="例如 bash"
                  />
                </SettingsField>
                <SettingsField label="pattern（可选，缺省匹配全部）">
                  <input
                    value={form.pattern}
                    onChange={(event) => setForm({ ...form, pattern: event.target.value })}
                    className={SETTINGS_INPUT_CLASS}
                    placeholder="例如 rm -rf *"
                  />
                </SettingsField>
                <SettingsField label="matchType（可选）">
                  <select
                    value={form.matchType}
                    onChange={(event) => setForm({ ...form, matchType: event.target.value })}
                    className={SETTINGS_INPUT_CLASS}
                  >
                    <option value="">（缺省 wildcard）</option>
                    <option value="wildcard">wildcard</option>
                    <option value="exact">exact</option>
                    <option value="regex">regex</option>
                  </select>
                </SettingsField>
                <SettingsField label="behavior">
                  <select
                    value={form.behavior}
                    onChange={(event) => setForm({ ...form, behavior: event.target.value })}
                    className={SETTINGS_INPUT_CLASS}
                  >
                    <option value="allow">allow（允许）</option>
                    <option value="ask">ask（询问）</option>
                    <option value="deny">deny（拒绝）</option>
                  </select>
                </SettingsField>
                <SettingsField label="scope">
                  <select
                    value={form.scope}
                    onChange={(event) => setForm({ ...form, scope: event.target.value })}
                    className={SETTINGS_INPUT_CLASS}
                  >
                    <option value="project">project（项目）</option>
                    <option value="global">global（全局）</option>
                  </select>
                </SettingsField>
              </div>
              <div className="mt-2 text-2xs text-faint">
                scope 仅 project / global：session 规则驻内存不入库（由审批「始终允许」产生）
              </div>
              <div className="mt-3 flex items-center gap-2">
                <button
                  type="submit"
                  disabled={busy}
                  className="h-8 rounded-md bg-accent px-4 text-2xs text-on-accent transition-colors duration-fast hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
                >
                  创建规则
                </button>
                <button
                  type="button"
                  onClick={() => setFormOpen(false)}
                  className="h-8 rounded-md border border-border-strong px-3 text-2xs text-mid transition-colors duration-fast hover:bg-hover"
                >
                  取消
                </button>
              </div>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setFormOpen(true)}
              className="h-7 rounded-md border border-border-strong px-3 text-2xs text-mid transition-colors duration-fast hover:bg-hover"
            >
              新建规则
            </button>
          )}
        </div>
      </SettingsCard>
      <SettingsAudit />
    </>
  );
}
