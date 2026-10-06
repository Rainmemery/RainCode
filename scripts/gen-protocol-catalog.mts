/**
 * T4.3 生成式协议目录 + 防漂移门禁（07-dev-plan §10.2）。
 * 运行：tsx scripts/gen-protocol-catalog.mts（或 pnpm protocol:gen / pnpm protocol:check）
 *
 * 从 packages/shared 的 METHOD_SCHEMAS / EVENT_SCHEMAS 注册表与五个 *_ERROR_CODES 常量
 * 生成 docs/generated/protocol-catalog.md（方法表 / 事件表 / 错误码族）。双模式：
 *   gen（缺省）：再生成——协议演进后一键更新，产物随代码提交；
 *   --check：内存再生成与磁盘逐字节比对，不一致即退出码 1（CI 门禁 6，防手改/防漂移）。
 *
 * 职责边界（写入生成物文档头）：生成物 = schema 注册表的机械投影，只承载「字段/类型/必填/约束」；
 * 语义、行为、时序、业务码含义仍以 docs/06-api-spec.md 手写章节为唯一权威。
 * 输出确定性：域与方法、事件均排序，无时间戳——同注册表必得同字节输出，--check 才可判漂移。
 *
 * zod 内省口径（zod 3）：_def.typeName 分派渲染；对象字段经 shape 展开、深度 ≥3 折叠为 object；
 * 约束取 checks（int/min/max/regex/url/email）与 describe() 描述；ZodDefault 读 defaultValue 注记默认值。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EVENT_SCHEMAS,
  MEMORY_ERROR_CODES,
  METHOD_SCHEMAS,
  PC_ERROR_CODES,
  MARKETPLACE_ERROR_CODES,
  PLUGIN_ERROR_CODES,
  SYSTEM_ERROR_CODES,
  TOOL_ERROR_CODES,
} from "../packages/shared/src/index.ts";

/** zod 3 内省所需的最小结构面（不直接依赖 zod 类型，scripts 不引 zod 包）。 */
interface SchemaLike {
  _def: { typeName: string; [key: string]: unknown };
  shape?: Record<string, SchemaLike>;
  isOptional?: () => boolean;
  description?: string;
}
const asSchema = (schema: unknown): SchemaLike => schema as SchemaLike;
const innerOf = (schema: SchemaLike): SchemaLike | null => {
  const raw = schema._def.innerType ?? schema._def.schema;
  return raw != null ? asSchema(raw) : null;
};

/** 渲染类型表达式（cell 内的 | 由 esc 统一转义）。深度 ≥3 的对象折叠，防嵌套爆炸。 */
function renderType(schema: SchemaLike, depth: number): string {
  const def = schema._def;
  const inner = (key: "innerType" | "type" | "schema"): SchemaLike => asSchema(def[key]);
  switch (def.typeName) {
    case "ZodString":
      return "string";
    case "ZodNumber":
      return (def.checks as Array<{ kind: string }>)?.some((c) => c.kind === "int") ? "int" : "number";
    case "ZodBoolean":
      return "boolean";
    case "ZodNull":
      return "null";
    case "ZodUnknown":
      return "unknown";
    case "ZodAny":
      return "any";
    case "ZodLiteral":
      return JSON.stringify(def.value);
    case "ZodEnum":
      return (def.values as string[]).map((v) => JSON.stringify(v)).join(" | ");
    case "ZodArray":
      return `${renderType(inner("type"), depth + 1)}[]`;
    case "ZodOptional":
      return `${renderType(inner("innerType"), depth)}?`;
    case "ZodNullable":
      return `${renderType(inner("innerType"), depth)} | null`;
    case "ZodDefault":
    case "ZodEffects":
    case "ZodCatch":
      return renderType(inner("innerType") ?? inner("schema"), depth);
    case "ZodObject": {
      if (depth >= 3) return "object";
      const fields = Object.entries(schema.shape ?? {}).map(
        ([key, value]) => `${key}: ${renderType(value, depth + 1)}`,
      );
      return `{ ${fields.join(", ")} }`;
    }
    case "ZodDiscriminatedUnion":
    case "ZodUnion":
      return (def.options as SchemaLike[]).map((option) => renderType(option, depth + 1)).join(" | ");
    case "ZodRecord":
      return `Record<string, ${renderType(inner("valueType"), depth + 1)}>`;
    default:
      return def.typeName;
  }
}

