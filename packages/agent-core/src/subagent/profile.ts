/**
 * 子代理 profile（02-module-design §4.3）：
 * 位置约定 `<workspace>/.raincode/agents/<name>.md` 或全局 `~/.raincode/agents/<name>.md`；
 * 格式 markdown + frontmatter（`---` 围栏键值行），正文 = 子代理系统提示。
 *
 * 解析刻意手写、不引入 yaml 依赖（spawn 路径低频、字段集固定：name/description/tools/model/maxTurns）；
 * 校验失败 fail-fast（02 §4.4：spawn 前校验失败即报错回模型，不创建会话）。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { errorMessage } from "../turn/round-helpers.js";

/** profile 结构（02 §4.3；maxTurns 解析后必填，默认 20、硬上限 100）。 */
export interface SubagentProfile {
  /** 唯一标识，[a-z0-9-]+。 */
  name: string;
  /** 模型可见：何时派发给该子代理。 */
  description: string;
  /** 工具白名单；缺省继承主会话全集（白名单投影见 registry-projection.ts）。 */
  tools?: string[];
  /** 覆盖主会话模型；缺省同主模型。 */
  model?: string;
  /** turn 内模型轮次上限（默认 20，硬上限 100）。 */
  maxTurns: number;
  /** markdown 正文 = 子代理系统提示（内联 profile 形态无正文，为空串）。 */
  systemPrompt: string;
}

export const DEFAULT_SUBAGENT_MAX_TURNS = 20;
export const MAX_SUBAGENT_TURNS = 100;
export const SUBAGENT_NAME_PATTERN = /^[a-z0-9-]+$/;

export type SubagentProfileErrorCode = "SUBAGENT_PROFILE_INVALID" | "SUBAGENT_PROFILE_NOT_FOUND";

/** profile 解析/文件解析失败（错误码对齐 06-api-spec §4.3 段 5）。 */
export class SubagentProfileError extends Error {
  constructor(
    public readonly code: SubagentProfileErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SubagentProfileError";
  }
}

/** profile 目录候选（按序解析，先命中者生效；source 用于 subagent.profiles.list 投影）。 */
export interface SubagentProfileDir {
  path: string;
  source: "workspace" | "global";
}

/**
 * 按序在候选目录中查找 `<name>.md` 并解析（02 §4.3：文件名即 profile 名）。
 * 全未命中抛 SUBAGENT_PROFILE_NOT_FOUND；首个命中者解析失败即抛 INVALID（不回落后续目录）。
 * 用 node:fs 同步 API——spawn 路径低频，不为此引入异步复杂度（02 §4.3）。
 */
export function resolveProfileFile(
  dirs: readonly SubagentProfileDir[],
  name: string,
): { profile: SubagentProfile; source: SubagentProfileDir["source"] } {
  // 名字先过正则：既挡非法 profile 名，也挡 `../` 等路径逃逸（02 §4.4 边界）
  if (!SUBAGENT_NAME_PATTERN.test(name)) {
    throw new SubagentProfileError("SUBAGENT_PROFILE_NOT_FOUND", `profile 名 "${name}" 非法（须满足 [a-z0-9-]+）`);
  }
  for (const dir of dirs) {
    const file = join(dir.path, `${name}.md`);
    if (!existsSync(file)) continue;
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (reason: unknown) {
      throw new SubagentProfileError(
        "SUBAGENT_PROFILE_NOT_FOUND",
        `profile 文件读取失败：${file}（${errorMessage(reason)}）`,
      );
    }
    return { profile: parseProfileMarkdown(raw, name), source: dir.source };
  }
  throw new SubagentProfileError("SUBAGENT_PROFILE_NOT_FOUND", `profile "${name}" 在候选目录中均未找到`);
}

/**
 * frontmatter + 正文解析（02 §4.3）。
 * 校验失败（name 非法、description 缺失、maxTurns 越界 1-100、tools 含空项）抛 INVALID；
 * 无 frontmatter 一律 INVALID（description 无处可取）；frontmatter 无 name 键时用 fallbackName。
 */
