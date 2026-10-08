/**
 * 启发式构图：本地、零成本、离线可用。
 *
 * 管道：分词 → 实词筛选 → TF-IDF → 取关键词 → 共现建边 → Louvain 分簇。
 *
 * 产出的图有两类节点：
 *   - keyword  概念词，边权来自共现
 *   - document 资料本身，与它包含的概念相连
 * 这样前端点一个概念，就能顺着 contains 边反查到支撑它的原始资料 ——
 * 这是「知识拓扑」而不是「词云」的关键。
 */

import type {
  Cluster,
  Document,
  GraphEdge,
  GraphModel,
  GraphNode,
  NodeKind,
  Topic,
} from "@/core/types";
import { tokenize, type Token } from "./tokenize";
import { computeTfidf, selectKeywords } from "./tfidf";
import { detectCommunities } from "./communities";

export interface HeuristicOptions {
  signal?: AbortSignal;
  maxKeywords?: number;
}

/**
 * 共现窗口。
 *
 * 15 是权衡的结果：太小（比如 3）只能连到紧邻的词，簇会碎成一片；
 * 太大（比如整篇）则任何两个高频词都会连边，图会变成一团。
 * 中文里一个概念通常在半句话到一句话内展开，15 个词大致就是那个尺度。
 */
const COOCCUR_WINDOW = 15;

/** 每个关键词保留最强的若干条共现边，防止少数高频词把图变成星形。 */
const MAX_EDGES_PER_KEYWORD = 8;

/** 共现强度低于此值直接丢弃 —— 只共现过一两次的词对不值得连边。 */
const MIN_EDGE_WEIGHT = 0.6;

export async function buildHeuristicGraph(
  topic: Topic,
  docs: Document[],
  opts: HeuristicOptions = {},
): Promise<GraphModel> {
  const t0 = Date.now();

  // ── 1. 分词 ──
  const tokenized: { doc: Document; tokens: Token[] }[] = [];
  for (const doc of docs) {
    if (opts.signal?.aborted) throw new Error("构图已取消");
    // 标题进正文一起分词：标题里的词往往是全文最核心的概念，而正文里
    // 因为篇幅原因它可能被稀释。
    // 传 site 是为了滤掉视频平台的界面文案（B 站的「番剧/投稿」等）——
    // 这些词只在对应站点上是噪声，见 stopwords.ts。
    const text = `${doc.title}。${doc.text}`;
    tokenized.push({
      doc,
      tokens: await tokenize(text, { site: doc.site }),
    });
  }

  // ── 2. TF-IDF 与关键词选取 ──
  const tfidf = computeTfidf(
    tokenized.map((t) => ({ id: t.doc.id, tokens: t.tokens })),
  );
  const keywords = selectKeywords(tfidf, { max: opts.maxKeywords ?? 60 });
  const keywordSet = new Set(keywords);

  if (keywords.length === 0) {
    return emptyGraph(topic, docs, Date.now() - t0);
  }

  // ── 3. 共现建边 ──
  const cooccur = new Map<string, number>();
  const docKeywords = new Map<string, Set<string>>();

  for (const { doc, tokens } of tokenized) {
    const present = new Set<string>();
    const hits: { word: string; pos: number }[] = [];

    tokens.forEach((t, i) => {
      if (!keywordSet.has(t.word)) return;
      present.add(t.word);
      hits.push({ word: t.word, pos: i });
    });

    docKeywords.set(doc.id, present);

    for (let i = 0; i < hits.length; i++) {
      for (let j = i + 1; j < hits.length; j++) {
        const a = hits[i];
        const b = hits[j];
        const distance = b.pos - a.pos;
        if (distance > COOCCUR_WINDOW) break; // hits 按 pos 升序，后面的只会更远
        if (a.word === b.word) continue;

        // 距离衰减：紧邻的词对权重接近 1，越远越接近 0
        const contribution = 1 / (1 + distance / 3);
        const key = edgeKey(a.word, b.word);
        cooccur.set(key, (cooccur.get(key) ?? 0) + contribution);
      }
    }
  }

  // ── 4. 剪枝：每个词只留最强的几条边 ──
  const edges = pruneEdges(cooccur);

  // ── 5. 社区发现（只在关键词上跑，文档节点不参与分簇） ──
  const nodeWeights = new Map(keywords.map((w) => [w, tfidf.weight.get(w) ?? 1]));
  const communities = detectCommunities({ nodes: nodeWeights, edges });

  // ── 6. 组装 GraphModel ──
  return assemble({
    topic,
    docs,
    keywords,
    edges,
    tfidf,
    docKeywords,
    communities,
    durationMs: Date.now() - t0,
  });
}

/** 无向边的稳定键：两个词按字典序排列，保证 a-b 与 b-a 落到同一个键。 */
function edgeKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

function pruneEdges(cooccur: Map<string, number>): {
  source: string;
  target: string;
  weight: number;
}[] {
  // 先按权重降序，这样每个词的前 N 条一定是它最强的连接
  const sorted = [...cooccur.entries()]
    .map(([key, weight]) => {
      const [a, b] = key.split("\u0000");
      return { source: a, target: b, weight };
    })
    .filter((e) => e.weight >= MIN_EDGE_WEIGHT)
    .sort((a, b) => b.weight - a.weight);

  const perNode = new Map<string, number>();
  const kept: { source: string; target: string; weight: number }[] = [];

  for (const e of sorted) {
    const ns = perNode.get(e.source) ?? 0;
    const nt = perNode.get(e.target) ?? 0;
    if (ns >= MAX_EDGES_PER_KEYWORD || nt >= MAX_EDGES_PER_KEYWORD) continue;
    perNode.set(e.source, ns + 1);
    perNode.set(e.target, nt + 1);
    kept.push(e);
  }

  return kept;
}

