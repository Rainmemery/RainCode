/**
 * 扩展面板 · Hooks 分区（ui-panel-deepening 轮，置于 MCP 与插件区之后）：
 * hooks.list 源投影（user=全局 / project=项目徽章、path、loaded 状态灯、事件芯片、
 * 「N 事件 · M hooks」）+ project 源授信操作（hooks.trust.grant / hooks.trust.revoke，
 * 绑定活跃会话；activeId 为 null 时按钮禁用）。挂载与 extTick 变化重拉（同面板收敛口径）。
 */
import { memo, useCallback, useEffect, useState } from "react";
import { RpcCallError } from "@raincode/rpc/web";
import type { HookSourceInfo } from "@raincode/shared";
import { rpcCall, useWeb } from "../state.js";

function reasonText(err: unknown): string {
  return err instanceof RpcCallError ? `${err.code}: ${err.message}` : String(err);
}

const ROW_BUTTON_CLASS =
  "h-6 rounded-md border border-border-strong px-2 text-2xs text-mid transition-colors duration-fast hover:bg-hover disabled:opacity-50";

/** 授信徽章（project 专属；violet 遵循扩展面板模块色纪律）。 */
const TRUST_BADGE_TRUSTED = "border-ok text-ok";
const TRUST_BADGE_UNTRUSTED = "border-warn text-warn";

/** Hook 源行（memo：extTick 重拉时未变更行不重渲染，与既有组件一致）。 */
const HookSourceRow = memo(function HookSourceRow({
  item,
  trustDisabled,
  busy,
  onTrust,
}: {
  item: HookSourceInfo;
  trustDisabled: boolean;
  busy: boolean;
  onTrust: (grant: boolean) => void;
}) {
  return (
    <div className="rounded-lg border border-border-base bg-card px-3 py-2">
      <div className="flex items-center gap-2">
        <span className={item.loaded ? "dot dot-ok" : "dot dot-err"} title={item.loaded ? "已加载" : "加载失败"} />
        <span
          className={`shrink-0 rounded-sm border px-1 text-2xs ${item.source === "user" ? "border-cyan text-cyan" : "border-violet text-violet"}`}
          title={item.source === "user" ? "用户全局配置（RAINCODE_HOME/hooks.json）" : "项目配置（.raincode/hooks.json）"}
        >
          {item.source === "user" ? "全局" : "项目"}
        </span>
        <span className="mono min-w-0 flex-1 truncate text-2xs text-hi" title={item.path}>
          {item.path}
        </span>
        <span className="shrink-0 text-2xs text-faint">
          {item.events.length} 事件 · {item.hookCount} hooks
        </span>
        {item.source === "project" &&
          (item.trusted === true ? (
            <>
              <span className={`shrink-0 rounded-sm border px-1 text-2xs ${TRUST_BADGE_TRUSTED}`}>已授信</span>
              <button
                type="button"
                className={`${ROW_BUTTON_CLASS} shrink-0`}
                disabled={trustDisabled || busy}
                onClick={() => onTrust(false)}
                title={trustDisabled ? "需先选中会话" : "撤销授信（hooks.trust.revoke，配置 digest 立即失效）"}
              >
                撤销
              </button>
            </>
          ) : (
            <>
              <span className={`shrink-0 rounded-sm border px-1 text-2xs ${TRUST_BADGE_UNTRUSTED}`}>未授信</span>
              <button
                type="button"
                className={`${ROW_BUTTON_CLASS} shrink-0`}
                disabled={trustDisabled || busy}
                onClick={() => onTrust(true)}
                title={trustDisabled ? "需先选中会话" : "授信当前工作区 hooks（hooks.trust.grant，绑定配置 digest）"}
              >
                授信
              </button>
            </>
          ))}
      </div>
      {item.events.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {item.events.map((event) => (
            <span key={event} className="mono rounded-sm border border-border-base bg-raised px-1 text-[10px] text-low">
              {event}
            </span>
          ))}
        </div>
      )}
      {!item.loaded && item.error !== undefined && (
        <div className="mt-1 truncate text-2xs text-danger" title={item.error}>
          {item.error}
        </div>
      )}
    </div>
  );
});

export function HooksSection(): JSX.Element {
  const extTick = useWeb((s) => s.extTick);
  const activeId = useWeb((s) => s.activeId);
  const [items, setItems] = useState<HookSourceInfo[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      // 按活跃会话拉取（服务端解析其 workspace project 源与授信状态）；无会话时全局口径
      const result = await rpcCall<{ items: HookSourceInfo[] }>(
        "hooks.list",
        activeId !== null ? { sessionId: activeId } : {},
      );
      setUnavailable(false);
      setItems(result.items);
    } catch (err) {
      if (err instanceof RpcCallError && err.code === "METHOD_NOT_FOUND") setUnavailable(true);
      else setError(reasonText(err));
    }
  }, [activeId]);

  // 挂载与全局状态事件（extTick）时重拉：同面板最终收敛口径
  useEffect(() => {
    void refresh();
  }, [refresh, extTick]);

  async function trust(grant: boolean): Promise<void> {
    if (activeId === null) return;
    setBusy(true);
    try {
      await rpcCall(grant ? "hooks.trust.grant" : "hooks.trust.revoke", { sessionId: activeId });
      await refresh();
    } catch (err) {
      setError(reasonText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <div className="flex items-center gap-2 pb-2">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-mint" />
        <span className="text-2xs font-medium text-hi">Hooks</span>
        <span className="text-2xs text-faint">
          {items.length === 0 ? "无" : `${items.length} 个配置源`}
        </span>
      </div>
      {error !== null && <div className="pb-2 text-2xs text-danger">{error}</div>}
      {unavailable ? (
        <div className="rounded-md border border-border-faint bg-card px-3 py-2 text-2xs text-faint">
          Hooks 域未装配（当前宿主未启用）
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-md border border-border-faint bg-card px-3 py-2 text-2xs text-faint">
          未配置 hooks ——在 {'<dataRoot>'}/hooks.json 或 {'<workspace>'}/.raincode/hooks.json 添加
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {items.map((item) => (
            <HookSourceRow
              key={`${item.source}:${item.path}`}
              item={item}
              trustDisabled={activeId === null}
              busy={busy}
              onTrust={(grant) => void trust(grant)}
            />
          ))}
        </div>
      )}
    </section>
  );
}
