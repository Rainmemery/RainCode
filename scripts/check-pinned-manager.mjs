/**
 * pinned 包管理器校验（T5.7；07 §11.2 / 04 §6.3，MiMo build.ts:22-29 pinned 教训——
 * 杂散包管理器二进制可致运行时挂死而 smoke 仍绿，构建期把问题拦在 install 前）。
 *
 * 校验三面（任一失败退出码 1）：
 * 1. 根 package.json `packageManager` 必须为精确 pinned 形态 `pnpm@<exact semver>`（可选 +sha512 哈希
 *    后缀——corepack 会改写追加；范围/^/~/>= 形态一律拒绝——「可升级」即不 pinned）；
 * 2. pnpm-lock.yaml 在位（lockfile 是 pinned 版本的解析结果事实源）；
 * 3. `pnpm --version` 实测输出与 pinned 版本一致（PATH 上杂散 pnpm 二进制检测）。
 *
 * 用法：node scripts/check-pinned-manager.mjs（CI gates job install 前置步骤；本地 `pnpm check:manager`）。
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 解析并校验 packageManager 字段形态；非法即抛错（纯函数面，供单测）。 */
export function parsePinnedManager(field) {
  if (typeof field !== "string" || field.length === 0) {
    throw new Error("package.json 缺少 packageManager 字段——pinned 包管理器校验失败（04 §6.3）");
  }
  // 精确 pinned：pnpm@<exact semver>（可选 +sha512… 哈希后缀，corepack 改写形态）；范围形态一律拒绝
  const m = /^pnpm@(\d+\.\d+\.\d+)(\+sha512\.[0-9a-f]+)?$/.exec(field);
  if (m === null) {
    throw new Error(
      `packageManager 必须为精确 pinned 形态 "pnpm@<exact semver>"（如 pnpm@11.24.0，可选 +sha512 哈希后缀），实为 "${field}"——范围/^/~ 形态即不 pinned（MiMo pinned 教训，04 §6.3）`,
    );
  }
  return { name: "pnpm", version: m[1] };
}

function fail(message) {
  console.error(`check-pinned-manager FAILED: ${message}`);
  process.exit(1);
}

const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
let pinned;
try {
  pinned = parsePinnedManager(packageJson.packageManager);
} catch (reason) {
  fail(reason instanceof Error ? reason.message : String(reason));
}

if (!existsSync(join(repoRoot, "pnpm-lock.yaml"))) {
  fail("pnpm-lock.yaml 不在位——lockfile 是 pinned 版本的解析结果事实源");
}

let actual;
try {
  actual = execSync("pnpm --version", { encoding: "utf8", cwd: repoRoot, stdio: ["ignore", "pipe", "ignore"] }).trim();
} catch {
  fail("pnpm --version 执行失败（PATH 上无 pnpm？）");
}
if (actual !== pinned.version) {
  fail(`实测 pnpm --version=${actual} 与 pinned ${pinned.version} 不一致——PATH 上存在杂散 pnpm 二进制（MiMo pinned 教训：运行时挂死而 smoke 仍绿）`);
}

console.log(`check-pinned-manager OK: packageManager=${packageJson.packageManager} · lockfile 在位 · 实测 pnpm ${actual}`);
