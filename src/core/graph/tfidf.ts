/**
 * TF-IDF，针对「本次查询语料」计算。
 *
 * 为什么自己写而不用现成的库：我们需要的 IDF 是**这一批资料内部**的区分度，
 * 不是通用语料库的 IDF。比如「露营」在通用词典里是个普通低频词，但在一次
 * 露营主题的调研里它出现在每篇文档中 —— IDF 应该把它压到接近 0，因为
 * 它对区分簇毫无贡献。用通用 IDF 会反过来把它顶到权重榜首。
 *
 * 约 60 行，且完全可控，比引一个库再想办法覆盖它的词典划算。
 */

import type { Token } from "./tokenize";

export interface TfidfDoc {
  /** 文档 id（与 Document.id 对齐）。 */
  id: string;
  tokens: Token[];
}

export interface TfidfResult {
  /** word → 聚合权重（该词在所有文档上的 tf-idf 之和），用于节点大小。 */
  weight: Map<string, number>;
  /** word → 该词出现在哪些文档、在该文档的 tf-idf。 */
  postings: Map<string, Map<string, number>>;
  /** word → 文档频率（出现在几篇文档里）。 */
  df: Map<string, number>;
  /** documentFrequency 分母，即文档总数。 */
  docCount: number;
}

/**
 * 计算 TF-IDF。
 *
 * tf 用对数饱和：一篇 5 万字的文章里「帐篷」出现 200 次，不该比出现 20 次的
 * 文档权重高 10 倍 —— 那反映的是篇幅，不是重要性。
 *
 * idf 用平滑形式 log((1+N)/(1+df)) + 1：加 1 保证 df=N 的词（每篇都出现的
 * 主题词）权重不为 0，它们仍能作为图的连接中心存在，只是不再主导排序。
 */
export function computeTfidf(docs: TfidfDoc[]): TfidfResult {
  const weight = new Map<string, number>();
  const postings = new Map<string, Map<string, number>>();
  const df = new Map<string, number>();
  const docCount = docs.length;

  // ── 第一遍：统计每篇的词频 ──
  const perDoc = new Map<string, Map<string, number>>();
  for (const doc of docs) {
    const counts = new Map<string, number>();
    for (const t of doc.tokens) {
      counts.set(t.word, (counts.get(t.word) ?? 0) + 1);
    }
    perDoc.set(doc.id, counts);
    for (const word of counts.keys()) {
      df.set(word, (df.get(word) ?? 0) + 1);
    }
  }

  // ── 第二遍：算 tf-idf ──
  for (const doc of docs) {
    const counts = perDoc.get(doc.id);
    if (!counts) continue;

    const total = doc.tokens.length || 1;

    for (const [word, rawCount] of counts) {
      const tf = 1 + Math.log(rawCount) / Math.log(1 + total);
      const docFreq = df.get(word) ?? 1;
      const idf = Math.log((1 + docCount) / (1 + docFreq)) + 1;
      const score = tf * idf;

      weight.set(word, (weight.get(word) ?? 0) + score);

      let posting = postings.get(word);
      if (!posting) {
        posting = new Map();
        postings.set(word, posting);
      }
      posting.set(doc.id, score);
    }
  }

  return { weight, postings, df, docCount };
}

/**
 * 挑出前 N 个关键词。
 *
 * 门槛用「至少出现在 2 篇文档」而不是纯按权重取 topN：只在一篇文档里出现
 * 的词（通常是错别字、人名、一次性术语）权重可能很高，但它们连不成图 ——
 * 一个只连接单篇文档的孤立节点对理解主题毫无帮助。
 *
 * 唯一的例外是语料本身只有一两篇文档时，这个门槛会把图清空，所以那时放宽。
 */
export function selectKeywords(
  tfidf: TfidfResult,
  opts: { max?: number; minDf?: number } = {},
): string[] {
  const max = opts.max ?? 60;
  const minDf = opts.minDf ?? (tfidf.docCount >= 5 ? 2 : 1);

  const candidates = [...tfidf.weight.entries()]
    .filter(([word]) => (tfidf.df.get(word) ?? 0) >= minDf)
    .sort((a, b) => b[1] - a[1]);

  return candidates.slice(0, max).map(([word]) => word);
}
