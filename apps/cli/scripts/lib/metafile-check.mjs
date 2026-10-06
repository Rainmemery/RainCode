/**
 * metafile 重复依赖校验纯函数（T5.7 L-16 三件套之二；自 build.mjs 抽出供单测——
 * zod 双实例致 schema instanceof 跨包失效属 ZCode 真实踩坑，必须在产物落地前拦截）。
 *
 * metafile.inputs 键为参与打包的每个文件路径：pnpm 实例路径形如
 * `node_modules/.pnpm/<name>@<version>[_<peer…>]/node_modules/<pkg>/…`（scoped 包名 + → /）；
 * workspace 源码经 alias 直接以各包 src/ 目录进入（非第三方依赖，不参与校验）。
 * 判定：按包名分组，>1 个物理实例（不同版本或同版本不同 peer 哈希）即重复。
 */

/** 从 metafile.inputs 收集第三方依赖物理实例：包名 → 实例 spec 集合（纯函数，供单测）。 */
export function collectDependencyInstances(metafile) {
  const byPackage = new Map();
  for (const key of Object.keys(metafile.inputs)) {
    const normalized = key.replaceAll("\\", "/");
    if (!normalized.includes("node_modules/.pnpm/")) {
      continue; // workspace 源码 / 入口文件非第三方依赖
    }
    // .pnpm 目录名 = 完整实例 spec：`<name>@<version>[_<peer>@<peer-version>…]`（scoped 名 + → /）。
    // 按**完整 spec** 键控（不做 peer 剥离）——peer 剥离会把「同版本不同 peer 集」两个物理实例
    // 折叠成同一键而漏报；每个 .pnpm 目录就是一个独立模块实例，instanceof 风险按物理实例判定。
    const spec = normalized.split("node_modules/.pnpm/")[1].split("/")[0];
    // 包名 = 首个「后随数字的 @」之前的部分（版本恒以数字开头；peer 后缀中的 @ 不会被误命中——
    // lastIndexOf 会截到 peer 名里的 @，故不可用）；scoped 名以 @ 开头（后随字母）自然跳过。
    let at = -1;
    for (let i = 1; i < spec.length; i += 1) {
      if (spec[i] === "@" && i + 1 < spec.length && spec.charCodeAt(i + 1) >= 48 && spec.charCodeAt(i + 1) <= 57) {
        at = i;
        break;
      }
    }
    if (at <= 0) {
      continue; // 形态异常防御：非 <name>@<version> 结构不误报
    }
    const name = spec.slice(0, at).replaceAll("+", "/");
    if (!byPackage.has(name)) byPackage.set(name, new Set());
    byPackage.get(name).add(spec);
  }
  return byPackage;
}

/** 重复依赖断言：同一包存在多个物理实例即抛错（多版本或同版本多 peer 哈希）。 */
export function assertNoDuplicateDependencies(metafile) {
  const byPackage = collectDependencyInstances(metafile);
  const duplicates = [...byPackage.entries()].filter(([, instances]) => instances.size > 1);
  if (duplicates.length > 0) {
    const detail = duplicates.map(([name, instances]) => `  ${name}: ${[...instances].join(", ")}`).join("\n");
    throw new Error(
      `metafile 重复依赖校验失败（同一包存在多个物理实例，schema/instanceof 跨实例失效风险）:\n${detail}`,
    );
  }
  return byPackage.size;
}
