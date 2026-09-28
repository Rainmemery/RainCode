/**
 * 目录遍历（glob/grep 共用）：node:fs 自实现（零三方依赖；注释标注后续可替换
 * fast-glob / ripgrep 原生实现以提升大规模仓库性能——02 §2.3 grep「ripgrep 语义」）。
 * 默认忽略 node_modules / .git（任务约定）。
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";

/** 默认忽略目录（遍历剪枝）。 */
export const DEFAULT_IGNORED_DIRS = new Set(["node_modules", ".git"]);

export interface WalkOptions {
  /** 额外忽略的目录名。 */
  ignoredDirs?: Set<string>;
  /** 深度上限（防符号链接环/异常深树；缺省 32）。 */
  maxDepth?: number;
  /** 遍历上限（文件数；防异常洪泛）。 */
  maxEntries?: number;
}

export interface WalkEntry {
  absolutePath: string;
  /** 相对 root 的路径（posix 分隔符，模式匹配基准）。 */
  relativePath: string;
  isDirectory: boolean;
}

export async function walkFiles(root: string, options: WalkOptions = {}): Promise<WalkEntry[]> {
  const ignored = options.ignoredDirs ?? DEFAULT_IGNORED_DIRS;
  const maxDepth = options.maxDepth ?? 32;
  const maxEntries = options.maxEntries ?? 20_000;
  const out: WalkEntry[] = [];

  async function visit(dir: string, relative: string, depth: number): Promise<void> {
    if (depth > maxDepth || out.length >= maxEntries) {
      return;
    }
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // 无权限/竞态删除：跳过不中断
    }
    for (const dirent of dirents) {
      if (out.length >= maxEntries) {
        return;
      }
      const name = dirent.name;
      const abs = join(dir, name);
      const rel = relative.length === 0 ? name : `${relative}/${name}`;
      if (dirent.isDirectory()) {
        if (ignored.has(name)) {
          continue;
        }
        await visit(abs, rel, depth + 1);
        continue;
      }
      out.push({
        absolutePath: abs,
        relativePath: rel,
        isDirectory: dirent.isDirectory(),
      });
    }
  }

  await visit(root, "", 0);
  return out;
}
