/**
 * marketplace 文件系统原语（T6.1，marketplace-runtime 的无状态底座）：
 * 插件树内容哈希（内容寻址种子）与 symlink/junction 逃逸防护（07 §12.2 T6.1 验收项）。
 *
 * 逃逸防护口径（06 §2.10 v1.14）：安装前逐条目 realpath 解析，解析结果必须落在插件根
 * realpath 之内——插件树内任何 symlink/junction（含嵌套）指向根外即拒绝安装（不部分拷贝），
 * 悬空链接（realpath ENOENT）同拒。越界路径随异常透出供审计（诊断 + 错误消息，不入审计表
 * ——决策审计仅权限判定域）。
 *
 * 哈希口径：插件树内全部文件按「相对路径（posix 分隔符）+ 内容」序化进 sha256；目录条目
 * 按“每层字典序”遍历保证确定性；种子文件本身（.zcode-plugin-seed.json）不参与哈希亦不参与
 * 拷贝（安装器写入物，非插件内容——同 ZCode seed 语义）。
 */
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/** 种子文件名（安装副本根内；哈希与拷贝均跳过）。 */
export const MARKETPLACE_SEED_FILE = ".zcode-plugin-seed.json";

/** 逃逸防护失败（offendingPath = 越界条目绝对路径；映射为 MARKETPLACE_ESCAPE_BLOCKED）。 */
export class MarketplaceEscapeError extends Error {
  constructor(
    public readonly offendingPath: string,
    message: string,
  ) {
    super(message);
    this.name = "MarketplaceEscapeError";
  }
}

interface WalkEntry {
  /** posix 分隔符相对路径（哈希与拷贝目标共同键）。 */
  rel: string;
  /** 解析后的真实绝对路径（symlink/junction 已解出；落在根内）。 */
  real: string;
  kind: "file" | "dir";
}

/**
 * 逃逸防护 + 树列举合一遍历：返回插件树全部条目（symlink 已解为根内真实路径）。
 * 根目录自身先 realpath（市场源可整体位于 junction 之后，属用户层编排，非插件树逃逸）；
 * 条目级 symlink/junction 解析后越界（或悬空）即抛 MarketplaceEscapeError。
 */
async function walkPluginTree(root: string): Promise<{ rootReal: string; entries: WalkEntry[] }> {
  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch (reason: unknown) {
    throw new MarketplaceEscapeError(root, `plugin root realpath failed: ${String(reason)}`);
  }
  const entries: WalkEntry[] = [];

  async function visit(dirReal: string, relBase: string): Promise<void> {
    const items = (await readdir(dirReal, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const item of items) {
      const rel = relBase === "" ? item.name : `${relBase}/${item.name}`;
      if (item.name === MARKETPLACE_SEED_FILE) {
        continue; // 种子文件：安装器写入物，不属于插件内容（哈希/拷贝双跳过）
      }
      const full = join(dirReal, item.name);
      let real: string;
      try {
        real = item.isSymbolicLink() ? await realpath(full) : full;
      } catch (reason: unknown) {
        throw new MarketplaceEscapeError(full, `unresolvable symlink in plugin tree: ${full}（${String(reason)}）`);
      }
      // Windows 大小写不敏感与分隔符差异：统一小写 + 双向分隔符归一再比对前缀。
      const inside =
        real === rootReal ||
        real.toLowerCase().replaceAll(sep, "/").startsWith(`${rootReal.toLowerCase().replaceAll(sep, "/")}/`);
      if (!inside) {
        throw new MarketplaceEscapeError(
          full,
          `symlink/junction escape blocked: ${full} resolves to ${real} outside plugin root ${rootReal}`,
        );
      }
      if (item.isDirectory() || (item.isSymbolicLink() && (await stat(real)).isDirectory())) {
        entries.push({ rel, real, kind: "dir" });
        await visit(real, rel);
      } else {
        entries.push({ rel, real, kind: "file" });
      }
    }
  }

  await visit(rootReal, "");
  return { rootReal, entries };
}

/**
 * 插件树内容哈希（sha256 hex）：相对路径 posix 化 + \0 + 文件内容，逐条目 update；
 * 先跑逃逸防护（同一遍历，防护失败即抛，不产出哈希）。
 */
export async function hashPluginTree(root: string): Promise<string> {
  const { entries } = await walkPluginTree(root);
  const hash = createHash("sha256");
  for (const entry of entries) {
    if (entry.kind !== "file") {
      continue;
    }
    hash.update(`${entry.rel}\0`);
    hash.update(await readFile(entry.real));
  }
  return hash.digest("hex");
}

/**
 * 逃逸防护单跑（不拷贝场景——安装前置校验复用同一遍历）。
 * 通过即静默返回；失败抛 MarketplaceEscapeError。
 */
export async function assertPluginTreeContainment(root: string): Promise<void> {
  await walkPluginTree(root);
}

/** 目录树拷贝（防护后调用）：按列举条目逐文件复制到目标相对路径（mkdir -p 保目录层）。 */
export async function copyPluginTree(root: string, target: string): Promise<{ files: number }> {
  const { entries } = await walkPluginTree(root);
  let files = 0;
  for (const entry of entries) {
    const dest = join(target, ...entry.rel.split("/"));
    if (entry.kind === "dir") {
      await mkdir(dest, { recursive: true });
    } else {
      await mkdir(join(dest, ".."), { recursive: true });
      await copyFile(entry.real, dest);
      files += 1;
    }
  }
  return { files };
}

/** 相对路径是否落在 base 之内（resolve 级；realpath 级防护在 walkPluginTree）。 */
export function isPathInside(base: string, candidate: string): boolean {
  const rel = relative(base, candidate);
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith(`..${sep}`) && rel !== `..${sep}`;
}

/** lstat 判目录存在（注册表 path 源校验用；不存在/非目录返回 false）。 */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}
