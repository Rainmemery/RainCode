/**
 * MEMORY.md 文件真源读写（02 §7.1/§7.3；05 §5.1：`<workspace>/.novacode/MEMORY.md`）。
 *
 * 路径勘误（任务交付申报）：02 §7.1 原文写作 `<workspace>/.nova/MEMORY.md` 系笔误——
 * 项目数据目录统一为 `.novacode`（与 `.novacode/mcp.json`、`.novacode/agents/` 一致；
 * 05 §5.1 第一层行亦作 `.novacode`），本实现按 `.novacode` 落地。
 *
 * 语义纪律：
 * - read 只读不落盘：文件不存在返回模板骨架 + exists:false（06 §2.6 memory.read）；
 *   初始化落盘只发生在显式写路径（write/promote，文件缺失时先落模板再改，02 §7.3 末行）；
 * - 写路径 = 读-改-写 + 文件级冲突检测（读时记 mtime，写前重 stat，变更即
 *   MEMORY_WRITE_CONFLICT 放弃，02 §7.4）+ 原子提交（同目录临时文件 + rename）；
 * - 文件是唯一真源，被用户手工改动时以文件为准（02 §7.4）。
 */
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { MEMORY_ERROR_CODES } from "@novacode/shared";
import type { MemorySection } from "@novacode/shared";
import { MemoryError } from "../errors.js";

/** MEMORY.md 项目数据目录与文件名（05 §5.1；02 §7.1 `.nova` 为笔误，见文件头勘误）。 */
export const MEMORY_FILE_DIR = ".novacode";
export const MEMORY_FILE_NAME = "MEMORY.md";

/** MEMORY.md 绝对路径。 */
export function projectMemoryPath(workspaceRoot: string): string {
  return join(workspaceRoot, MEMORY_FILE_DIR, MEMORY_FILE_NAME);
}

/** 章节模板（02 §7.3 原文；启动注入即此文件原文）。 */
export const MEMORY_TEMPLATE = `# MEMORY.md — <项目名>

## 项目概览
<!-- 人工维护：一段话说清这个项目是什么、为谁服务 -->

## 技术栈与命令
<!-- 人工维护：构建/测试/运行命令，包管理器约定 -->

## 工作约定
<!-- 共同维护：命名规范、分支策略、提交规范、禁做事项 -->

## 当前进行
<!-- Agent 专用：进行中的任务快照，会话结束时可更新 -->

## 已知坑
<!-- 共同维护：环境坑、依赖坑、反复踩过的错误 -->

## Agent 备忘
<!-- Agent 专用：面向后续会话的工作笔记 -->
`;

function isEnoent(reason: unknown): boolean {
  return reason instanceof Error && (reason as NodeJS.ErrnoException).code === "ENOENT";
}

/** 启动注入（02 §7.3 loadProjectMemory）：不存在返回模板骨架 exists:false，不落盘。 */
export async function loadProjectMemory(workspaceRoot: string): Promise<{ content: string; exists: boolean }> {
  try {
    const content = await readFile(projectMemoryPath(workspaceRoot), "utf8");
    return { content, exists: true };
  } catch (reason: unknown) {
    if (isEnoent(reason)) {
      return { content: MEMORY_TEMPLATE, exists: false };
    }
    throw reason;
  }
}

// ---------------------------------------------------------------------------
// 章节定位与改写（模板章节头即 `## 项目概览` 等字面量，02 §7.3）
// ---------------------------------------------------------------------------

/** 定位 `## <section>` 章节体的行区间 [bodyStart, bodyEnd)（到下一 `## ` 或 EOF）。 */
function locateSection(lines: string[], section: string): { bodyStart: number; bodyEnd: number } | null {
  const heading = `## ${section}`;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]?.trim() !== heading) {
      continue;
    }
    let bodyEnd = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]?.startsWith("## ")) {
        bodyEnd = j;
        break;
      }
    }
    return { bodyStart: i + 1, bodyEnd };
  }
  return null;
}

function trimTrailingBlankLines(lines: string[]): string[] {
  const out = [...lines];
  while (out.length > 0 && out[out.length - 1]?.trim() === "") {
    out.pop();
  }
  return out;
}

function contentToLines(content: string): string[] {
  return content.replace(/\n+$/, "").split("\n");
}