export function parseProfileMarkdown(raw: string, fallbackName: string): SubagentProfile {
  const { frontmatter, body } = splitFrontmatter(raw);
  if (frontmatter === null) {
    throw new SubagentProfileError(
      "SUBAGENT_PROFILE_INVALID",
      `profile "${fallbackName}" 缺少 frontmatter（--- 围栏），description 无法解析`,
    );
  }
  const fields = parseFrontmatterFields(frontmatter);
  const name = fields.name !== undefined && fields.name.length > 0 ? fields.name : fallbackName;
  if (!SUBAGENT_NAME_PATTERN.test(name)) {
    throw new SubagentProfileError("SUBAGENT_PROFILE_INVALID", `profile name "${name}" 不满足 [a-z0-9-]+`);
  }
  const description = fields.description;
  if (description === undefined || description.length === 0) {
    throw new SubagentProfileError("SUBAGENT_PROFILE_INVALID", `profile "${name}" 缺少 description`);
  }
  const tools = fields.tools !== undefined ? parseToolsField(name, fields.tools) : undefined;
  const model = fields.model !== undefined && fields.model.length > 0 ? fields.model : undefined;
  const maxTurns = parseMaxTurns(name, fields.maxTurns);
  return {
    name,
    description,
    ...(tools !== undefined && { tools }),
    ...(model !== undefined && { model }),
    maxTurns,
    systemPrompt: body.trim(),
  };
}

// ---------------------------------------------------------------------------
// 内部实现
// ---------------------------------------------------------------------------

/** `---` 围栏切分：frontmatter 为 null 表示无有效围栏；正文为闭合围栏之后的 markdown。 */
function splitFrontmatter(raw: string): { frontmatter: string | null; body: string } {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { frontmatter: null, body: normalized };
  // 闭合围栏必须是独立一行 `\n---`（后随行尾或换行），`---xxx` 不算
  let searchFrom = 4;
  for (;;) {
    const idx = normalized.indexOf("\n---", searchFrom);
    if (idx === -1) return { frontmatter: null, body: normalized };
    const after = idx + 4;
    if (after === normalized.length || normalized[after] === "\n") {
      const body = after === normalized.length ? "" : normalized.slice(after + 1);
      return { frontmatter: normalized.slice(4, idx), body };
    }
    searchFrom = idx + 1;
  }
}

/** 键值行解析（宽松：空行与 `#` 注释行、无冒号行跳过；重复键后者覆盖；值去包裹引号）。 */
function parseFrontmatterFields(frontmatter: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of frontmatter.split("\n")) {
    const text = line.trim();
    if (text.length === 0 || text.startsWith("#")) continue;
    const colon = text.indexOf(":");
    if (colon === -1) continue;
    fields[text.slice(0, colon).trim()] = unquote(text.slice(colon + 1).trim());
  }
  return fields;
}

/** tools 字段：行内数组 `[a, b]` 或逗号分隔；含空项即校验失败（02 §4.4：全空白名单视为配置错误）。 */
function parseToolsField(name: string, raw: string): string[] {
  let inner = raw.trim();
  if (inner.startsWith("[") && inner.endsWith("]")) {
    inner = inner.slice(1, -1);
  }
  const items = inner.split(",").map((item) => item.trim());
  if (items.some((item) => item.length === 0)) {
    throw new SubagentProfileError("SUBAGENT_PROFILE_INVALID", `profile "${name}" tools 白名单含空项`);
  }
  return items;
}

/** maxTurns：整数且 1..100（缺省 20；越界即校验失败，02 §4.3 硬上限 100）。 */
function parseMaxTurns(name: string, raw: string | undefined): number {
  if (raw === undefined || raw.length === 0) return DEFAULT_SUBAGENT_MAX_TURNS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || String(parsed) !== raw.trim()) {
    throw new SubagentProfileError("SUBAGENT_PROFILE_INVALID", `profile "${name}" maxTurns 必须为整数（得到 "${raw}"）`);
  }
  if (parsed < 1 || parsed > MAX_SUBAGENT_TURNS) {
    throw new SubagentProfileError(
      "SUBAGENT_PROFILE_INVALID",
      `profile "${name}" maxTurns 越界（1-${String(MAX_SUBAGENT_TURNS)}）`,
    );
  }
  return parsed;
}

/** 去除成对包裹引号（手写 frontmatter 的常见书写形式）。 */
function unquote(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}