/** 约束/说明列：description 优先，其后 checks 与默认值（沿包装层下钻）。 */
function collectNotes(schema: SchemaLike): string[] {
  const notes: string[] = [];
  if (schema.description) notes.push(schema.description);
  const def = schema._def;
  if (def.typeName === "ZodDefault") {
    try {
      const value = (def.defaultValue as () => unknown)();
      if (value !== undefined) notes.push(`默认 ${JSON.stringify(value)}`);
    } catch {
      /* defaultValue 惰性求值失败即不注记 */
    }
  }
  if (def.typeName === "ZodNumber" || def.typeName === "ZodString") {
    for (const check of (def.checks as Array<{ kind: string; value?: number }>) ?? []) {
      if (check.kind === "min") notes.push(def.typeName === "ZodString" ? `len≥${check.value}` : `≥${check.value}`);
      if (check.kind === "max") notes.push(def.typeName === "ZodString" ? `len≤${check.value}` : `≤${check.value}`);
      if (check.kind === "regex") notes.push("regex");
      if (check.kind === "url") notes.push("url");
      if (check.kind === "email") notes.push("email");
    }
  }
  const nested = innerOf(schema);
  if (nested && def.typeName !== "ZodObject" && def.typeName !== "ZodEnum") {
    notes.push(...collectNotes(nested));
  }
  return notes;
}

interface FieldRow {
  name: string;
  type: string;
  required: boolean;
  notes: string;
}

/** 顶层字段行：必填列承载 optional 语义，类型列剥掉顶层「?」防重复标注。 */
function fieldRows(schema: unknown): FieldRow[] {
  const shape = asSchema(schema).shape ?? {};
  return Object.entries(shape).map(([name, field]) => {
    const required = !(field.isOptional?.() ?? false);
    const bare = field._def.typeName === "ZodOptional" ? asSchema(field._def.innerType) : field;
    const notes = collectNotes(field).join("；");
    return { name, type: renderType(bare, 0), required, notes };
  });
}

const esc = (text: string): string => text.replace(/\|/g, "\\|");
const YES_NO = (required: boolean): string => (required ? "是" : "否");

function renderFieldTable(rows: FieldRow[]): string[] {
  if (rows.length === 0) return ["无字段（空对象）。", ""];
  const lines = [
    "| 字段 | 类型 | 必填 | 约束/说明 |",
    "| --- | --- | --- | --- |",
    ...rows.map((row) => `| \`${esc(row.name)}\` | \`${esc(row.type)}\` | ${YES_NO(row.required)} | ${esc(row.notes)} |`),
    "",
  ];
  return lines;
}

const EVENT_BASE_FIELDS = new Set(["seq", "sessionId", "ts"]);
/** 段/域标签（06 §4.3 口径）与常量实体的配对——码值经 Object.values 从实体直读（普通对象，非 schema）。 */
const ERROR_CODE_FAMILIES: Array<{ name: string; label: string; codes: Record<string, string> }> = [
  { name: "SYSTEM_ERROR_CODES", label: "段 0 系统", codes: SYSTEM_ERROR_CODES },
  { name: "PC_ERROR_CODES", label: "段 2 permission", codes: PC_ERROR_CODES },
  { name: "MEMORY_ERROR_CODES", label: "段 6 memory", codes: MEMORY_ERROR_CODES },
  { name: "TOOL_ERROR_CODES", label: "段 7 tool", codes: TOOL_ERROR_CODES },
  { name: "PLUGIN_ERROR_CODES", label: "段 10 plugins", codes: PLUGIN_ERROR_CODES },
  { name: "MARKETPLACE_ERROR_CODES", label: "段 15 marketplace", codes: MARKETPLACE_ERROR_CODES },
];

