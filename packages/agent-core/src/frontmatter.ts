/**
 * markdown frontmatter 手写解析（agent-core 包内共用）：
 * 子代理 profile（subagent/profile.ts）与技能包（skills/skill.ts）同构的 `---` 围栏键值行格式。
 * 刻意不引入 yaml 依赖（低频解析路径、字段集固定，02 §4.3 同口径）。
 */

/** `---` 围栏切分：frontmatter 为 null 表示无有效围栏；正文为闭合围栏之后的 markdown。 */
export function splitFrontmatter(raw: string): { frontmatter: string | null; body: string } {
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
export function parseFrontmatterFields(frontmatter: string): Record<string, string> {
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

/** 去除成对包裹引号（手写 frontmatter 的常见书写形式）。 */
export function unquote(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}
