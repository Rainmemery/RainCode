/**
 * CLI esbuild 前置编译（T5.7 / L-16 核销；参照 ZCode packages/cli/scripts/build.mjs 三件套，
 * docs/research/2026-10-04-m5-reference-repos.md §2.3）。
 *
 * 产物：dist/raincode.mjs 单文件 ESM bundle（node dist/raincode.mjs …；isDirectRun 的
 * import.meta.url 语义要求 ESM——CJS 输出该值为空对象，desktop agent bundle 用 CJS 是因为
 * 其入口由 main 进程 require 驱动，两者形态不同各自成立）。
 *
 * 三件套：
 * 1. 原生模块外置清单：better-sqlite3（N-API 原生模块）保持 external，运行时经
 *    apps/cli/node_modules 解析（apps/cli 依赖已声明；desktop 同款先例）。其余依赖
 *    （ws / @modelcontextprotocol/sdk / zod 均纯 JS）全部内联，单文件自足。
 * 2. metafile 重复依赖校验：构建后扫 metafile.inputs，同一 npm 包出现多个 .pnpm 实例
 *    （多版本或同版本多 peer 哈希）即失败——zod 双实例会导致 zod schema instanceof 判定
 *    跨包失效（ZCode 真实踩坑），必须在产物落地前拦截。
 * 3. alias 逐条精确声明：@raincode/* 十包逐条映射到各包 src/ 目录（无通配、无前缀猜测；
 *    esbuild alias 按包边界前缀改写，@raincode/rpc/client → packages/rpc/src/client 仍经
 *    文件名解析命中）。包内依赖改写漏声明要到打包产物运行才炸，逐条声明使其在构建期即穷尽。
 *
 * 自举注入（banner，仅 bundle 生效；dev/tsx 形态仍走源码位置解析）：
 * - RAINCODE_MIGRATIONS_DIR → 随包分发的 dist/migrations/（.sql 由本脚本复制）；
 * - RAINCODE_APP_VERSION → 根 package.json version 内联（bundle 内 app-version.ts 的
 *   import.meta.url 相对路径探测不可达）。
 */
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNoDuplicateDependencies } from "./lib/metafile-check.mjs";

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(cliRoot, "..", "..");

/** @raincode/* 十包逐条精确声明（3）；目标为各包 src/ 目录（子路径前缀改写 + /index 解析）。 */
const WORKSPACE_PACKAGES = [
  "shared",
  "rpc",
  "llm",
  "storage",
  "agent-core",
  "tools",
  "permission",
  "server",
  "mcp",
  "memory",
];
const alias = Object.fromEntries(
  WORKSPACE_PACKAGES.map((name) => [`@raincode/${name}`, join(repoRoot, "packages", name, "src")]),
);

const outfile = join(cliRoot, "dist", "raincode.mjs");
const result = await build({
  entryPoints: [join(cliRoot, "src", "index.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: ["better-sqlite3"],
  alias,
  sourcemap: true,
  metafile: true,
  logLevel: "info",
  banner: {
    js: [
      "// T5.7 CLI bundle 自举：migrations 目录与 appVersion 随 bundle 分发（仅 bundle 形态生效）",
      'import { fileURLToPath as __raincodeF2P } from "node:url";',
      'process.env["RAINCODE_MIGRATIONS_DIR"] ??= __raincodeF2P(new URL("./migrations/", import.meta.url));',
      `process.env["RAINCODE_APP_VERSION"] ??= ${JSON.stringify(
        JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version ?? "0.0.0",
      )};`,
      "// ESM 输出的 CJS 互操作：依赖包（cross-spawn 等）的惰性 require(node 内建/可选依赖) 经",
      "// createRequire 提供——esbuild __require shim 优先拾取模块作用域内的 require 绑定",
      'import { createRequire as __raincodeCreateRequire } from "node:module";',
      "const require = __raincodeCreateRequire(import.meta.url);",
    ].join("\n"),
  },
});

// 三件套 2：metafile 重复依赖校验（同一包多 .pnpm 实例即失败；纯函数在 lib/metafile-check.mjs 供单测）
const thirdPartyCount = assertNoDuplicateDependencies(result.metafile);
console.log(`metafile 重复依赖校验通过：${String(thirdPartyCount)} 个第三方包，无重复实例`);

// migrations 随包复制（dist/migrations/*.sql；banner 指向此处）
const migrationsTarget = join(cliRoot, "dist", "migrations");
mkdirSync(migrationsTarget, { recursive: true });
const migrationsSource = join(repoRoot, "packages", "storage", "src", "migrations");
for (const file of readdirSync(migrationsSource)) {
  if (file.endsWith(".sql")) {
    cpSync(join(migrationsSource, file), join(migrationsTarget, file));
  }
}

// 产物可执行性自检：单文件 + migrations + sourcemap 三件齐备
for (const artifact of [outfile, `${outfile}.map`, join(cliRoot, "dist", "migrations", "001_init.sql")]) {
  statSync(artifact);
}
console.log(`CLI bundle OK → ${outfile}`);