function generateCatalog(): string {
  const methods = Object.entries(METHOD_SCHEMAS).sort(([a], [b]) => a.localeCompare(b));
  const events = Object.entries(EVENT_SCHEMAS).sort(([a], [b]) => a.localeCompare(b));
  const domains = new Map<string, string[]>();
  for (const [name] of methods) {
    const domain = name.split(".")[0] ?? name;
    domains.set(domain, [...(domains.get(domain) ?? []), name]);
  }

  const lines: string[] = [
    "# RainCode 协议目录（生成式）",
    "",
    "> **本文件由 `scripts/gen-protocol-catalog.mts` 生成（T4.3 防漂移门禁），不要手改。**",
    "> 手改会被 `pnpm protocol:check`（CI 门禁 6）逐字节比对拒绝；协议演进后运行 `pnpm protocol:gen` 再生成并随代码提交。",
    ">",
    "> **职责边界**：本生成物 = `METHOD_SCHEMAS` / `EVENT_SCHEMAS`（packages/shared/src/index.ts）与 shared 五个",
    "> `*_ERROR_CODES` 常量的机械投影，只承载「有哪些字段、什么类型、是否必填、什么约束」；方法语义、",
    "> 事件投递行为、交互时序、业务错误码含义**仍以 docs/06-api-spec.md 手写章节为唯一权威**（06 §1~§4、§7）。",
    "> 两处不一致时以 schema 注册表为准修正 06 手写表，而不是反向手改本文件。",
    "",
    `## 概览`,
    "",
    `- 协议方法 **${methods.length}**（域 ${domains.size} 个：${[...domains.keys()].sort().join(" / ")}）`,
    `- 数据面事件 **${events.length}**`,
    `- 代码侧错误码族 **${ERROR_CODE_FAMILIES.length}**（session / config / mcp / subagent / skills 域为调用点字面量，见 §3 注）`,
    "",
    "## 1. 方法表",
    "",
    "按域分节（域名 = 方法首段）；每方法列出入参与出参的顶层字段。嵌套对象深度 ≥3 折叠为 `object`。",
    "",
  ];

  for (const domain of [...domains.keys()].sort()) {
    const names = (domains.get(domain) ?? []).sort();
    lines.push(`### 域 ${domain}（${names.length} 方法）`, "");
    for (const name of names) {
      const entry = methods.find(([method]) => method === name);
      if (!entry) continue;
      const schemas = entry[1];
      lines.push(`#### ${name}`, "", "入参：", ...renderFieldTable(fieldRows(schemas.request)), "出参：", ...renderFieldTable(fieldRows(schemas.response)));
    }
  }

  lines.push(
    `## 2. 事件表（${events.length} 事件）`,
    "",
    "所有事件 payload 均含信封基字段（06 §3.1 EventBase）：`seq`（会话内单调递增，从 1 起）·",
    "`sessionId`（全局事件缺省）· `ts`（epoch ms）——下表只列各事件特有字段。",
    "",
  );
  for (const [name, payload] of events) {
    const rows = fieldRows(payload).filter((row) => !EVENT_BASE_FIELDS.has(row.name));
    lines.push(`#### ${name}`, "", ...renderFieldTable(rows));
  }

  lines.push(
    "## 3. 错误码族（代码侧常量）",
    "",
    "| 常量 | 段/域 | 码 |",
    "| --- | --- | --- |",
    ...[...ERROR_CODE_FAMILIES]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((family) => {
        const values = Object.values(family.codes).sort();
        return `| \`${family.name}\` | ${family.label} | ${values.map((code) => `\`${code}\``).join("、")} |`;
      }),
    "",
    "> session / config / mcp / subagent / skills 域业务码为调用点字面量（无代码侧常量单源），",
    "> 完整业务表以 06 §4.3 手写章节为权威；错误对象结构 `RpcError{code,message,details?}` 见 06 §1.2/§4.1。",
    "",
  );
  return `${lines.join("\n")}\n`;
}

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const outPath = join(rootDir, "docs", "generated", "protocol-catalog.md");
const next = generateCatalog();
const methodCount = Object.keys(METHOD_SCHEMAS).length;
const eventCount = Object.keys(EVENT_SCHEMAS).length;

if (process.argv.includes("--check")) {
  const current = await readFile(outPath, "utf8").catch(() => null);
  if (current === null) {
    console.error(`[protocol:check] ${outPath} 不存在——先运行 pnpm protocol:gen`);
    process.exit(1);
  }
  if (current !== next) {
    const disk = current.split("\n");
    const want = next.split("\n");
    console.error("[protocol:check] 生成物与 schema 注册表不一致（手改或协议演进后未再生成）——运行 pnpm protocol:gen");
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
  console.log(`[protocol:check] 一致：${methodCount} 方法 / ${eventCount} 事件`);
} else {
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, next, "utf8");
  console.log(`[protocol:gen] 已生成 docs/generated/protocol-catalog.md（${methodCount} 方法 / ${eventCount} 事件）`);
}
