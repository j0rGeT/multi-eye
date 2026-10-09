/**
 * LLM 构图路径。
 *
 * 与启发式路径的分工不是「更好的 TF-IDF」，而是做统计做不到的三件事：
 *
 *   1. **实体而不是词。**「Mavic 3」分词后是 Mavic + 3，共现图里它和「无人机」
 *      的关系要靠词频碰巧撞上；模型直接给出「Mavic 3 是 大疆 的产品」。
 *   2. **有谓词的关系。** 边的 label 是「配套使用」「竞品」「代际升级」，
 *      而不是「这两个词一起出现过」。
 *   3. **能读的簇。** 一句话综述 + 有语义的簇名，而不是 top-3 词拼起来。
 *
 * 产出仍是同一个 GraphModel。两条路径的差别只体现在内容上，不体现在形状上 ——
 * 前端、导出、下载都不需要知道这次是谁构的图。
 *
 * 三个必须处理的现实问题：
 *
 *  - **上下文塞不下。** 70 篇中文资料每篇几千字，一次调用装不进去。所以按资料
 *    截断（每篇 DOC_CHARS 字）并限量（MAX_DOCS 篇），且如实记录被截掉的数量。
 *  - **模型会写错。** 关系里引用了不存在的实体、docIndices 越界、实体没被任何
 *    簇收留 —— 每一条都要过滤或兜底，不能让它把图搞成悬空边。
 *  - **索引比 id 靠谱。** 让模型回 0..N 的序号，而不是让它抄 16 位十六进制的
 *    资料 id —— 后者极易写错且错得无声无息。
 */

import { z } from "zod";
import type {
  Cluster,
  Document,
  GraphEdge,
  GraphModel,
  GraphNode,
  Topic,
} from "@/core/types";
import { chatJson, type ChatMessage } from "@/core/llm/chat";
import { docId, kwId } from "./heuristic";

/**
 * 调用本身（协议选择、推理模型的额度陷阱、json_object 只保证语法不保证形状、
 * 为什么走 directFetch 而非代理）全部在 `@/core/llm/chat` —— 查询分析与相关性
 * 判定共用同一份，这里只负责**本路径特有的东西**：送哪些资料、要什么形状、
 * 拿到之后怎么装成 GraphModel。
 */

/** 一次请求最多送几篇资料。超出的按「信息量」排序后截断。 */
const MAX_DOCS = 60;
/** 每篇资料最多送多少字符。 */
const DOC_CHARS = 1200;

const ENTITY_TYPES = ["人物", "组织", "技术", "产品", "概念", "地点"] as const;

/**
 * 抽取结果的 schema。
 *
 * 全部字段必填（不用 .optional()）：结构化输出对可选字段的支持面窄，
 * 「没有就返回空数组」比「字段可能不存在」稳得多。
 */
const Extraction = z.object({
  entities: z.array(
    z.object({
      name: z.string().describe("实体的规范名称，中文优先保留原文"),
      type: z.enum(ENTITY_TYPES),
      aliases: z.array(z.string()).describe("同一实体的其他写法，没有就给空数组"),
      docIndices: z.array(z.number().int()).describe("提到它的资料序号，从 0 开始"),
    }),
  ),
  relations: z.array(
    z.object({
      source: z.string().describe("必须是 entities 里出现过的 name"),
      target: z.string(),
      label: z.string().describe("关系谓词，2-6 个字，如「配套使用」「属于」"),
      weight: z.number().describe("关系强度 0-1"),
      docIndices: z.array(z.number().int()),
    }),
  ),
  clusters: z.array(
    z.object({
      label: z.string().describe("主题簇的名字，要能当章节标题"),
      summary: z.string().describe("一到两句话说明这一簇在讲什么"),
      entities: z.array(z.string()).describe("属于这一簇的实体 name"),
      docIndices: z.array(z.number().int()),
    }),
  ),
});

type ExtractionResult = z.infer<typeof Extraction>;

export interface LlmOptions {
  signal?: AbortSignal;
}

