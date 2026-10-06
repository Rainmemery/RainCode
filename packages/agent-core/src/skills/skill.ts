/**
 * 技能包（T3.4，M3）：可复用工作流的提示词模板，经 `/name arguments` 斜杠命令调用。
 *
 * 位置约定 `<workspace>/.raincode/skills/<name>.md` 或全局 `<dataRoot>/skills/<name>.md`
 * （双源解析镜像 02 §4.3 profile 口径：workspace 层优先，先命中者生效）；
 * 格式 markdown + frontmatter（共用包内 frontmatter 解析），正文 = 提示词模板。
 *
 * frontmatter 字段：name（可省，缺省文件名；[a-z0-9-]+）、description（必填，命令面板展示）、
 * argumentHint（可选，参数形状提示）。正文占位符 `$ARGUMENTS` 替换为调用参数；
 * 无占位符且提供了参数 → 参数以独立行追加到模板末尾（两种书写风格都可参数化）。
 *
 * 解析失败语义与 profile 不同：目录扫描（清单）跳过非法文件不阻塞其他技能（低频控制面，
 * 一个坏文件不应拖垮整层面板）；按名调用（resolveSkillFile）fail-fast 抛域码。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatterFields, splitFrontmatter } from "../frontmatter.js";
import { errorMessage } from "../turn/round-helpers.js";

/** 技能结构（frontmatter 投影 + 模板正文）。 */
export interface Skill {
  /** 唯一标识，[a-z0-9-]+（即斜杠命令名）。 */
  name: string;
  /** 模型/面板可见：该技能做什么。 */
  description: string;
  /** 参数形状提示（如 "<file>"；缺省无参技能）。 */
  argumentHint?: string;
  /** 模型侧可调用开关（T4.4；缺省 true）——false 时模型经 skill 工具调用被拒，斜杠命令不受限。 */
  modelInvocable: boolean;
  /** 提示词模板正文（$ARGUMENTS 占位符在展开时替换）。 */
  template: string;
}

/** 带来源的技能（目录解析产出；skills.list 投影时剥离 template，协议面不含大文本）。 */
export type SkillWithSource = Skill & { source: "workspace" | "global" | "plugin" };

export const SKILL_NAME_PATTERN = /^[a-z0-9-]+$/;

export type SkillErrorCode = "SKILL_INVALID" | "SKILL_NOT_FOUND";

/** 技能解析/文件解析失败（错误码对齐 06-api-spec §4.3 域码段）。 */
export class SkillError extends Error {
  constructor(
    public readonly code: SkillErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SkillError";
  }
}

/** 技能目录候选（按序解析，先命中者生效；T6.1 v1.14 增补 plugin 源——marketplace 安装插件随附技能，优先级 workspace > global > plugin）。 */
export interface SkillDir {
  path: string;
  source: "workspace" | "global" | "plugin";
}

/**
 * 按序在候选目录中查找 `<name>.md` 并解析。全未命中抛 SKILL_NOT_FOUND；
 * 首个命中者解析失败即抛 SKILL_INVALID（不回落后续目录——坏文件不可被静默降级）。
 * node:fs 同步 API：调用路径低频（斜杠命令受理），同 profile 口径。
 */
export function resolveSkillFile(
  dirs: readonly SkillDir[],
  name: string,
): { skill: SkillWithSource } {
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new SkillError("SKILL_NOT_FOUND", `技能名 "${name}" 非法（须满足 [a-z0-9-]+）`);
  }
  for (const dir of dirs) {
    const file = join(dir.path, `${name}.md`);
    if (!existsSync(file)) continue;
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (reason: unknown) {
      throw new SkillError("SKILL_NOT_FOUND", `技能文件读取失败：${file}（${errorMessage(reason)}）`);
    }
    return { skill: { ...parseSkillMarkdown(raw, name), source: dir.source } };
  }
  throw new SkillError("SKILL_NOT_FOUND", `技能 "${name}" 在候选目录中均未找到`);
}

/**
 * frontmatter + 正文解析（正文即提示词模板）。
 * 校验失败（name 非法、description 缺失）抛 INVALID；无 frontmatter 一律 INVALID
 * （description 无处可取——无描述的技能无法在命令面板判别用途）；frontmatter 无 name 键时用 fallbackName。
 */
export function parseSkillMarkdown(raw: string, fallbackName: string): Skill {
  const { frontmatter, body } = splitFrontmatter(raw);
  if (frontmatter === null) {
    throw new SkillError("SKILL_INVALID", `技能 "${fallbackName}" 缺少 frontmatter（--- 围栏），description 无法解析`);
  }
  const fields = parseFrontmatterFields(frontmatter);
  const name = fields.name !== undefined && fields.name.length > 0 ? fields.name : fallbackName;
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new SkillError("SKILL_INVALID", `技能 name "${name}" 不满足 [a-z0-9-]+`);
  }
  const description = fields.description;
  if (description === undefined || description.length === 0) {
    throw new SkillError("SKILL_INVALID", `技能 "${name}" 缺少 description`);
  }
  const modelInvocable = parseModelInvocable(fields.modelInvocable, name);
  return {
    name,
    description,
    ...(fields.argumentHint !== undefined && fields.argumentHint.length > 0 && { argumentHint: fields.argumentHint }),
    modelInvocable,
    template: body.trim(),
  };
}

/** modelInvocable 开关解析（T4.4）：缺省/空 = true；仅接受 "true"/"false"，其余值 INVALID。 */
function parseModelInvocable(raw: string | undefined, name: string): boolean {
  if (raw === undefined || raw.length === 0) return true;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new SkillError("SKILL_INVALID", `技能 "${name}" frontmatter modelInvocable 非法（仅接受 true/false）: "${raw}"`);
}

/**
 * 模板展开（T3.4 展开语义）：`$ARGUMENTS` 占位符 → 调用参数；
 * 无占位符且有参数 → 参数独立行追加模板末尾；无参数 → 模板原样（trim 后）。
 */
export function expandSkillTemplate(template: string, args: string | undefined): string {
  const trimmedArgs = args?.trim() ?? "";
  if (template.includes("$ARGUMENTS")) {
    return template.replaceAll("$ARGUMENTS", trimmedArgs);
  }
  return trimmedArgs.length > 0 ? `${template}\n\n${trimmedArgs}` : template;
}
