/**
 * app 版本发现（06 §2.8 system.version.appVersion 数据源）。
 * 读 server 包 package.json version（诊断字段；读取失败回退 0.0.0，不影响协议）。
 * 打包形态（T2.9 esbuild bundle）经 RAINCODE_APP_VERSION 注入——bundle 内 import.meta.url
 * shim 不可用（esbuild CJS 输出为空对象），版本随构建内联。
 */
import { readFileSync } from "node:fs";

let cached: string | null = null;

export function appVersion(): string {
  if (cached !== null) {
    return cached;
  }
  const injected = process.env["RAINCODE_APP_VERSION"];
  if (injected !== undefined && injected.length > 0) {
    cached = injected;
    return cached;
  }
  try {
    const raw = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
    cached = (JSON.parse(raw) as { version?: string }).version ?? "0.0.0";
  } catch {
    cached = "0.0.0";
  }
  return cached;
}
