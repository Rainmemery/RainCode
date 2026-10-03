/**
 * dist 封装：electron-builder 打包前的 Windows 打包机问题兜底（T4.7 L-04）。
 *
 * ① 网络镜像：electron zip 与 winCodeSign/nsis 工具链（electron-builder-binaries）需联网下载，
 *    本机网络对 github 直连受限——缺省注入 gh-proxy.org 前缀镜像（已显式设置的环境变量不覆盖）。
 * ② winCodeSign 缓存预填充：其 7z 内含两个 darwin 符号链接（libcrypto/libssl.dylib），普通权限
 *    解包即失败（「客户端没有所需的特权」），且这两项对 Windows 未签名构建毫无用处——先解包到
 *    缓存目录并容忍该两项失败、校验 Windows 侧关键文件在位，electron-builder 即命中缓存跳过下载。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(desktopRoot, "package.json"));
const GH_PROXY = process.env["RAINCODE_GH_PROXY"] ?? "https://gh-proxy.org/";

function electronBuilderCacheDir() {
  return process.env["ELECTRON_BUILDER_CACHE"] ?? join(process.env["LOCALAPPDATA"] ?? join(tmpdir(), "lb"), "electron-builder", "Cache");
}

/** winCodeSign 版本由 app-builder（Go 二进制）内置；25.x 系列为 2.6.0。若升级后此处不匹配，
 * electron-builder 会报缓存 miss 并重走下载（复现符号链接失败）——届时对本常量同步更新。 */
const WIN_CODE_SIGN_VERSION = "2.6.0";

/** 7zip-bin 是 electron-builder 的传递依赖（pnpm 隔离布局下 apps/desktop 不可直接解析）：
 * 优先从 electron-builder 的 require 上下文解析，失败再扫 .pnpm 虚拟 store。 */
function find7za() {
  try {
    const ebRequire = createRequire(require.resolve("electron-builder/package.json"));
    return join(dirname(ebRequire.resolve("7zip-bin/package.json")), "win", "x64", "7za.exe");
  } catch {
    const pnpmDir = join(desktopRoot, "..", "..", "node_modules", ".pnpm");
    if (existsSync(pnpmDir)) {
      for (const entry of readdirSync(pnpmDir)) {
        if (entry.startsWith("7zip-bin@")) {
          return join(pnpmDir, entry, "node_modules", "7zip-bin", "win", "x64", "7za.exe");
        }
      }
    }
    return join(pnpmDir, "7zip-bin", "win", "x64", "7za.exe");
  }
}

/** 预填充 winCodeSign 缓存：解包容忍 darwin 符号链接失败，但 Windows 侧文件必须齐。 */
function ensureWinCodeSignCache() {
  const dir = join(electronBuilderCacheDir(), "winCodeSign", `winCodeSign-${WIN_CODE_SIGN_VERSION}`);
  if (existsSync(dir)) {
    console.log(`[dist] winCodeSign 缓存已就绪: ${dir}`);
    return;
  }
  const sevenZip = find7za();
  if (!existsSync(sevenZip)) throw new Error(`7za 不存在: ${sevenZip}`);
  const cacheDir = dirname(dir);
  mkdirSync(cacheDir, { recursive: true });
  const staging = mkdtempSync(join(cacheDir, "prepare-"));
  try {
    const tarball = join(staging, "winCodeSign.7z");
    const url = `${GH_PROXY}https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-${WIN_CODE_SIGN_VERSION}/winCodeSign-${WIN_CODE_SIGN_VERSION}.7z`;
    console.log(`[dist] 下载 ${url}`);
    const download = spawnSync("curl", ["-fsSL", "--retry", "3", "--max-time", "300", "-o", tarball, url], { stdio: "inherit" });
    if (download.status !== 0 || !existsSync(tarball)) throw new Error("winCodeSign 下载失败（可设 RAINCODE_GH_PROXY 换镜像）");
    // 退出码 2 = 存在失败子项（此处即两个 darwin 符号链接）；其余码一律视为失败
    const extract = spawnSync(sevenZip, ["x", "-y", "-bd", tarball, `-o${staging}`], { stdio: "ignore" });
    if (extract.status !== 0 && extract.status !== 2) throw new Error(`winCodeSign 解包失败（exit ${String(extract.status)}）`);
    const entries = readdirSync(staging);
    if (!entries.includes("windows-10") || !entries.includes("darwin")) {
      throw new Error(`winCodeSign 解包产物不完整: ${entries.join(", ")}`);
    }
    rmSync(join(staging, "darwin"), { recursive: true, force: true }); // darwin 侧签名工具在 Windows 打包无用途
    renameSync(staging, dir);
    console.log(`[dist] winCodeSign 缓存预填充完成: ${dir}`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function main() {
  ensureWinCodeSignCache();
  const mirrors = {
    ELECTRON_MIRROR: `${GH_PROXY}https://github.com/electron/electron/releases/download/`,
    ELECTRON_BUILDER_BINARIES_MIRROR: `${GH_PROXY}https://github.com/electron-userland/electron-builder-binaries/releases/download/`,
  };
  const env = { ...process.env };
  for (const [key, value] of Object.entries(mirrors)) {
    if (env[key] === undefined) env[key] = value;
  }
  const args = process.argv.slice(2);
  const defaultArgs = ["--win", "--config", "electron-builder.yml"];
  const result = spawnSync(join(desktopRoot, "node_modules", ".bin", "electron-builder.cmd"), args.length > 0 ? args : defaultArgs, {
    stdio: "inherit",
    env,
    shell: true,
  });
  process.exit(result.status ?? 1);
}

main();
