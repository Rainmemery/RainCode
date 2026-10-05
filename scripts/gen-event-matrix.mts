/**
 * T5.5 事件生产者/消费者矩阵生成器（07-dev-plan §11.2；扩展 T4.3 gen 管线，dsh event-producer-consumer 同形态）。
 * 运行：tsx scripts/gen-event-matrix.mts（或 pnpm event-matrix:gen / pnpm event-matrix:check）
 *
 * 从源码扫描生成 docs/generated/event-matrix.md：每个事件的 声明处 / 派发点（emit）/ 监听点（listen）。
 * 事件全集 = EVENT_SCHEMAS（协议事件，packages/shared）∪ STORAGE_EVENTS 登记表（存储级/审计事件）。
 * 双模式：gen（缺省）再生成并随代码提交；--check 内存再生成与磁盘逐字节比对，不一致即退出码 1（CI 门禁 6）。
 *
 * 分类规则（确定性，行级扫描 packages/<pkg>/src + apps/<app>/src，跳过 test 目录与注释行）：
 *   派发 = 行含事件字面量（或存储事件常量标识符）且匹配 emit 调用形态
 *          （emitPersisted/emitAudit/publish/appendEvent/emit 调用，或对象键 name:"x.y"——subagent-runtime 先例）；
 *   监听 = apps 层行匹配 case "x.y": / onEvent("x.y" / 注册数组独立键行；packages 层行匹配 === 常量标识符
 *          （jsonl-resume 重放应用先例）。
 *   声明 = 协议事件取 shared/src/index.ts 注册表；存储级事件取登记表声明文件。
 *
 * 登记式纪律（dsh：显式收录绕过点）：
 *   - STORAGE_EVENTS：不入 RPC 协议目录的落盘事件（常量名 + 声明文件 + 备注）显式登记；
 *   - EXCLUDED_PREFIXES：命中但非事件语义的文件（UI 组件状态 switch / rpc 传输管道）显式排除并注因；
 *   - OVERRIDES：正则不可达的派发点（事件经变量转发）显式补录；
 *   - 防漏登记守卫：扫描全部源码中「事件域前缀 + 点分小写」形态的字面量，凡不在
 *     （协议事件 ∪ 存储登记 ∪ METHOD_SCHEMAS 方法名）即报错退出 1——新事件必须登记后才能过门禁。
 *
 * 输出确定性：事件与文件均排序，无时间戳——同源码必得同字节输出，--check 才可判漂移。
 * 职责边界（写入生成物头）：生成物 = 源码扫描的机械投影；事件语义、时序、投递行为仍以
 * docs/06-api-spec.md §3 与 docs/02-module-design.md 手写章节为唯一权威。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { EVENT_SCHEMAS, METHOD_SCHEMAS } from "../packages/shared/src/index.ts";

// ---------------------------------------------------------------------------
// 登记表（dsh 纪律：故意绕过 ctx.emit 的派发点 / 非事件语义命中 显式登记）
// ---------------------------------------------------------------------------

interface StorageEventEntry {
  name: string;
  /** 事件字面量在包内的常量标识符（使用点经标识符引用，字面量仅出现在声明行；无常量则 null）。 */
  constant: string | null;
  /** 声明文件（仓库相对路径，正斜杠）。 */
  declaredIn: string;
  level: "storage" | "dual";
  note: string;
}