interface AssembleInput {
  topic: Topic;
  docs: Document[];
  keywords: string[];
  edges: { source: string; target: string; weight: number }[];
  tfidf: ReturnType<typeof computeTfidf>;
  docKeywords: Map<string, Set<string>>;
  communities: ReturnType<typeof detectCommunities>;
  durationMs: number;
}

function assemble(input: AssembleInput): GraphModel {
  const { topic, docs, keywords, edges, tfidf, docKeywords, communities } = input;

  const nodes: GraphNode[] = [];
  const graphEdges: GraphEdge[] = [];

  // ── 关键词节点 ──
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }

  for (const word of keywords) {
    const posting = tfidf.postings.get(word) ?? new Map();
    nodes.push({
      id: kwId(word),
      label: word,
      kind: "keyword" as NodeKind,
      weight: round(tfidf.weight.get(word) ?? 0),
      degree: degree.get(word) ?? 0,
      // 支撑这个词的资料 id —— 前端点节点后据此列出原文
      docIds: [...posting.keys()],
      clusterId: communities.assignment.get(word) ?? "c0",
    });
  }

  // ── 文档节点 ──
  for (const doc of docs) {
    const kws = docKeywords.get(doc.id) ?? new Set();
    nodes.push({
      id: docId(doc.id),
      label: doc.title || doc.url,
      kind: "document" as NodeKind,
      // 文档权重用词数的对数：篇幅大的资料通常信息量更大，但不该线性碾压
      weight: round(Math.log(1 + doc.wordCount) + kws.size / 4),
      degree: kws.size,
      docIds: [doc.id],
      clusterId: dominantCluster(kws, communities.assignment),
    });
  }

  // ── 共现边 ──
  edges.forEach((e, i) => {
    graphEdges.push({
      id: `e${i}`,
      source: kwId(e.source),
      target: kwId(e.target),
      kind: "cooccur",
      weight: round(e.weight),
    });
  });

  // ── contains 边：文档 → 它包含的关键词 ──
  let edgeSeq = graphEdges.length;
  for (const doc of docs) {
    const kws = docKeywords.get(doc.id) ?? new Set();
    for (const word of kws) {
      const tf = tfidf.postings.get(word)?.get(doc.id) ?? 0;
      graphEdges.push({
        id: `e${edgeSeq++}`,
        source: docId(doc.id),
        target: kwId(word),
        kind: "contains",
        weight: round(1 + tf),
        evidence: [doc.id],
      });
    }
  }

  // ── 簇 ──
  const clusters = buildClusters(communities, tfidf, docKeywords, docs);

  return {
    version: 1,
    topic,
    nodes,
    edges: graphEdges,
    clusters,
    stats: {
      nodeCount: nodes.length,
      edgeCount: graphEdges.length,
      clusterCount: clusters.length,
      docCount: docs.length,
      generatedBy: "heuristic",
      durationMs: input.durationMs,
    },
  };
}

function buildClusters(
  communities: ReturnType<typeof detectCommunities>,
  tfidf: ReturnType<typeof computeTfidf>,
  docKeywords: Map<string, Set<string>>,
  docs: Document[],
): Cluster[] {
  const out: Cluster[] = [];

  for (const [id, members] of communities.clusters) {
    // 簇内权重 top5 的词，用作图例与摘要
    const topTerms = [...members]
      .sort((a, b) => (tfidf.weight.get(b) ?? 0) - (tfidf.weight.get(a) ?? 0))
      .slice(0, 5);

    // 反查支撑该簇的文档：包含其中任一关键词的文档都算
    const memberSet = new Set(members);
    const docIds = docs
      .filter((d) => {
        const kws = docKeywords.get(d.id);
        if (!kws) return false;
        for (const w of kws) if (memberSet.has(w)) return true;
        return false;
      })
      .map((d) => d.id);

    out.push({
      id,
      label: topTerms.slice(0, 3).join(" · ") || id,
      nodeIds: members.map(kwId),
      docIds,
      topTerms,
      size: members.length,
      // 统计式的一句话。LLM 路径会覆盖成真正的综述。
      summary: `围绕 ${topTerms.slice(0, 3).join("、")} 的 ${members.length} 个概念，关联 ${docIds.length} 篇资料`,
    });
  }

  return out;
}

/** 文档归到它包含的关键词里出现最多的那个簇。 */
function dominantCluster(
  kws: Set<string>,
  assignment: Map<string, string>,
): string {
  const tally = new Map<string, number>();
  for (const w of kws) {
    const c = assignment.get(w);
    if (!c) continue;
    tally.set(c, (tally.get(c) ?? 0) + 1);
  }
  if (tally.size === 0) return "c0";
  return [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

export function kwId(word: string): string {
  return `k:${word}`;
}

export function docId(id: string): string {
  return `d:${id}`;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function emptyGraph(
  topic: Topic,
  docs: Document[],
  durationMs: number,
): GraphModel {
  return {
    version: 1,
    topic,
    nodes: docs.map((d) => ({
      id: docId(d.id),
      label: d.title || d.url,
      kind: "document" as NodeKind,
      weight: 1,
      degree: 0,
      docIds: [d.id],
      clusterId: "c0",
    })),
    edges: [],
    clusters: [],
    stats: {
      nodeCount: docs.length,
      edgeCount: 0,
      clusterCount: 0,
      docCount: docs.length,
      generatedBy: "heuristic",
      durationMs,
    },
  };
}
