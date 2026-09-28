/**
 * app 版本发现（06 §2.8 system.version.appVersion 数据源）。
 * 读 server 包 package.json version（诊断字段；读取失败回退 0.0.0，不影响协议）。
 */
import { readFileSync } from "node:fs";

let cached: string | null = null;

export function appVersion(): string {
  if (cached !== null) {
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