/** 存储级事件登记表：仅落盘事件流、不入 RPC 协议目录（06 §3 / 05 §4.2）；dual = 协议事件双栖。 */
const STORAGE_EVENTS: StorageEventEntry[] = [
  {
    name: "session.created",
    constant: "HEADER_EVENT_NAME",
    declaredIn: "packages/storage/src/jsonl-lines.ts",
    level: "dual",
    note: "双栖：协议事件（会话创建）+ 会话日志头行（HEADER_EVENT_NAME）",
  },
  {
    name: "compaction.applied",
    constant: "COMPACTION_EVENT_NAME",
    declaredIn: "packages/storage/src/jsonl-lines.ts",
    level: "storage",
    note: "auto/manual compact 摘要落盘（epoch+1，05 §4.2）",
  },
  {
    name: "compaction.pruned",
    constant: "COMPACTION_PRUNED_EVENT_NAME",
    declaredIn: "packages/storage/src/jsonl-lines.ts",
    level: "storage",
    note: "microcompact 预剪枝落盘（T5.4；不取压缩锁、不 bump epoch）",
  },
  {
    name: "hook.invoked",
    constant: null,
    declaredIn: "packages/agent-core/src/turn/loop-events.ts",
    level: "storage",
    note: "log-only 审计对（T5.1；dispatch 即记，含未授信跳过计数）",
  },
  {
    name: "hook.result",
    constant: null,
    declaredIn: "packages/agent-core/src/turn/loop-events.ts",
    level: "storage",
    note: "log-only 审计对（T5.1；per hook 进程事实，stderr 截断落盘）",
  },
];

/** 排除登记：文件路径前缀 → 原因（命中字面量但非事件语义，不入矩阵列）。 */
const EXCLUDED_PREFIXES: Array<[string, string]> = [
  ["apps/desktop/src/renderer/components/", "UI 组件内 case \"error\" 等为工具卡/条目状态分发（非协议事件监听）"],
  ["apps/web/src/components/", "同上（Web 端组件目录，ToolCard case \"error\" 为工具卡状态分发）"],
  ["packages/rpc/", "传输管道：分帧/批量窗口/转发，语义监听面在端层（06 §3）"],
];

/** 覆盖登记：正则不可达的派发点显式补录（dsh「显式收录故意绕过 ctx.emit 的派发点」）。 */
const OVERRIDES: Array<{ event: string; file: string; note: string }> = [
  {
    event: "tool_call.started",
    file: "packages/agent-core/src/subagent/mirror.ts",
    note: "子代理镜像：按字面量比对子 turn 事件并向上转发（事件经变量 emit，正则不可达）",
  },
  {
    event: "permission.requested",
    file: "packages/agent-core/src/turn/tool-phase.ts",
    note: "tool-phase 事件出口：经 emitPersisted(name, build) 变量形态派发（首 turn 审批路径）",
  },
  {
    event: "permission.resolved",
    file: "packages/agent-core/src/turn/tool-phase.ts",
    note: "tool-phase 事件出口：经 emitPersisted(name, build) 变量形态派发",
  },
  {
    event: "compaction.applied",
    file: "packages/agent-core/src/compact/service.ts",
    note: "经多行 appendEvent 调用写入（COMPACTION_EVENT_NAME 常量独立行，行级正则不可达）",
  },
];

/** 假阳性排除（事件 × 文件精确对）：命中形态但非该事件的派发/监听，注因后剔除并入备注。 */
const EXCLUDED_HITS: Array<{ event: string; file: string; reason: string }> = [
  {
    event: "done",
    file: "packages/agent-core/src/subagent/mirror.ts",
    reason: 'stage:"done" 为 subagent.progress 载荷阶段值（this.emit 对象键），非协议 done 事件',
  },
  {
    event: "permission.requested",
    file: "packages/agent-core/src/ports.ts",
    reason: "端口接口类型声明行（name: 联合类型），非派发",
  },
  {
    event: "permission.resolved",
    file: "packages/agent-core/src/ports.ts",
    reason: "端口接口类型声明行（name: 联合类型），非派发",
  },
  {
    event: "permission.requested",
    file: "packages/permission/src/types.ts",
    reason: "端口类型声明行（name: 联合类型），非派发",
  },
  {
    event: "permission.resolved",
    file: "packages/permission/src/types.ts",
    reason: "端口类型声明行（name: 联合类型），非派发",
  },
];

