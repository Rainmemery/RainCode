/**
 * 检索命中分段（polish-ui-states-and-runtime 轮 C2；双端同构纯函数）：
 * 大小写不敏感地切出 query 的全部非重叠命中片段，调用方按 `hit` 着 `--accent-bg` 强调底色。
 * 安全约束：仅用 `indexOf` 扫描（绝不以用户输入构造 `RegExp`）——特殊字符（.*+?[] 等）零语义、无 ReDoS。
 */

export interface HighlightSegment {
  text: string;
  hit: boolean;
}

/**
 * 大小写不敏感全命中分段：空 / 纯空白 query → 单段非命中（原样返回）；
 * 命中段自原文切片（大小写与顺序原样保留）；无命中亦回落单段非命中。
 */
export function splitHighlight(text: string, query: string): HighlightSegment[] {
  const needle = query.trim();
  if (needle === "") return [{ text, hit: false }];
  const haystack = text.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  const segments: HighlightSegment[] = [];
  let cursor = 0;
  for (;;) {
    const index = haystack.indexOf(lowerNeedle, cursor);
    if (index === -1) break;
    if (index > cursor) segments.push({ text: text.slice(cursor, index), hit: false });
    segments.push({ text: text.slice(index, index + needle.length), hit: true });
    cursor = index + needle.length; // 非重叠推进（"aaaa" + "aa" → 两段命中）
  }
  if (segments.length === 0) return [{ text, hit: false }];
  if (cursor < text.length) segments.push({ text: text.slice(cursor), hit: false });
  return segments;
}