export async function buildLlmGraph(
  topic: Topic,
  docs: Document[],
  opts: LlmOptions = {},
): Promise<GraphModel> {
  const started = Date.now();
  const picked = pickDocs(docs);
  const extracted = await extract(topic, picked, opts.signal);
  return assemble(topic, docs, picked, extracted, Date.now() - started);
}

// ─────────────────────────── 调用 ───────────────────────────

/**
 * 抽取。发一次、校验、不合格就带着模型自己那份 JSON 返修一次 ——
 * 那一轮返修的机制在 `chatJson` 里，这里只管「送什么、要什么形状」。
 *
 * 两次都不合格就抛错，由 `buildLlmGraph` 的调用方退回启发式路径 ——
 * 比让整张图带着一堆悬空边画出来便宜。
 */
async function extract(
  topic: Topic,
  picked: Document[],
  signal?: AbortSignal,
): Promise<ExtractionResult> {
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userPrompt(topic, picked) },
  ];

  return chatJson(Extraction, messages, { signal });
}

// ─────────────────────────── 输入准备 ───────────────────────────

/**
 * 挑要送进模型的资料。
 *
 * 按词数从多到少排，取前 MAX_DOCS 篇：一次调研里真正撑起主题的是长文，
 * 而只有摘要的那些（extractMethod === 'raw'）本来就没有可供抽取的内容。
 * 顺序在这里就固定下来 —— 之后模型回的 docIndices 全部相对这个数组。
 */
function pickDocs(docs: Document[]): Document[] {
  return [...docs]
    .filter((d) => d.text.trim().length > 0)
    .sort((a, b) => b.wordCount - a.wordCount)
    .slice(0, MAX_DOCS);
}

function userPrompt(topic: Topic, docs: Document[]): string {
  const body = docs
    .map((d, i) => {
      const text = d.text.replace(/\s+/g, " ").trim().slice(0, DOC_CHARS);
      return `[${i}] ${d.title || d.url}（${d.site}）\n${text}`;
    })
    .join("\n\n");

  return [
    `调研主题：${topic.query}`,
    `下面是这次调研抓到的 ${docs.length} 篇资料，每篇前面是它的序号。`,
    "",
    body,
    "",
    "请抽取实体、实体之间的关系，并把这些实体与资料划分成若干主题簇，" +
      "按约定的 JSON 结构返回。",
  ].join("\n");
}

/**
 * 输出形状的说明，直接从 zod schema 生成。
 *
 * 手写一份放在提示词里、再在代码里维护一份 zod，是这类代码最常见的一种烂法：
 * 改了一边忘了另一边，而症状是「模型偶尔就不听话」—— 极难归因。这里只有一份
 * 真相，改 schema 提示词自动跟着变。
 */
const SHAPE_HINT = shapeHint();

function shapeHint(): string {
  const schema = z.toJSONSchema(Extraction) as Record<string, unknown>;
  delete schema.$schema;
  // minimum/maximum 是 Number.MAX_SAFE_INTEGER 展开出来的噪声，只占字数
  return JSON.stringify(schema)
    .replace(/,"(?:minimum|maximum)":-?\d+/g, "")
    .replace(/"(?:minimum|maximum)":-?\d+,/g, "");
}

const SYSTEM_PROMPT = [
  "你是知识工程助手，负责把一次资料调研的原文整理成知识拓扑。",
  "只输出一个 JSON 对象，不要解释、不要 Markdown 代码块。",
  "",
  "输出必须严格符合下面这个 JSON Schema：",
  SHAPE_HINT,
  "",
  "内容要求：",
  "- 实体是具体的、可指认的东西（产品、公司、技术、人物、地点、概念），" +
    "不要抽「使用方法」这类泛泛的词组。",
  "- 同一实体的不同写法合并成一个，其他写法放进 aliases。",
  "- 关系只在资料中真的有依据时才写，label 用简短的中文谓词。" +
    "source/target 必须与 entities 里的 name 完全一致。",
  "- 主题簇 2-8 个，每个簇的名字要能直接当报告章节标题；" +
    "一个实体只属于一个簇。",
  "- docIndices 只填真的提到该实体/属于该簇的资料序号，不要为了凑数全填。",
].join("\n");