/**
 * 守卫豁免登记：事件域前缀内、但语义非事件的点分字面量（首跑 2026-10-05 逐一核实）。
 * 新事件漏登记仍会被守卫拦截；本表只收「长得像事件但确定不是」的字面量，逐条注因。
 */
const NON_EVENT_LITERALS: Array<[string, string]> = [
  ["mcp.json", "MCP 配置文件名（02 §3），非事件"],
  ["mcp.transport.http", "system.ping 能力声明键（V1_CAPABILITIES），非事件"],
  ["message.completed.stop", "TurnTrigger 状态机迁移触发名（02 §1.2.1），非事件"],
  ["message.completed.tool_calls", "TurnTrigger 状态机迁移触发名（02 §1.2.1），非事件"],
  ["permission.respond.answer", "system.ping 能力声明键（V1_CAPABILITIES），非事件"],
  ["plugin.json", "插件清单文件名（06 §2.10），非事件"],
  ["session.attachments", "system.ping 能力声明键（V1_CAPABILITIES），非事件"],
  ["turn.cancelled", "TurnTrigger 状态机迁移触发名（02 §1.2.1），非事件"],
];

/** 静态备注：扫描结论之外的既知事实（登记式，随登记表维护）。 */
const STATIC_NOTES: Record<string, string> = {
  "session.snapshot":
    "派发点为空是既知事实：06 §3.2 响应投影——端层经 session.resume 响应携带快照本地重建（buildSessionSnapshotEvent 构造函数预留，零调用方）",
  done: "单词事件名（无域前缀）：llm 流结束与 turn 收束共用 done 字面量，矩阵只认 emit/case/注册键形态命中",
  error: "单词事件名（无域前缀）：UI 组件与 rpc 帧的同名状态字面量已登记排除（EXCLUDED_PREFIXES）",
};

// ---------------------------------------------------------------------------
// 源码发现与行扫描
// ---------------------------------------------------------------------------

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 递归收集 .ts/.tsx 文件（跳过 test 目录与 .d.ts），返回仓库相对正斜杠路径。 */
function collectSourceFiles(absDir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    const abs = join(absDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "test" || entry.name === "node_modules") continue;
      out.push(...collectSourceFiles(abs));
    } else if ((entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) && !entry.name.endsWith(".d.ts")) {
      out.push(abs);
    }
  }
  return out;
}