/** 替换章节体；章节缺失（用户删除）时文末补回（模板结构自愈）。 */
function replaceSectionBody(lines: string[], section: string, bodyLines: string[]): string[] {
  const loc = locateSection(lines, section);
  if (loc === null) {
    return [...trimTrailingBlankLines(lines), "", `## ${section}`, ...bodyLines];
  }
  const keepSeparator = loc.bodyEnd < lines.length ? [""] : [];
  return [...lines.slice(0, loc.bodyStart), ...bodyLines, ...keepSeparator, ...lines.slice(loc.bodyEnd)];
}

/** 章节体末尾追加一行（promote 用）；章节缺失时文末补回。 */
function appendSectionLine(lines: string[], section: string, line: string): string[] {
  const loc = locateSection(lines, section);
  if (loc === null) {
    return [...trimTrailingBlankLines(lines), "", `## ${section}`, `- ${line}`];
  }
  const body = trimTrailingBlankLines(lines.slice(loc.bodyStart, loc.bodyEnd));
  const keepSeparator = loc.bodyEnd < lines.length ? [""] : [];
  return [...lines.slice(0, loc.bodyStart), ...body, `- ${line}`, ...keepSeparator, ...lines.slice(loc.bodyEnd)];
}

/** 序列化：以恰好一个换行收尾。 */
function serialize(lines: string[]): string {
  return `${trimTrailingBlankLines(lines).join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// 写路径（读-改-写 + mtime 冲突检测 + 原子提交，02 §7.4）
// ---------------------------------------------------------------------------

interface FileSnapshot {
  exists: boolean;
  mtimeMs: number | null;
}

async function snapshot(path: string): Promise<FileSnapshot> {
  try {
    const s = await stat(path);
    return { exists: true, mtimeMs: s.mtimeMs };
  } catch (reason: unknown) {
    if (isEnoent(reason)) {
      return { exists: false, mtimeMs: null };
    }
    throw reason;
  }
}

/** 读-改-写公共骨架：文件缺失先落模板；写前 mtime 复检，变更即 MEMORY_WRITE_CONFLICT。 */
async function commitSectionEdit(
  workspaceRoot: string,
  edit: (lines: string[]) => string[],
): Promise<void> {
  const path = projectMemoryPath(workspaceRoot);
  let base: string[];
  let before: FileSnapshot;
  try {
    base = (await readFile(path, "utf8")).split("\n");
    before = await snapshot(path);
    if (!before.exists) {
      // 读到 stat 之间被删除：按缺失路径处理（先落模板）
      base = MEMORY_TEMPLATE.split("\n");
      before = { exists: false, mtimeMs: null };
    }
  } catch (reason: unknown) {
    if (!isEnoent(reason)) {
      throw reason;
    }
    base = MEMORY_TEMPLATE.split("\n");
    before = { exists: false, mtimeMs: null };
  }

  const after = await snapshot(path);
  const changed =
    after.exists !== before.exists ||
    (after.exists && before.exists && after.mtimeMs !== before.mtimeMs);
  if (changed) {
    // 多窗口并发：后写者检测到 mtime 变更即放弃本次写入（02 §7.4）
    throw new MemoryError(
      MEMORY_ERROR_CODES.WRITE_CONFLICT,
      `MEMORY.md changed concurrently, write abandoned: ${path}`,
    );
  }

  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, serialize(edit(base)), "utf8");
  await rename(tmp, path); // 同目录 rename 原子提交（02 §7.4）
}

/** memory.write（06 §2.6）：定位 `## <section>` 章节体并整体替换；白名单校验由 service 层负责。 */
export async function updateAgentSection(
  workspaceRoot: string,
  section: MemorySection,
  content: string,
): Promise<void> {
  await commitSectionEdit(workspaceRoot, (lines) =>
    replaceSectionBody(lines, section, contentToLines(content)),
  );
}

/** memory.promote（06 §2.6）：章节体末尾追加 `- <line>`；只改文件不改 memory_entries（05 §5.1）。 */
export async function appendToSection(
  workspaceRoot: string,
  section: MemorySection,
  line: string,
): Promise<void> {
  await commitSectionEdit(workspaceRoot, (lines) =>
    appendSectionLine(lines, section, line.replace(/\r?\n/g, " ").trim()),
  );
}
