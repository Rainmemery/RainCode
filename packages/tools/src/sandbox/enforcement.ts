/**
 * 沙箱 enforcement 上报辅助（T5.2 / 07-dev-plan §11.2）。
 *
 * 职责分界（模型可见性口径）：
 * - enforcement 字段（Executor 自报）描述「执行域对已放行操作的边界强度」——随 bash 结果
 *   data 持续携带（data.sandbox 同层），非 local 域内容头行同步标注；
 * - 拒绝标记（本模块）描述「约束面拒绝」——path-guard 是应用层预检（02 §5.1 约束非隔离），
 *   由此产生的 TOOL_PATH_ESCAPED 一律 partial，与执行域是否 docker 无关（拒绝发生在投递前）。
 * 格式对齐 dsh：`[sandbox: ... denied under ${mode} mode]`，附同轮重试提示（07 §11.2 可选项）。
 */
import type { SandboxEnforcement } from "@raincode/shared";

/** 模型可见拒绝标记（约束面 TOOL_PATH_ESCAPED 统一 partial：应用层约束，非 OS 边界）。 */
export function sandboxDenialMarker(mode: SandboxEnforcement = "partial"): string {
  return `[sandbox: path access denied under ${mode} mode]`;
}

/** 同轮重试提示（07 §11.2「同轮重试提示可选」；与拒绝标记成对拼接在错误 message 尾部）。 */
export const SANDBOX_RETRY_HINT = "retry with a workspace-relative path if intended";
