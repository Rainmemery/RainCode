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

/** 开发模式断言开关（04 §4.3：NODE_ENV=development 开启，生产关闭以省渲染开销）。 */
export function isDevMode(explicit?: boolean): boolean {
  return explicit ?? process.env["NODE_ENV"] !== "production";
}
