/** esbuild bundle 打包形态 agent 入口：dist-electron/agent/entry.cjs（better-sqlite3 保持 external，随 asarUnpack 分发）。
 * 迁移 .sql 随包复制到 dist-electron/agent/migrations/（运行时经 RAINCODE_MIGRATIONS_DIR 指向）。 */
import { build } from "esbuild";
import { cpSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(root, "..", "..");

await build({
  entryPoints: [join(root, "src", "agent", "entry.ts")],
  outfile: join(root, "dist-electron", "agent", "entry.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["better-sqlite3", "electron"],
  sourcemap: false,
  logLevel: "info",
});

const migrationsTarget = join(root, "dist-electron", "agent", "migrations");
mkdirSync(migrationsTarget, { recursive: true });
for (const file of readdirSync(join(repoRoot, "packages", "storage", "src", "migrations"))) {
  if (file.endsWith(".sql")) {
    cpSync(join(repoRoot, "packages", "storage", "src", "migrations", file), join(migrationsTarget, file));
  }
}
const appVersion = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version ?? "0.0.0";
console.log(`migrations copied → ${migrationsTarget}; appVersion=${String(appVersion)}`);
