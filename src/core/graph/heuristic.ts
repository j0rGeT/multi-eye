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
import { annotateNodeTimes } from "./timeline";

export interface HeuristicOptions {
  signal?: AbortSignal;
  maxKeywords?: number;
  /** Louvain 分辨率，省略则用 communities.ts 的默认值。 */
  resolution?: number;
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
  // 每个词的词性统计（word → tag → 次数），供 assemble 推断实体类型用。
  // 一个词在不同文档里可能被标成不同词性（jieba 对专名不稳定），所以按
  // 出现次数取主导词性，而不是信第一次标注。
  const tagCounts = new Map<string, Map<string, number>>();

  for (const { doc, tokens } of tokenized) {
    const present = new Set<string>();
    const hits: { word: string; pos: number }[] = [];

    tokens.forEach((t, i) => {
      if (!keywordSet.has(t.word)) return;
      present.add(t.word);
      hits.push({ word: t.word, pos: i });
      let byTag = tagCounts.get(t.word);
      if (!byTag) tagCounts.set(t.word, (byTag = new Map()));
      byTag.set(t.tag, (byTag.get(t.tag) ?? 0) + 1);
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
  const communities = detectCommunities({
    nodes: nodeWeights,
    edges,
    resolution: opts.resolution,
  });

  // ── 6. 组装 GraphModel ──
  return assemble({
    topic,
    docs,
    keywords,
    edges,
    tfidf,
    docKeywords,
    communities,
    tagCounts,
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
  /** word → tag → 出现次数，用于推断 keyword 节点的实体类型。 */
  tagCounts: Map<string, Map<string, number>>;
  durationMs: number;
}

function assemble(input: AssembleInput): GraphModel {
  const { topic, docs, keywords, edges, tfidf, docKeywords, communities, tagCounts } =
    input;

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
      // 实体类型：与 LLM 路径的 ENTITY_TYPES 对齐，让过滤器/边色在两条构图路径上都能用
      type: inferKeywordType(word, dominantTag(tagCounts.get(word))),
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

  // 注解节点时间属性（发布年份及最早时间，并以边关系推导未定年节点）
  const annotatedNodes = annotateNodeTimes(nodes, docs, graphEdges);

  return {
    version: 1,
    topic,
    nodes: annotatedNodes,
    edges: graphEdges,
    clusters,
    stats: {
      nodeCount: annotatedNodes.length,
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

/**
 * 推断一个关键词的实体类型。
 *
 * 与 LLM 构图路径的 ENTITY_TYPES（人物/组织/技术/产品/概念/地点）对齐，
 * 这样无论图是启发式还是 LLM 生成的，前端的类型过滤与边色都能直接用。
 *
 * 三层判据，精确度从高到低：
 *   1. 中文词形后缀 —— 「xx大学」「xx算法」这种结构在中文里极其稳定，
 *      比 jieba 的粗粒度 n 标注可靠得多，所以放在最前面。
 *   2. jieba 词性 —— nt=机构、nr=人名、ns=地名 都是细粒度标注，可直接采信；
 *      eng/nz（外文专名）区分不出产品还是技术，留给第 3 层的后缀再判一次。
 *   3. 默认「概念」—— 宁可判宽不判错，一个误标成「技术」的概念会让用户
 *      在按类型过滤时凭空丢掉它。
 */
export function inferKeywordType(
  word: string,
  dominant: string | undefined,
): string {
  const lower = word.toLowerCase();

  // ── 1. 词形后缀 ──
  if (
    /(大学|学院|研究院|研究所|实验室|集团|公司|企业|基金会|委员会|协会|团队|中心)$/.test(
      word,
    )
  ) {
    return "组织";
  }
  if (
    /(算法|模型|框架|协议|架构|引擎|内核|编译器|数据库|操作系统|网络|驱动|缓存|系统)$/.test(
      word,
    )
  ) {
    return "技术";
  }
  if (/(版|pro|max|plus|mini|lite|sdk|api|cli|app|os|平台|助手|套件)$/i.test(lower)) {
    return "产品";
  }

  // ── 2. jieba 词性兜底 ──
  if (dominant === "nt") return "组织";
  if (dominant === "nr") return "人物";
  if (dominant === "ns") return "地点";
  // 外文专名（eng/nz）再看一次英文后缀：XxxDB/XxxOS 更可能是产品，XxxNet/Transformer 更可能是技术
  if (dominant === "eng" || dominant === "nz") {
    if (/(db|os|kit|suite|app|cloud)$/.test(lower)) return "产品";
    if (/(net|transformer|bert|gpt|llm|cnn|rnn|gan)$/.test(lower)) return "技术";
    return "产品";
  }

  // ── 3. 默认 ──
  return "概念";
}

/** 取出现次数最多的词性；相同次数时取字典序小的，保证结果稳定可复现。 */
function dominantTag(byTag: Map<string, number> | undefined): string | undefined {
  if (!byTag || byTag.size === 0) return undefined;
  let best: string | undefined;
  let bestCount = -1;
  for (const [tag, count] of byTag) {
    if (count > bestCount || (count === bestCount && best !== undefined && tag < best)) {
      best = tag;
      bestCount = count;
    }
  }
  return best;
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
