/** pinned 包管理器校验（实现见 check-pinned-manager.mjs；.d.mts 供 NodeNext 下的 TS 单测导入）。 */

/** 解析并校验 packageManager 字段形态：必须为精确 `pnpm@<exact semver>`（可选 +sha512 哈希后缀）；非法即抛错。 */
export function parsePinnedManager(field: unknown): { name: "pnpm"; version: string };
