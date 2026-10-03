/**
 * dist 前置：为打包形态暂存 electron-ABI 的 better-sqlite3 原生模块（T4.7 L-04）。
 *
 * 背景：dev 树的 better-sqlite3 由 pnpm approve-builds 针对系统 node 编译（CI 桌面测试与
 * dev 桌面 agent 都走 node 路径），而打包 agent 以 ELECTRON_RUN_AS_NODE 运行 bundle，
 * NODE_MODULE_VERSION 不同——直接 require 会失配崩溃。为不污染 dev 树（electron-builder 的
 * npmRebuild 对 pnpm 虚拟 store 原地重编译会同时破坏 dev/CI），本脚本把 electron-ABI 副本
 * 暂存到 build/native/node_modules/（gitignore），经 electron-builder extraResources 随包
 * 分发到 <install>/resources/native/node_modules/，由 main 进程以 NODE_PATH 注入 agent 子进程
 * 解析（正常路径找不到时才回退，不会遮蔽任何既有模块）。
 *
 * 步骤：① 按 package.json 依赖链穿透 pnpm 符号链接定位真实包目录并拷贝运行时闭包
 * （better-sqlite3 → bindings → file-uri-to-path）；② 实测本机 electron 的
 * process.versions.modules 得 ABI 号；③ 经 gh-proxy 下载对应 electron prebuild tarball
 * 解包覆盖 build/Release；④ 以 ELECTRON_RUN_AS_NODE + NODE_PATH 自检副本可加载可执行 SQL
 * （失败即 dist 失败，不留坏包）。
 *
 * 网络：默认走 gh-proxy.org 前缀镜像（本机网络对 github 直连受限），可用 RAINCODE_GH_PROXY 覆盖。
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(desktopRoot, "package.json"));
const GH_PROXY = process.env["RAINCODE_GH_PROXY"] ?? "https://gh-proxy.org/";
const NATIVE_DIR = join(desktopRoot, "build", "native");
const STAGE_DIR = join(NATIVE_DIR, "node_modules");

function fail(message) {
  console.error(`[prepare-native] ${message}`);
  process.exit(1);
}

function main() {
  // --- 版本探测：better-sqlite3 真实目录（从 apps/desktop 依赖视角穿透 pnpm 符号链接）---
  const bs3RealDir = dirname(require.resolve("better-sqlite3/package.json"));
  const bs3Version = JSON.parse(readFileSync(join(bs3RealDir, "package.json"), "utf8")).version;
  console.log(`[prepare-native] better-sqlite3 ${bs3Version} @ ${bs3RealDir}`);

  const electronVersion = JSON.parse(
    readFileSync(join(desktopRoot, "node_modules", "electron", "package.json"), "utf8"),
  ).version;
  const electronExe = join(desktopRoot, "node_modules", "electron", "dist", "electron.exe");
  if (!existsSync(electronExe)) fail("electron 二进制缺失（先 pnpm install 下载 dist）");
  const abi = spawnSync(electronExe, ["-p", "process.versions.modules"], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    encoding: "utf8",
  });
  if (abi.status !== 0) fail(`electron process.versions.modules 实测失败: ${abi.stderr}`);
  const electronAbi = abi.stdout.trim();
  console.log(`[prepare-native] electron ${electronVersion}（NODE_MODULE_VERSION ${electronAbi}）`);

  // --- ① 暂存运行时闭包：better-sqlite3 → bindings → file-uri-to-path（各自真实目录）---
  const resolveFromBs3 = createRequire(join(bs3RealDir, "package.json"));
  const closures = [
    ["better-sqlite3", bs3RealDir],
    ["bindings", dirname(resolveFromBs3.resolve("bindings/package.json"))],
    ["file-uri-to-path", dirname(resolveFromBs3.resolve("file-uri-to-path/package.json"))],
  ];
  rmSync(STAGE_DIR, { recursive: true, force: true });
  mkdirSync(STAGE_DIR, { recursive: true });
  for (const [name, resolvedDir] of closures) {
    const realDir = realpathSync(resolvedDir); // virtual store 兄弟项是符号链接，取目标实体
    cpSync(realDir, join(STAGE_DIR, name), { recursive: true, dereference: true });
    console.log(`[prepare-native] 暂存 ${name} ← ${realDir}`);
  }

  // --- ② 下载 electron prebuild（gh-proxy 前缀镜像；资产名 = better-sqlite3-v<ver>-electron-v<abi>-win32-x64.tar.gz）---
  const asset = `better-sqlite3-v${bs3Version}-electron-v${electronAbi}-win32-x64.tar.gz`;
  const url = `${GH_PROXY}https://github.com/WiseLibs/better-sqlite3/releases/download/v${bs3Version}/${asset}`;
  const tarball = join(NATIVE_DIR, asset);
  console.log(`[prepare-native] 下载 ${url}`);
  const download = spawnSync("curl", ["-fsSL", "--retry", "3", "--max-time", "300", "-o", tarball, url], {
    stdio: "inherit",
  });
  if (download.status !== 0 || !existsSync(tarball)) {
    fail(`electron prebuild 下载失败（可设 RAINCODE_GH_PROXY 换镜像）：${asset}`);
  }

  // --- ③ 解包覆盖暂存副本的 build/Release（优先 System32 bsdtar；Git Bash 的 GNU tar 会把 D: 当远程主机）---
  const target = join(STAGE_DIR, "better-sqlite3");
  const systemTar = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "tar.exe");
  const extract = existsSync(systemTar)
    ? spawnSync(systemTar, ["-xzf", tarball, "-C", target], { stdio: "inherit" })
    : spawnSync("tar", ["-xzf", tarball, "-C", target, "--force-local"], { stdio: "inherit" });
  if (extract.status !== 0) fail("tar 解包失败");
  const nativeBinary = join(STAGE_DIR, "better-sqlite3", "build", "Release", "better_sqlite3.node");
  if (!existsSync(nativeBinary)) fail(`tarball 内未得到 ${nativeBinary}（资产布局不符）`);

  // --- ④ 自检：ELECTRON_RUN_AS_NODE + NODE_PATH 下副本可加载并可执行 SQL（与 main 注入机制同构）。
  // cwd 必须是仓库外的中性目录：require 会沿 cwd 父链找 node_modules——若 cwd 在仓库内会先命中
  // dev 树 node-ABI 副本直接 ABI 失配，NODE_PATH 回退根本未被验证（假绿/假红都由它产生）。
  const probeCwd = mkdtempSync(join(tmpdir(), "raincode-native-probe-"));
  const probe = spawnSync(
    electronExe,
    [
      "-e",
      `const db = require("better-sqlite3")(":memory:"); db.exec("create table t(x)");` +
        `db.prepare("insert into t values (?)").run(1);` +
        `if (db.prepare("select count(*) c from t").get().c !== 1) throw new Error("sql mismatch");` +
        `console.log("ELECTRON_ABI_STAGE_OK");`,
    ],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_PATH: STAGE_DIR },
      encoding: "utf8",
      cwd: probeCwd,
    },
  );
  rmSync(probeCwd, { recursive: true, force: true });
  if (probe.status !== 0 || !probe.stdout.includes("ELECTRON_ABI_STAGE_OK")) {
    fail(`暂存副本自检失败：${probe.stderr ?? probe.stdout}`);
  }
  console.log(`[prepare-native] electron-ABI 副本就绪 → ${STAGE_DIR}`);
}

main();
