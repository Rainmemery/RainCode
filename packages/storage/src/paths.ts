/**
 * 数据根与目录编址（05-database §2）。
 * - 数据根：RAINCODE_HOME 环境变量覆盖（测试隔离），缺省 ~/.raincode（§2.1）；
 * - workspaceHash：realpath → 规范化 → sha256 前 16 hex（§2.3），即 02 所称 workspaceId；
 * - 会话目录：workspaces/<hash>/sessions/<id>/events.jsonl（§2.1/§4.1）。
 */
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** 数据根：RAINCODE_HOME 优先，缺省 ~/.raincode（05 §2.1）。 */
export function resolveDataRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["RAINCODE_HOME"];
  if (typeof override === "string" && override.trim() !== "") {
    return resolve(override);
  }
  return join(homedir(), ".raincode");
}

/** 会话目录编址（05 §2.1）；attachments/ 与 background/ 由后续波次按需创建。 */
export interface SessionPaths {
  dir: string;
  eventsFile: string;
  attachmentsDir: string;
  backgroundDir: string;
}

export function sessionPaths(dataRoot: string, workspaceHash: string, sessionId: string): SessionPaths {
  const dir = join(dataRoot, "workspaces", workspaceHash, "sessions", sessionId);
  return {
    dir,
    eventsFile: join(dir, "events.jsonl"),
    attachmentsDir: join(dir, "attachments"),
    backgroundDir: join(dir, "background"),
  };
}

/**
 * 规范化绝对路径（05 §2.3 第 1~3 步）：
 * realpath 解析符号链接（Windows 下 realpath.native 走 GetFinalPathNameByHandle，
 * 顺带展开 8.3 短路径名并还原真实大小写；失败回退 realpath，再回退原值）；
 * 分隔符统一为 /；Windows 整体转小写（NTFS 大小写不敏感）；去尾部分隔符。
 */
export function canonicalWorkspacePath(workspaceRoot: string): string {
  let p = resolve(workspaceRoot);
  try {
    p = realpathSync.native(p);
  } catch {
    try {
      p = realpathSync(p);
    } catch {
      // 路径尚不存在等场景：按 05 §2.3 回退原值
    }
  }
  p = p.replace(/^\\\\\?\\/, "").replaceAll("\\", "/");
  if (process.platform === "win32") {
    p = p.toLowerCase();
  }
  return p.replace(/\/+$/, "");
}

/** workspaceHash = sha256(规范化路径) 前 16 个十六进制字符（05 §2.3）。 */
export function computeWorkspaceHash(workspaceRoot: string): string {
  return createHash("sha256").update(canonicalWorkspacePath(workspaceRoot)).digest("hex").slice(0, 16);
}
