#!/usr/bin/env node
/**
 * 架构检查门禁（04-architecture §6.1 / 07-dev-plan §7.2「policy 即代码」）。
 * 用法：node scripts/architecture-check.mjs（pnpm architecture:check）。零运行时依赖，node 直跑。
 *
 * policy 来源：architecture/policy.yaml。
 * 解析器申报（二选一之 A）：手写极简 YAML 解析器，仅支持本文件用到的语法——
 *   顶层标量 / global 块 / modules 序列（id, roots, managed, requires, publicEntrypoints）/
 *   exceptions 序列 / 行内数组 [...] / `#` 注释；不支持锚点、多行块标量等扩展语法。
 *
 * 检查项（违规输出 file:line，任一违规退出码 1）：
 *   a) 越权依赖：跨包 import 只允许 requires 白名单（04 §6.1 检查 1）
 *   b) 循环依赖：实际 import 构图 + Tarjan SCC，禁环（检查 2）
 *   c) 行数上限：全部 ts/tsx/mts 文件 ≤ global.maxFileLines（packages/ apps/ scripts/，含空行与注释）
 *   d) 深导入：跨包导入只允许目标包 publicEntrypoints（检查 3）
 *   e) managedOnly：packages/* 与 apps/* 下含 package.json 的新目录必须先在 policy 登记（检查 5）
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const policyPath = join(repoRoot, "architecture", "policy.yaml");

// ---------------------------------------------------------------------------
// 极简 YAML 解析（仅支持 policy.yaml 用到的语法，见文件头申报）
// ---------------------------------------------------------------------------

function stripComment(line) {
  const hash = line.indexOf(" #");
  const trimmed = line.startsWith("#") ? "" : hash === -1 ? line : line.slice(0, hash);
  return trimmed.replace(/\s+$/, "");
}

function parseScalar(raw) {
  const t = raw.trim();
  if (t.startsWith("[") && t.endsWith("]")) {
    const inner = t.slice(1, -1).trim();
    return inner.length === 0 ? [] : inner.split(",").map((item) => parseScalar(item));
  }
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  if (/^-?\d+$/.test(t)) return Number.parseInt(t, 10);
  if (t === "true") return true;
  if (t === "false") return false;
  return t;
}

function parsePolicyYaml(text) {
  const items = [];
  for (const line of text.split(/\r?\n/)) {
    const noComment = stripComment(line);
    if (noComment.trim().length === 0) continue;
    items.push({ indent: noComment.length - noComment.trimStart().length, text: noComment.trim() });
  }
  let pos = 0;

  function parseMapInto(map, indent, firstText = null) {
    let pending = firstText;
    for (;;) {
      let entry;
      if (pending !== null) {
        entry = pending;
        pending = null;
      } else {
        if (pos >= items.length || items[pos].indent !== indent) break;
        entry = items[pos].text;
        pos += 1;
      }
      const colon = entry.indexOf(":");
      if (colon === -1) break;
      const key = entry.slice(0, colon).trim();
      const rest = entry.slice(colon + 1).trim();
      if (rest.length > 0) {
        map[key] = parseScalar(rest);
      } else if (pos < items.length && items[pos].indent > indent) {
        map[key] = parseBlock(items[pos].indent);
      } else {
        map[key] = null;
      }
    }
  }

  function parseBlock(indent) {
    if (pos >= items.length) return null;
    const t = items[pos].text;
    if (t === "-" || t.startsWith("- ")) {
      const seq = [];
      while (
        pos < items.length &&
        items[pos].indent === indent &&
        (items[pos].text === "-" || items[pos].text.startsWith("- "))
      ) {
        const dashText = items[pos].text === "-" ? null : items[pos].text.slice(2).trim();
        pos += 1;
        const itemMap = {};
        parseMapInto(itemMap, indent + 2, dashText);
        seq.push(itemMap);
      }
      return seq;
    }
    const map = {};
    parseMapInto(map, indent);
    return map;
  }

  const root = {};
  parseMapInto(root, 0);
  return root;
}

// ---------------------------------------------------------------------------
// 文件扫描
// ---------------------------------------------------------------------------

function toRel(absolutePath) {
  return relative(repoRoot, absolutePath).split(sep).join("/");
}

function walkSourceFiles(dir, out) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkSourceFiles(full, out);
    else if (/\.(ts|tsx|mts)$/i.test(entry.name)) out.push(full);
  }
}

const IMPORT_PATTERNS = [
  /from\s*["']([^"']+)["']/g, // import ... from "x" / export ... from "x"
  /import\s*["']([^"']+)["']/g, // side-effect import
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, // dynamic import
];

function extractImports(content) {
  const lineStarts = [0];
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] === "\n") lineStarts.push(i + 1);
  }
  const lineOf = (index) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (lineStarts[mid] <= index) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
  const found = [];
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(content); match !== null; match = pattern.exec(content)) {
      found.push({ specifier: match[1], line: lineOf(match.index) });
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// policy 消费与检查
// ---------------------------------------------------------------------------

function moduleForFile(relPath, modules) {
  return modules.find((mod) => mod.roots.some((root) => relPath === root || relPath.startsWith(`${root}/`))) ?? null;
}

function tarjanScc(nodes, edges) {
  let index = 0;
  const indexOf = new Map();
  const lowOf = new Map();
  const onStack = new Set();
  const stack = [];
  const sccs = [];
  const visit = (node) => {
    indexOf.set(node, index);
    lowOf.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of edges.get(node) ?? []) {
      if (!indexOf.has(next)) {
        visit(next);
        lowOf.set(node, Math.min(lowOf.get(node), lowOf.get(next)));
      } else if (onStack.has(next)) {
        lowOf.set(node, Math.min(lowOf.get(node), indexOf.get(next)));
      }
    }
    if (lowOf.get(node) === indexOf.get(node)) {
      const scc = [];
      for (;;) {
        const top = stack.pop();
        onStack.delete(top);
        scc.push(top);
        if (top === node) break;
      }
      if (scc.length > 1) sccs.push(scc.sort());
    }
  };
  for (const node of nodes) {
    if (!indexOf.has(node)) visit(node);
  }
  return sccs;
}

function main() {
  if (!existsSync(policyPath)) {
    console.error(`architecture-check: policy 不存在: ${policyPath}`);
    process.exitCode = 1;
    return;
  }
  const policy = parsePolicyYaml(readFileSync(policyPath, "utf8"));
  const global = policy.global ?? {};
  const maxFileLines = typeof global.maxFileLines === "number" ? global.maxFileLines : 500;
  const forbidCycles = global.forbidCycles !== false;
  const forbidDeepImports = global.forbidDeepImports !== false;
  const managedOnly = global.managedOnly !== false;
  const modules = Array.isArray(policy.modules) ? policy.modules : [];
  const exceptions = Array.isArray(policy.exceptions) ? policy.exceptions : [];
  const exemptFiles = new Set(
    exceptions.map((entry) => (typeof entry === "string" ? entry : String(entry?.file ?? ""))).filter((f) => f.length > 0),
  );

  // 包名 → module（读各包 package.json 的 name；@raincode/x 裸导入归一到 module 对象）
  const packageNameToModule = new Map();
  for (const mod of modules) {
    for (const root of mod.roots ?? []) {
      const pkgJsonPath = join(repoRoot, dirname(root), "package.json");
      if (existsSync(pkgJsonPath)) {
        const name = JSON.parse(readFileSync(pkgJsonPath, "utf8")).name;
        if (typeof name === "string") packageNameToModule.set(name, mod);
      }
    }
  }

  const violations = [];
  const push = (rule, file, line, message) => violations.push({ rule, file, line, message });

  // --- 扫描源文件（managed roots 内做 import 检查；packages/apps/scripts 做行数检查）---
  const managedFiles = [];
  for (const mod of modules) {
    for (const root of mod.roots ?? []) walkSourceFiles(join(repoRoot, root), managedFiles);
  }
  const allFiles = new Set(managedFiles);
  for (const dir of ["packages", "apps", "scripts"]) {
    const extra = [];
    walkSourceFiles(join(repoRoot, dir), extra);
    for (const file of extra) allFiles.add(file);
  }

  const edges = new Map(); // 模块级 import 图（实际 import，b) 循环检测输入）

  for (const file of allFiles) {
    const relPath = toRel(file);
    const content = readFileSync(file, "utf8");
    const rawLines = content.split("\n");
    const lineCount = content.endsWith("\n") ? rawLines.length - 1 : rawLines.length; // 行数不含 EOF 换行伪行
    if (lineCount > maxFileLines && !exemptFiles.has(relPath)) {
      push("maxFileLines", relPath, lineCount, `文件 ${lineCount} 行超过上限 ${maxFileLines}`);
    }

    const sourceModule = moduleForFile(relPath, modules);
    if (sourceModule === null) continue; // scripts 等未登记目录不做 import 边界检查
    for (const { specifier, line } of extractImports(content)) {
      if (exemptFiles.has(relPath)) break;
      let targetModule = null;
      let targetFile = null;
      if (specifier.startsWith("@raincode/")) {
        const rest = specifier.slice("@raincode/".length);
        const pkgName = specifier.split("/").slice(0, 2).join("/");
        targetModule = packageNameToModule.get(pkgName) ?? null;
        if (targetModule === null) continue; // 未登记包名交由 managedOnly/外部依赖口径
        if (rest.includes("/")) {
          // 登记式子路径入口（T2.9）：policy publicEntrypoints 支持 "@raincode/x/y=path" 形态
          const subpathEntrypoints = (targetModule.publicEntrypoints ?? [])
            .filter((entry) => typeof entry === "string" && entry.startsWith(`${specifier}=`))
            .map((entry) => entry.slice(specifier.length + 1));
          if (subpathEntrypoints.length > 0) {
            targetFile = subpathEntrypoints[0];
            targetModule = targetModule; // 同包子路径入口，继续走 requires/entrypoint 校验
          } else if (forbidDeepImports) {
            push("forbidDeepImports", relPath, line, `深导入 "${specifier}"（跨包只允许 publicEntrypoints）`);
            continue;
          } else {
            continue;
          }
        } else {
          targetFile = (targetModule.publicEntrypoints ?? []).find((entry) => !entry.includes("=")) ?? null;
        }
      } else if (specifier.startsWith(".")) {
        const base = isAbsolute(specifier) ? specifier : join(dirname(file), specifier);
        if (!existsSync(base) && existsSync(`${base}.ts`)) targetFile = toRel(`${base}.ts`);
        else if (existsSync(base) && statSync(base).isDirectory()) targetFile = toRel(join(base, "index.ts"));
        else targetFile = toRel(base);
        targetModule = moduleForFile(targetFile ?? "", modules);
        if (targetModule === null) continue; // 模块内相对导入或模块外文件
      } else {
        continue; // 三方依赖（zod 等）
      }
      if (targetModule.id === sourceModule.id) continue; // 包内导入
      // a) 越权依赖
      const requires = sourceModule.requires ?? [];
      if (!requires.includes(targetModule.id)) {
        push("requires", relPath, line, `越权依赖：${sourceModule.id} → ${targetModule.id}（白名单: [${requires.join(", ")}]）`);
      }
      // d) 深导入（相对路径绕过包名也要落到 publicEntrypoints；子路径入口按 "=" 右侧路径比对）
      const entrypoints = (targetModule.publicEntrypoints ?? []).map((entry) =>
        typeof entry === "string" && entry.includes("=") ? entry.slice(entry.indexOf("=") + 1) : entry,
      );
      if (forbidDeepImports && entrypoints.length > 0 && !entrypoints.includes(targetFile)) {
        push("forbidDeepImports", relPath, line, `深导入 ${targetFile}（只允许 ${entrypoints.join(", ")}）`);
      }
      if (!edges.has(sourceModule.id)) edges.set(sourceModule.id, new Set());
      edges.get(sourceModule.id).add(targetModule.id);
    }
  }

  // b) 循环依赖（Tarjan SCC，实际 import 构图）
  if (forbidCycles) {
    const nodeSet = new Set();
    for (const [from, tos] of edges) {
      nodeSet.add(from);
      for (const to of tos) nodeSet.add(to);
    }
    for (const scc of tarjanScc([...nodeSet], edges)) {
      push("forbidCycles", "(module graph)", 0, `循环依赖：${scc.join(" → ")} → ${scc[0]}`);
    }
  }

  // e) managedOnly：packages/* 与 apps/* 下含 package.json 的目录必须登记
  if (managedOnly) {
    for (const base of ["packages", "apps"]) {
      const baseDir = join(repoRoot, base);
      if (!existsSync(baseDir)) continue;
      for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const pkgJson = join(baseDir, entry.name, "package.json");
        if (!existsSync(pkgJson)) continue;
        const registered = modules.some((mod) =>
          (mod.roots ?? []).some((root) => root.split("/")[1] === entry.name && root.startsWith(`${base}/`)),
        );
        if (!registered) {
          push("managedOnly", `${base}/${entry.name}`, 0, "未登记目录：新包必须先在 architecture/policy.yaml 登记 roots");
        }
      }
    }
  }

  // --- 报告 ---
  if (violations.length === 0) {
    const scannedModules = modules.length;
    console.log(
      `architecture-check OK · policy v${String(policy.version ?? "?")} · ${String(scannedModules)} modules · ` +
        `maxFileLines=${String(maxFileLines)} · forbidCycles=${String(forbidCycles)} · forbidDeepImports=${String(forbidDeepImports)} · managedOnly=${String(managedOnly)}`,
    );
    console.log(`  扫描文件 ${String(allFiles.size)} 个（import 检查 ${String(managedFiles.length)} 个 managed 源文件），0 违规`);
    return;
  }
  console.error(`architecture-check FAILED · ${String(violations.length)} 项违规`);
  const byRule = new Map();
  for (const v of violations) {
    if (!byRule.has(v.rule)) byRule.set(v.rule, []);
    byRule.get(v.rule).push(v);
  }
  for (const [rule, items] of byRule) {
    console.error(`\n[${rule}] ${String(items.length)} 项`);
    for (const v of items) {
      console.error(`  ${v.file}${v.line > 0 ? `:${String(v.line)}` : ""}  ${v.message}`);
    }
  }
  process.exitCode = 1;
}

main();
