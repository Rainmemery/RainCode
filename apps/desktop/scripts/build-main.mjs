/** esbuild bundle Electron main 与 preload：dist-electron/main/{main,preload}.cjs（CJS 保 __dirname）。 */
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

await Promise.all([
  build({
    entryPoints: [join(root, "src", "main", "main.ts")],
    outfile: join(root, "dist-electron", "main", "main.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["electron"],
    sourcemap: false,
    logLevel: "info",
  }),
  build({
    entryPoints: [join(root, "src", "main", "preload.ts")],
    outfile: join(root, "dist-electron", "main", "preload.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["electron"],
    sourcemap: false,
    logLevel: "info",
  }),
]);
