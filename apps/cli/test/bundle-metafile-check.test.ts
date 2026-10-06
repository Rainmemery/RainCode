/**
 * metafile 重复依赖校验单测（T5.7 门禁升级轮测试补全；实现 apps/cli/scripts/lib/metafile-check.mjs）。
 * 动因：zod 双实例致 schema instanceof 跨包失效属 ZCode 真实踩坑（调研报告 §2.3）——
 * 构建期拦截「同一包多个物理实例」（多版本或同版本多 peer 哈希两形态）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectDependencyInstances, assertNoDuplicateDependencies } from "../scripts/lib/metafile-check.mjs";

/** 便捷构造：inputs 键集合 → metafile 形状。 */
function metafileOf(...inputs: string[]): { inputs: Record<string, unknown> } {
  return { inputs: Object.fromEntries(inputs.map((key) => [key, { bytesInOutput: 1 }])) };
}

describe("metafile 重复依赖校验（T5.7 L-16 三件套之二）", () => {
  it("单实例多包：通过并返回第三方包总数", () => {
    const metafile = metafileOf(
      "node_modules/.pnpm/zod@3.25.76/node_modules/zod/lib/index.mjs",
      "node_modules/.pnpm/ws@8.22.0/node_modules/ws/index.js",
      "node_modules/.pnpm/@modelcontextprotocol+sdk@1.29.0/node_modules/@modelcontextprotocol/sdk/dist/esm/index.js",
      "packages/shared/src/index.ts", // workspace 源码不参与
      "src/index.ts",
    );
    const byPackage = collectDependencyInstances(metafile);
    assert.equal(byPackage.size, 3, "workspace/入口路径不入计");
    assert.deepEqual([...byPackage.get("@modelcontextprotocol/sdk")!], ["@modelcontextprotocol+sdk@1.29.0"], "scoped 包名 + 还原为 /");
    assert.equal(assertNoDuplicateDependencies(metafile), 3);
  });

  it("同一包多版本（zod@3.25 + zod@3.26）：抛错并列出实例", () => {
    const metafile = metafileOf(
      "node_modules/.pnpm/zod@3.25.76/node_modules/zod/lib/index.mjs",
      "node_modules/.pnpm/zod@3.26.0/node_modules/zod/lib/index.mjs",
    );
    assert.throws(
      () => assertNoDuplicateDependencies(metafile),
      (err: Error) => err.message.includes("zod") && err.message.includes("zod@3.25.76") && err.message.includes("zod@3.26.0"),
    );
  });

  it("同版本不同 peer 哈希（.pnpm 目录名带 _peer 后缀）：同为不同物理实例，抛错", () => {
    const metafile = metafileOf(
      "node_modules/.pnpm/react@18.3.1/node_modules/react/index.js",
      "node_modules/.pnpm/react@18.3.1_peerhash/node_modules/react/index.js",
    );
    assert.throws(() => assertNoDuplicateDependencies(metafile), /react@18\.3\.1/);
  });

  it("反斜杠路径（Windows metafile）与反例：归一化后同样判定", () => {
    const single = metafileOf(
      "node_modules\\.pnpm\\zod@3.25.76\\node_modules\\zod\\lib\\index.mjs",
      "node_modules\\.pnpm\\zod@3.25.76\\node_modules\\zod\\lib\\parse.mjs",
    );
    assert.equal(collectDependencyInstances(single).get("zod")!.size, 1, "同实例多文件不算重复");
    const cross = metafileOf(
      "node_modules\\.pnpm\\zod@3.25.76\\node_modules\\zod\\lib\\index.mjs",
      "node_modules/.pnpm/zod@3.26.0/node_modules/zod/lib/index.mjs",
    );
    assert.throws(() => assertNoDuplicateDependencies(cross), /zod@3\.25\.76.*zod@3\.26\.0|zod@3\.26\.0.*zod@3\.25\.76/s);
  });

  it("形态异常防御：非 <name>@<version> 结构不误报", () => {
    const metafile = metafileOf("node_modules/.pnpm/weird-dir-name/node_modules/x/index.js");
    assert.equal(collectDependencyInstances(metafile).size, 0);
  });
});