// ─────────────────────────── 组装 ───────────────────────────

/**
 * 把模型给的东西装成 GraphModel。
 *
 * 这里做的是**防御性映射**：模型写的每一条引用都要先验证再落地。三种常见错误
 * 各有对策 —— 越界的序号丢掉、重复的实体名合并、没人收留的实体和资料塞进
 * 一个补充簇。宁可少几条边，也不要一张带悬空边的图（Cytoscape 会直接报错）。
 */
function assemble(
  topic: Topic,
  allDocs: Document[],
  picked: Document[],
  x: ExtractionResult,
  durationMs: number,
): GraphModel {
  const validIndex = (i: number) => Number.isInteger(i) && i >= 0 && i < picked.length;

  // ── 实体 ──
  // 按 name 归并：模型偶尔会把同一个名字列两次，分开处理会得到两个同 id 的节点
  const entities = new Map<string, { name: string; type: string; aliases: string[]; docIds: Set<string> }>();
  for (const e of x.entities) {
    const name = e.name.trim();
    if (!name) continue;
    const entry = entities.get(name) ?? {
      name,
      type: e.type,
      aliases: [],
      docIds: new Set<string>(),
    };
    for (const a of e.aliases) {
      const alias = a.trim();
      if (alias && alias !== name && !entry.aliases.includes(alias)) entry.aliases.push(alias);
    }
    for (const i of e.docIndices) {
      if (validIndex(i)) entry.docIds.add(picked[i].id);
    }
    entities.set(name, entry);
  }

  // ── 簇的归属 ──
  // 先按模型的划分建立，再做两轮兜底：没被任何簇收留的实体、以及资料。
  const clusters: Cluster[] = x.clusters.slice(0, 12).map((c, i) => ({
    id: `c${i}`,
    label: c.label.trim() || `主题 ${i + 1}`,
    nodeIds: [],
    docIds: [],
    topTerms: [],
    size: 0,
    summary: c.summary.trim(),
  }));

  const entityCluster = new Map<string, string>();
  const docCluster = new Map<string, string>();

  x.clusters.slice(0, clusters.length).forEach((c, ci) => {
    const id = clusters[ci].id;
    for (const name of c.entities) {
      const key = name.trim();
      if (entities.has(key) && !entityCluster.has(key)) entityCluster.set(key, id);
    }
    for (const i of c.docIndices) {
      if (!validIndex(i) || docCluster.has(picked[i].id)) continue;
      docCluster.set(picked[i].id, id);
      clusters[ci].docIds.push(picked[i].id);
    }
  });

  // 模型漏掉的实体：跟着它出现最多的那篇资料走，比新开一个簇更贴近事实
  for (const [name, e] of entities) {
    if (entityCluster.has(name)) continue;
    const byDocCount = new Map<string, number>();
    for (const d of e.docIds) {
      const c = docCluster.get(d);
      if (c) byDocCount.set(c, (byDocCount.get(c) ?? 0) + 1);
    }
    const best = [...byDocCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (best) entityCluster.set(name, best);
  }

  const orphans = [...entities.keys()].filter((n) => !entityCluster.has(n));
  const orphanDocs = picked.filter((d) => !docCluster.has(d.id));
  if (orphans.length > 0 || orphanDocs.length > 0) {
    const id = `c${clusters.length}`;
    clusters.push({
      id,
      label: "其他",
      nodeIds: [],
      docIds: [],
      topTerms: [],
      size: 0,
      summary: "模型没有把它们归入任何主题簇。",
    });
    for (const n of orphans) entityCluster.set(n, id);
    for (const d of orphanDocs) {
      docCluster.set(d.id, id);
      clusters[clusters.length - 1].docIds.push(d.id);
    }
  }

  // ── 边 ──
  const edges: GraphEdge[] = [];
  const degree = new Map<string, number>();
  let seq = 0;
  const pushEdge = (e: Omit<GraphEdge, "id">) => {
    edges.push({ ...e, id: `e${seq++}` });
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  };

  for (const r of x.relations) {
    const s = r.source.trim();
    const t = r.target.trim();
    // 引用了不存在的实体：丢掉。硬连一个占位节点会把图搞出一堆孤点
    if (!entities.has(s) || !entities.has(t) || s === t) continue;
    pushEdge({
      source: kwId(s),
      target: kwId(t),
      kind: "relation",
      label: r.label.trim() || undefined,
      weight: clamp01(r.weight),
      evidence: [...new Set(r.docIndices.filter(validIndex).map((i) => picked[i].id))],
    });
  }

  // ── 节点 ──
  const nodes: GraphNode[] = [];
  for (const [name, e] of entities) {
    const docIds = [...e.docIds];
    nodes.push({
      id: kwId(name),
      label: name,
      kind: "entity",
      type: e.type,
      aliases: e.aliases.length > 0 ? e.aliases : undefined,
      // 支撑它的资料数就是它在这个语料里的分量。前端按最大值归一化，量纲无所谓
      weight: Math.max(1, docIds.length),
      degree: degree.get(kwId(name)) ?? 0,
      docIds,
      clusterId: entityCluster.get(name) ?? `c0`,
    });
  }

  // contains 边：资料 → 它提到的实体。
  //
  // 这条边不是装饰，是**别的模块在依赖它**：节点详情靠它反查原文，
  // Markdown 报告靠它算一篇资料对各个簇的归属度。少了它，图能看但点不动、
  // 报告里的分簇资料会全空。
  for (const [name, e] of entities) {
    for (const d of e.docIds) {
      pushEdge({
        source: docId(d),
        target: kwId(name),
        kind: "contains",
        weight: 1,
        evidence: [d],
      });
    }
  }

  for (const doc of picked) {
    nodes.push({
      id: docId(doc.id),
      label: doc.title || doc.url,
      kind: "document",
      weight: round(Math.log(1 + doc.wordCount)),
      degree: 0,
      docIds: [doc.id],
      clusterId: docCluster.get(doc.id) ?? clusters[0]?.id ?? "c0",
    });
  }

  // 没进模型的资料也要出现在图上 —— 否则用户会以为它们没被抓到
  const pickedIds = new Set(picked.map((d) => d.id));
  for (const doc of allDocs) {
    if (pickedIds.has(doc.id)) continue;
    nodes.push({
      id: docId(doc.id),
      label: doc.title || doc.url,
      kind: "document",
      weight: round(Math.log(1 + doc.wordCount)),
      degree: 0,
      docIds: [doc.id],
      clusterId: clusters[0]?.id ?? "c0",
    });
  }

  // ── 补齐簇的成员 ──
  // nodeIds / size / topTerms 是前端图例和报告章节在用，模型不直接给这些
  const docById = new Map(allDocs.map((d) => [d.id, d]));
  const nodeCluster = new Map(nodes.map((n) => [n.id, n.clusterId]));
  for (const c of clusters) {
    c.nodeIds = nodes.filter((n) => nodeCluster.get(n.id) === c.id).map((n) => n.id);
    // 未被模型收录的资料不在任何簇的 docIds 里，但对「其他」簇来说它们正是内容
    c.topTerms = nodes
      .filter((n) => n.kind === "entity" && n.clusterId === c.id)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 5)
      .map((n) => n.label);
    c.size = c.nodeIds.length;
  }

  const kept = clusters.filter((c) => c.nodeIds.length > 0);
  const keptIds = new Set(kept.map((c) => c.id));
  for (const n of nodes) {
    if (!keptIds.has(n.clusterId)) n.clusterId = kept[0]?.id ?? "c0";
  }

  return {
    version: 1,
    topic,
    nodes,
    edges,
    clusters: kept,
    stats: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      clusterCount: kept.length,
      docCount: docById.size,
      generatedBy: "llm",
      durationMs,
    },
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return round(Math.min(1, Math.max(0, n)));
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