function scanFiles(): Array<{ rel: string; lines: string[] }> {
  const files: Array<{ rel: string; lines: string[] }> = [];
  for (const scope of ["packages", "apps"]) {
    for (const entry of readdirSync(join(rootDir, scope), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const srcDir = join(rootDir, scope, entry.name, "src");
      if (statSync(join(rootDir, scope, entry.name)).isDirectory() === false) continue;
      try {
        for (const abs of collectSourceFiles(srcDir)) {
          files.push({ rel: relative(rootDir, abs).split("\\").join("/"), lines: readFileSync(abs, "utf8").split("\n") });
        }
      } catch {
        // 无 src 目录的包跳过
      }
    }
  }
  return files.sort((a, b) => a.rel.localeCompare(b.rel));
}

const isCommentLine = (line: string): boolean => {
  const trimmed = line.trimStart();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
};

const isExcluded = (rel: string): boolean => EXCLUDED_PREFIXES.some(([prefix]) => rel.startsWith(prefix));

// ---------------------------------------------------------------------------
// 事件全集与命中分类
// ---------------------------------------------------------------------------

interface EventRow {
  name: string;
  level: "协议（RPC 数据面）" | "存储级（仅落盘）" | "双栖（协议 + 存储头行）";
  declaredIn: string;
  dispatchers: string[];
  listeners: string[];
  note: string;
}

interface RegistryEntry {
  name: string;
  /** 扫描令牌：字面量（双引号内出现即算命中）与常量标识符（词边界命中）。 */
  literal: string;
  constant: string | null;
  level: EventRow["level"];
  declaredIn: string;
  staticNote: string;
}

function buildRegistry(): RegistryEntry[] {
  const entries: RegistryEntry[] = [];
  for (const name of Object.keys(EVENT_SCHEMAS)) {
    const storage = STORAGE_EVENTS.find((e) => e.name === name);
    entries.push({
      name,
      literal: name,
      constant: storage?.constant ?? null,
      level: storage ? "双栖（协议 + 存储头行）" : "协议（RPC 数据面）",
      declaredIn: "packages/shared/src/index.ts",
      staticNote: storage?.note ?? STATIC_NOTES[name] ?? "",
    });
  }
  for (const storage of STORAGE_EVENTS) {
    if (entries.some((e) => e.name === storage.name)) continue;
    entries.push({
      name: storage.name,
      literal: storage.name,
      constant: storage.constant,
      level: "存储级（仅落盘）",
      declaredIn: storage.declaredIn,
      staticNote: storage.note,
    });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

/** 行是否命中事件令牌：字面量子串命中（含引号形态），或常量标识符词边界命中。 */
function lineHits(line: string, entry: RegistryEntry): boolean {
  if (line.includes(`"${entry.literal}"`)) return true;
  if (entry.constant !== null && new RegExp(`\\b${entry.constant}\\b`).test(line)) return true;
  return false;
}

const EMIT_CALL_RE = /\b(emitPersisted|emitAudit|publishTransient|publish|appendEvent|emit)\s*\(/;
const EMIT_NAME_KEY_RE = /\bname:\s*"/;
const LISTEN_CASE_RE = /case\s+"/;
const LISTEN_ONEVENT_RE = /\bonEvent\s*\(\s*"/;
const LISTEN_NAME_CMP_RE = /\bname\s*===\s*"/;
const LISTEN_ARRAY_KEY_RE = /^\s*"[a-z0-9_.]+",?\s*(?:\/\/.*)?$/;
const LISTEN_REPLAY_RE = /===\s*[A-Z][A-Z0-9_]*\b/;

/** 单文件分类：返回该文件对事件的（派发?, 监听?）判定。 */
function classifyFile(rel: string, lines: string[], entry: RegistryEntry): { dispatch: boolean; listen: boolean } {
  let dispatch = false;
  let listen = false;
  for (const line of lines) {
    if (!lineHits(line, entry) || isCommentLine(line)) continue;
    const emitShaped = EMIT_CALL_RE.test(line) || (EMIT_NAME_KEY_RE.test(line) && line.includes(`"${entry.literal}"`));
    if (emitShaped) {
      dispatch = true;
      continue;
    }
    if (rel.startsWith("apps/")) {
      if (LISTEN_CASE_RE.test(line) || LISTEN_ONEVENT_RE.test(line) || LISTEN_NAME_CMP_RE.test(line) || LISTEN_ARRAY_KEY_RE.test(line)) {
        listen = true;
      }
    } else if (entry.constant !== null && LISTEN_REPLAY_RE.test(line)) {
      listen = true; // packages 层重放/应用（jsonl-resume === 常量形态）
    }
  }
  return { dispatch, listen };
}

function buildRows(files: Array<{ rel: string; lines: string[] }>): EventRow[] {
  const rows: EventRow[] = [];
  for (const entry of buildRegistry()) {
    const dispatchers = new Set<string>();
    const listeners = new Set<string>();
    const excludedNotes: string[] = [];
    for (const file of files) {
      if (isExcluded(file.rel)) continue;
      const { dispatch, listen } = classifyFile(file.rel, file.lines, entry);
      const hit = EXCLUDED_HITS.find((h) => h.event === entry.name && h.file === file.rel);
      if (hit !== undefined) {
        // 假阳性：命中形态但非该事件语义——剔除并留痕备注（可审计）
        if (dispatch || listen) excludedNotes.push(`${file.rel}（${hit.reason}）`);
        continue;
      }
      if (dispatch) dispatchers.add(file.rel);
      if (listen) listeners.add(file.rel);
    }
    for (const override of OVERRIDES.filter((o) => o.event === entry.name)) {
      dispatchers.add(override.file);
    }
    const notes = [
      entry.staticNote,
      ...OVERRIDES.filter((o) => o.event === entry.name).map((o) => o.note),
      ...(excludedNotes.length > 0 ? [`已剔除假阳性：${excludedNotes.join("；")}`] : []),
    ]
      .filter((n) => n.length > 0)
      .join("；");
    rows.push({
      name: entry.name,
      level: entry.level,
      declaredIn: entry.declaredIn,
      dispatchers: [...dispatchers].sort(),
      listeners: [...listeners].sort(),
      note: notes,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 防漏登记守卫
// ---------------------------------------------------------------------------

const LITERAL_RE = /"([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)"/g;

/** 守卫：事件域前缀的点分字面量必须登记（协议 ∪ 存储），方法名除外——新事件漏登记即门禁红。 */
function enforceRegistration(files: Array<{ rel: string; lines: string[] }>): void {
  const domains = new Set(
    Object.keys(EVENT_SCHEMAS)
      .filter((name) => name.includes("."))
      .map((name) => name.split(".")[0]!),
  );
  const known = new Set([
    ...Object.keys(EVENT_SCHEMAS),
    ...Object.keys(METHOD_SCHEMAS),
    ...STORAGE_EVENTS.map((e) => e.name),
    ...NON_EVENT_LITERALS.map(([literal]) => literal),
  ]);
  const unknown = new Map<string, string[]>();
  for (const file of files) {
    for (const [index, line] of file.lines.entries()) {
      if (isCommentLine(line)) continue;
      for (const match of line.matchAll(LITERAL_RE)) {
        const literal = match[1]!;
        if (!domains.has(literal.split(".")[0]!) || known.has(literal)) continue;
        const list = unknown.get(literal) ?? [];
        if (list.length < 3) list.push(`${file.rel}:${index + 1}`);
        unknown.set(literal, list);
      }
    }
  }
  if (unknown.size > 0) {
    console.error("[event-matrix] 发现未登记的事件形态字面量——请登记 EVENT_SCHEMAS / STORAGE_EVENTS，或扩展域前缀白名单：");
    for (const [literal, sites] of [...unknown].sort(([a], [b]) => a.localeCompare(b))) {
      console.error(`  "${literal}" @ ${sites.join(", ")}`);
    }
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

const esc = (text: string): string => text.replace(/\|/g, "\\|");
const renderCell = (files: string[]): string => (files.length === 0 ? "—（无）" : files.map(esc).join("、"));

function generateMatrix(rows: EventRow[]): string {
  const protocolCount = rows.filter((r) => r.level.startsWith("协议")).length;
  const dualCount = rows.filter((r) => r.level.startsWith("双栖")).length;
  const storageCount = rows.filter((r) => r.level.startsWith("存储")).length;
  const lines: string[] = [
    "# RainCode 事件生产者/消费者矩阵（生成式）",
    "",
    "> **本文件由 `scripts/gen-event-matrix.mts` 生成（T5.5 可观测性，扩展 T4.3 gen 管线），不要手改。**",
    "> 手改会被 `pnpm event-matrix:check`（CI 门禁 6）逐字节比对拒绝；事件面演进后运行 `pnpm event-matrix:gen` 再生成并随代码提交。",
    ">",
    "> **职责边界**：本生成物 = 源码扫描（packages/<pkg>/src + apps/<app>/src，跳过 test）的机械投影，只承载",
    "> 「事件在哪声明、谁派发、谁监听」；事件语义、payload 字段、投递时序仍以 docs/06-api-spec.md §3",
    "> 与 docs/02-module-design.md 手写章节为唯一权威。协议事件 payload 字段见协议目录",
    ">（docs/generated/protocol-catalog.md §2）。",
    "",
    "## 概览",
    "",
    `- 事件全集 **${rows.length}**：协议（RPC 数据面）${protocolCount} · 双栖（协议 + 存储头行）${dualCount} · 存储级（仅落盘事件流）${storageCount}`,
    "- 派发点为空的事件（如 `session.snapshot`）是扫描事实，语义解释见行内备注——正是本矩阵要暴露的面。",
    "",
    "## 分类规则与登记表",
    "",
    "- **扫描范围**：`packages/<pkg>/src` + `apps/<app>/src` 的 .ts/.tsx（跳过 test 与注释行）；命中令牌 = 事件字面量或存储事件常量标识符。",
    "- **派发形态**：`emitPersisted(` / `emitAudit(` / `publish(` / `appendEvent(` / `emit(` 调用行，或对象键 `name: \"x.y\"`（subagent-runtime 先例）。",
    "- **监听形态**：apps 层 `case \"x.y\":` / `onEvent(\"x.y\"` / 注册数组独立键行（store/state 先例）；packages 层 `=== 常量`（jsonl-resume 重放先例）。",
    "- **排除登记**（命中但非事件语义）：",
    ...EXCLUDED_PREFIXES.map(([prefix, reason]) => `  - \`${prefix}**\` —— ${reason}；`),
    "- **覆盖登记**（正则不可达的派发点显式补录）：",
    ...(OVERRIDES.length === 0 ? ["  - （无）"] : OVERRIDES.map((o) => `  - ${o.event} ← \`${o.file}\`（${o.note}）；`)),
    "- **防漏登记守卫**：源码中事件域前缀（session/message/tool_call/permission/turn/compact/subagent/mcp/plugin/hook）",
    "  的点分小写字面量，凡不在 EVENT_SCHEMAS ∪ STORAGE_EVENTS ∪ METHOD_SCHEMAS 即生成器报错退出 1。",
    "",
    "## 矩阵",
    "",
    "| 事件 | 级别 | 声明于 | 派发点 | 监听点 | 备注 |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of rows) {
    lines.push(
      `| \`${esc(row.name)}\` | ${esc(row.level)} | \`${esc(row.declaredIn)}\` | ${renderCell(row.dispatchers)} | ${renderCell(row.listeners)} | ${esc(row.note)} |`,
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------

const outPath = join(rootDir, "docs", "generated", "event-matrix.md");
const files = scanFiles();
enforceRegistration(files);
const rows = buildRows(files);
const next = generateMatrix(rows);

if (process.argv.includes("--check")) {
  const { readFile } = await import("node:fs/promises");
  const current = await readFile(outPath, "utf8").catch(() => null);
  if (current === null) {
    console.error(`[event-matrix:check] ${outPath} 不存在——先运行 pnpm event-matrix:gen`);
    process.exit(1);
  }
  if (current !== next) {
    const disk = current.split("\n");
    const want = next.split("\n");
    console.error("[event-matrix:check] 生成物与源码扫描不一致（手改或事件面演进后未再生成）——运行 pnpm event-matrix:gen");
    for (let index = 0; index < Math.max(disk.length, want.length); index += 1) {
      if (disk[index] !== want[index]) {
        console.error(`  首个差异 @ 行 ${index + 1}`);
        console.error(`    磁盘: ${disk[index] ?? "<EOF>"}`);
        console.error(`    期望: ${want[index] ?? "<EOF>"}`);
        break;
      }
    }
    process.exit(1);
  }
  console.log(`[event-matrix:check] 一致：${rows.length} 事件（协议 ${Object.keys(EVENT_SCHEMAS).length} + 存储级 ${STORAGE_EVENTS.length - 1}）`);
} else {
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, next, "utf8");
  console.log(`[event-matrix:gen] 已生成 docs/generated/event-matrix.md（${rows.length} 事件）`);
}
