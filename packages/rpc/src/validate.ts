import type { ZodError } from "zod";

/** rpc 包内部共享的校验辅助（非 publicEntrypoint 语义，仅包内使用）。 */

export interface SchemaIssue {
  path: string;
  message: string;
}

/** zod issues → 06-api-spec §4.1 的 details.issues 形态。 */
export function formatZodIssues(error: ZodError): SchemaIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
}

/**
 * 开发模式断言开关（04 §4.3：NODE_ENV=development 开启，生产关闭以省渲染开销）。
 * 浏览器安全（B1 可视化测试缺陷修复）：renderer 无 process 全局且 Vite dev 不做静态替换，
 * 须经 typeof 守卫访问——undefined 视为开发模式（dev 断言开启，宁多勿漏）。
 */
export function isDevMode(explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  const nodeEnv = typeof process === "undefined" ? undefined : process.env?.["NODE_ENV"];
  return nodeEnv !== "production";
}
