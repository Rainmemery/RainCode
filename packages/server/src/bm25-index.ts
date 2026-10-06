/**
 * 内存 BM25 索引（T5.6 MCP 工具目录检索；MiMo-Code tool/mcp-tool-search 参照形态，K1=1.2）。
 *
 * 语料为目录条目（key=工具名，text=描述 + 递归参数名/描述，由调用方拼装），分词器对工具
 * 目录语料特化：ASCII 段按非字母数字切分（`mcp__fs__read_file` → mcp/fs/read/file，下划线
 * 同样作为分隔符，查询词 read_file 与 read file 等价）、CJK 连续段取二元 bigram（单字保留）。
 * 检索输出相对分数地板（top×0.15，T5.3 检索同纪律——BM25 绝对阈值随语料尺寸漂移不可用），
 * 由调用方再按 limit 截断。索引体积 = 目录条目数（百级），O(词数×条目×长度) 直接打分足够。
 */

/** BM25 k1（词频饱和常数；MiMo 参照值 1.2）。 */
const K1 = 1.2;
/** BM25 b（文档长度归一化常数，标准值 0.75）。 */
const B = 0.75;

/** 目录分词：CJK bigram + ASCII 词（下划线/非字母数字均为分隔符），小写归一。 */
export function tokenizeCatalogText(text: string): string[] {
  const tokens: string[] = [];
  for (const run of text.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i += 1) tokens.push(run.slice(i, i + 2));
  }
  for (const word of text.replace(/[\u4e00-\u9fff]+/g, " ").toLowerCase().split(/[^a-z0-9]+/)) {
    if (word.length > 0) tokens.push(word);
  }
  return tokens;
}

export interface Bm25Doc {
  /** 唯一键（检索结果按 key 返回）。 */
  key: string;
  /** 原始语料文本（名称 + 描述 + 参数名/描述拼装）。 */
  text: string;
}

export interface Bm25Index {
  readonly docs: ReadonlyArray<{ key: string; tokens: string[] }>;
  readonly idf: ReadonlyMap<string, number>;
  readonly avgdl: number;
}

export function buildBm25Index(docs: ReadonlyArray<Bm25Doc>): Bm25Index {
  const docTokens = docs.map((doc) => ({ key: doc.key, tokens: tokenizeCatalogText(doc.text) }));
  const df = new Map<string, number>();
  for (const doc of docTokens) {
    for (const term of new Set(doc.tokens)) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const n = docTokens.length;
  const avgdl = n === 0 ? 0 : docTokens.reduce((sum, doc) => sum + doc.tokens.length, 0) / n;
  const idf = new Map<string, number>();
  for (const [term, count] of df) {
    // BM25+ 变体（log 内 +1）：避免高频词出现负 idf
    idf.set(term, Math.log(1 + (n - count + 0.5) / (count + 0.5)));
  }
  return { docs: docTokens, idf, avgdl };
}

/** 查询打分：BM25 权重求和 + 相对分数地板（top×floorRatio），降序返回前 limit 条。 */
export function searchBm25(
  index: Bm25Index,
  query: string,
  limit: number,
  floorRatio = 0.15,
): Array<{ key: string; score: number }> {
  const terms = tokenizeCatalogText(query);
  if (terms.length === 0 || index.docs.length === 0 || index.avgdl === 0) return [];
  const scores = new Map<string, number>();
  for (const term of terms) {
    const termIdf = index.idf.get(term);
    if (termIdf === undefined) continue;
    for (const doc of index.docs) {
      let tf = 0;
      for (const token of doc.tokens) {
        if (token === term) tf += 1;
      }
      if (tf === 0) continue;
      const weight =
        (termIdf * (tf * (K1 + 1))) / (tf + K1 * (1 - B + B * (doc.tokens.length / index.avgdl)));
      scores.set(doc.key, (scores.get(doc.key) ?? 0) + weight);
    }
  }
  const ranked = [...scores.entries()]
    .map(([key, score]) => ({ key, score }))
    .sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : 1));
  const top = ranked[0]?.score ?? 0;
  return ranked.filter((hit) => hit.score >= top * floorRatio).slice(0, Math.max(0, limit));
}
