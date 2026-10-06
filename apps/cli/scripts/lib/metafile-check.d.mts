/** metafile 重复依赖校验纯函数（实现见 metafile-check.mjs；.d.mts 供 NodeNext 下的 TS 单测导入）。 */

/** esbuild metafile 最小形状（校验只消费 inputs 键集）。 */
export interface Metafile {
  inputs: Record<string, unknown>;
}

/** 从 metafile.inputs 收集第三方依赖物理实例：包名 → 实例 spec 集合（pnpm .pnpm 路径解析）。 */
export function collectDependencyInstances(metafile: Metafile): Map<string, Set<string>>;

/** 重复依赖断言：同一包存在多个物理实例（多版本或同版本多 peer 哈希）即抛错；返回第三方包总数。 */
export function assertNoDuplicateDependencies(metafile: Metafile): number;
