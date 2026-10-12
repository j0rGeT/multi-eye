import type { NextRequest } from "next/server";
import { z } from "zod";
import type {
  Cluster,
  Document,
  GraphEdge,
  GraphModel,
  GraphNode,
  SearchResult,
  Session,
} from "@/core/types";
import { loadSession, saveSession } from "@/core/store";
import { planQueries } from "@/core/search/plan";
import { searchAll } from "@/core/search/orchestrate";
import { normalizeUrl } from "@/core/search/normalize";
import { hasLLM } from "@/core/env";
import { chatJson } from "@/core/llm/chat";
import { extractMany } from "@/core/fetch/extract";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface NodeBody {
  sessionId?: string;
  nodeId?: string;
  /**
   * remove = 删除节点与其关联资料；
   * search = 围绕该节点深搜并并入会话；
   * expand = 扩展关联技术节点、自动连线并深入检索补充材料
   */
  action?: "remove" | "search" | "expand";
  /** 显式指定要补充的关键词（可选；如果不传则由大模型或关联词自动推导） */
  extraTerms?: string[];
}

/**
 * 拓扑节点的相关动作：删除、深入搜索、补充拓展节点与材料。
 */
export async function POST(req: NextRequest) {
  let body: NodeBody;
  try {
    body = (await req.json()) as NodeBody;
  } catch {
    return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const sessionId = body.sessionId?.trim();
  const nodeId = body.nodeId?.trim();
  if (!sessionId || !nodeId) {
    return Response.json({ error: "缺少 sessionId 或 nodeId" }, { status: 400 });
  }

  const session = await loadSession(sessionId);
  if (!session) {
    return Response.json({ error: `会话不存在：${sessionId}` }, { status: 404 });
  }
  const graph = session.graph;
  if (!graph) {
    return Response.json({ error: "该会话还没有拓扑图" }, { status: 409 });
  }
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) {
    return Response.json({ error: `节点不存在：${nodeId}` }, { status: 404 });
  }

  if (body.action === "search") {
    return deepSearch(session, graph, node, req.signal);
  }
  if (body.action === "expand") {
    return expandNode(session, graph, node, body.extraTerms, req.signal);
  }
  return removeNode(session, graph, node.id);
}

/**
 * 删除节点，并删掉**只属于它**的资料。
 *
 * 判据是「这篇资料是否还有别的节点在引用」，而不是「节点的 docIds 里有它」——
 * 一个概念节点往往与其它概念共享同一篇正文，把它一起删掉就是误删。
 * 文档节点只指向自己，删除它等于删除那篇资料，这正是用户要的「删掉无关的点，
 * 连带删掉无关的资料」。
 */
async function removeNode(
  session: Session,
  graph: GraphModel,
  nodeId: string,
) {
  const removedNodes = new Set<string>([nodeId]);
  const removedDocIds = new Set<string>();

  const node = graph.nodes.find((n) => n.id === nodeId)!;
  if (node.kind === "document") {
    for (const id of node.docIds) removedDocIds.add(id);
  } else {
    // 概念节点：只删「没有其它节点引用」的支撑资料
    const referencedElsewhere = new Set<string>();
    for (const other of graph.nodes) {
      if (other.id === nodeId) continue;
      for (const id of other.docIds) referencedElsewhere.add(id);
    }
    for (const id of node.docIds) {
      if (!referencedElsewhere.has(id)) removedDocIds.add(id);
    }
  }

  const nextNodes = graph.nodes.filter((n) => !removedNodes.has(n.id));
  const nextEdges = graph.edges.filter(
    (e) => !removedNodes.has(e.source) && !removedNodes.has(e.target),
  );

  const nextDocuments = session.documents.filter(
    (d) => !removedDocIds.has(d.id),
  );
  const removedResults = session.results.filter((r) => removedDocIds.has(r.id));
  const nextResults = session.results.filter((r) => !removedDocIds.has(r.id));

  const nextGraph: GraphModel = {
    ...graph,
    nodes: nextNodes,
    edges: nextEdges,
    clusters: graph.clusters.map((c) => ({
      ...c,
      nodeIds: c.nodeIds.filter((id) => !removedNodes.has(id)),
      docIds: c.docIds.filter((id) => !removedDocIds.has(id)),
      size: c.nodeIds.filter((id) => !removedNodes.has(id)).length,
    })),
    stats: {
      ...graph.stats,
      nodeCount: nextNodes.length,
      edgeCount: nextEdges.length,
      docCount: nextDocuments.length,
    },
  };

  await saveSession({
    ...session,
    graph: nextGraph,
    documents: nextDocuments,
    results: nextResults,
    topic: { ...session.topic, updatedAt: new Date().toISOString() },
  });

  return Response.json({
    graph: nextGraph,
    removed: {
      nodes: [...removedNodes],
      documents: [...removedDocIds],
      results: removedResults.map((r) => r.id),
    },
    totals: {
      nodes: nextNodes.length,
      documents: nextDocuments.length,
      results: nextResults.length,
    },
  });
}

/**
 * 围绕一个节点深入搜索，并将新结果、抓取的正文以及关联关系并进会话与拓扑图。
 */
async function deepSearch(
  session: Session,
  graph: GraphModel,
  node: GraphNode,
  signal: AbortSignal,
) {
  const topic = session.topic;
  const label = node.label;
  const aliases = node.aliases ?? [];
  const focus = [label, ...aliases].filter(Boolean).join(" ");
  const intent = [
    `深入调研拓扑中的节点「${label}」`,
    `整体主题是「${topic.query}」`,
    topic.intent,
    aliases.length ? `该节点的别名：${aliases.join("、")}` : "",
  ]
    .filter(Boolean)
    .join("；");

  // 深入搜索针对技术节点，过滤掉可能非常缓慢且不稳定的视频爬取（如 yt-dlp）
  const deepSites = topic.sites.filter((s) => s !== "youtube");
  const plan = await planQueries(focus, deepSites, { signal, intent });
  const search = await searchAll({
    topic: focus,
    plan,
    sites: deepSites,
    signal,
    timeRange: session.searchOptions?.timeRange,
    sortMode: session.searchOptions?.sortMode,
    skipLlmJudgement: true,
  });

  const existing = new Set(session.results.map((r) => normalizeUrl(r.url)));
  const added = search.results.filter(
    (r) => !existing.has(normalizeUrl(r.url)),
  );
  const mergedResults: SearchResult[] = [...session.results, ...added];

  // 尝试为新搜到的高相关文章抓取正文，最多抓取 3 篇，补充到节点支撑资料
  let newDocs: Document[] = [];
  if (added.length > 0) {
    const fetchCandidates = added
      .filter((r) => r.relevance?.verdict !== "unlikely" && r.value?.verdict !== "low")
      .slice(0, 3);
    if (fetchCandidates.length > 0) {
      try {
        const fetchTimeout = AbortSignal.timeout(18_000);
        const fetchSignal = signal ? AbortSignal.any([signal, fetchTimeout]) : fetchTimeout;
        newDocs = await extractMany(fetchCandidates, {
          concurrency: 2,
          signal: fetchSignal,
        });
      } catch {
        // 抓取超时或网络波动不阻断深搜结果返回
      }
    }
  }

  // 将成功抓取的资料补充到当前节点及会话
  const validDocs = newDocs.filter((d) => !d.error && d.wordCount >= 30);
  const nextDocuments = [...session.documents, ...validDocs];
  const addedDocIds = validDocs.map((d) => d.id);

  // 更新当前节点的 docIds 与 weight
  const nextNodes = graph.nodes.map((n) => {
    if (n.id === node.id) {
      const mergedDocIds = Array.from(new Set([...n.docIds, ...addedDocIds]));
      return {
        ...n,
        docIds: mergedDocIds,
        weight: n.weight + (addedDocIds.length > 0 ? 0.3 : 0.05),
      };
    }
    return n;
  });

  const nextGraph: GraphModel = {
    ...graph,
    nodes: nextNodes,
    stats: {
      ...graph.stats,
      docCount: nextDocuments.length,
    },
  };

  await saveSession({
    ...session,
    results: mergedResults,
    documents: nextDocuments,
    graph: nextGraph,
    plan,
    providerLog: [...session.providerLog, ...search.log],
    topic: { ...topic, updatedAt: new Date().toISOString() },
  });

  return Response.json({
    added,
    addedDocs: validDocs,
    graph: nextGraph,
    results: mergedResults,
    plan,
    total: mergedResults.length,
    logs: search.log,
  });
}

const ExpansionSchema = z.object({
  relatedConcepts: z.array(
    z.object({
      label: z.string().describe("相关的核心技术概念/关键词/实体名"),
      relation: z.string().describe("与原节点的关系谓词，如「底层架构」「核心技术」「衍生优化」「评测基准」"),
      type: z.enum(["技术", "产品", "概念", "组织", "人物"]).describe("类型"),
      reason: z.string().describe("简要阐述为何相关"),
    }),
  ).describe("补充的 3~5 个强相关技术节点"),
});

/**
 * 拓扑节点补充与拓展：根据用户提供的关键词或选中节点，
 * 补充相关关键词搜索，在拓扑图中补充新节点并建立关系连线，并考虑深入搜索补充支撑材料。
 */
async function expandNode(
  session: Session,
  graph: GraphModel,
  node: GraphNode,
  extraTerms: string[] | undefined,
  signal: AbortSignal,
) {
  const topic = session.topic;
  let expandedTerms: { label: string; relation: string; type?: string }[] = [];

  // 如果客户端传入了显式关键词，则优先使用
  if (extraTerms && extraTerms.length > 0) {
    expandedTerms = extraTerms.map((t) => ({
      label: t.trim(),
      relation: "相关技术",
      type: "技术",
    })).filter((t) => t.label && t.label !== node.label);
  } else if (hasLLM()) {
    // 借助大模型智能推导关联技术节点
    try {
      const deadline = AbortSignal.timeout(12_000);
      const llmSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
      const res = await chatJson(
        ExpansionSchema,
        [
          {
            role: "system",
            content: "你是一个技术架构与知识图谱专家。请根据给定的主题与当前节点，推导出 3~5 个紧密相关的核心技术节点、底层原理、衍生优化或工程实践概念。",
          },
          {
            role: "user",
            content: `调研全局主题：${topic.query}\n当前节点：${node.label} (${node.kind})\n请补充该节点的核心相关技术概念，用于在拓扑图中补充新节点与关系连线。`,
          },
        ],
        { signal: llmSignal, timeoutMs: 12_000, maxTokens: 2048 },
      );
      expandedTerms = res.relatedConcepts.filter((c) => c.label.trim() && c.label.trim() !== node.label);
    } catch {
      // LLM 失败回退到 plan 中的 relatedTerms 或启发式
    }
  }

  // 兜底：如果依然没有，从 plan 的 relatedTerms 或通用技术概念补充
  if (expandedTerms.length === 0) {
    const fallbackTerms = (session.plan?.relatedTerms ?? [])
      .filter((t) => t.trim() && t.trim() !== node.label)
      .slice(0, 4);
    expandedTerms = fallbackTerms.map((t) => ({
      label: t.trim(),
      relation: "关联技术",
      type: "技术",
    }));
  }

  // 依然为空时的最后防御
  if (expandedTerms.length === 0) {
    expandedTerms = [
      { label: `${node.label}原理架构`, relation: "底层架构", type: "技术" },
      { label: `${node.label}优化实践`, relation: "工程实践", type: "技术" },
    ];
  }

  // 把新节点和边加入到图模型中
  const existingNodeLabels = new Set(graph.nodes.map((n) => n.label.toLowerCase()));
  const newNodes: GraphNode[] = [];
  const newEdges: GraphEdge[] = [];

  for (const term of expandedTerms) {
    const termKey = term.label.toLowerCase();
    let targetNodeId = graph.nodes.find((n) => n.label.toLowerCase() === termKey)?.id;

    if (!targetNodeId && !existingNodeLabels.has(termKey)) {
      targetNodeId = `k:exp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const newNode: GraphNode = {
        id: targetNodeId,
        label: term.label,
        kind: "keyword",
        weight: Math.max(1, node.weight * 0.7),
        degree: 1,
        docIds: [...node.docIds], // 继承支撑资料
        clusterId: node.clusterId,
        type: term.type,
      };
      newNodes.push(newNode);
      existingNodeLabels.add(termKey);
    }

    if (targetNodeId && targetNodeId !== node.id) {
      const edgeId = `e:exp_${node.id}_${targetNodeId}`;
      const existsEdge = graph.edges.some(
        (e) => (e.source === node.id && e.target === targetNodeId) ||
               (e.source === targetNodeId && e.target === node.id),
      );
      if (!existsEdge && !newEdges.some((e) => (e.source === node.id && e.target === targetNodeId))) {
        newEdges.push({
          id: edgeId,
          source: node.id,
          target: targetNodeId,
          kind: "relation",
          label: term.relation,
          weight: 0.8,
        });
      }
    }
  }

  // 针对新补充的技术概念执行快线补搜与材料充实
  const deepSites = topic.sites.filter((s) => s !== "youtube");
  const searchQuery = [node.label, ...expandedTerms.slice(0, 2).map((t) => t.label)].join(" ");
  const searchPlan = await planQueries(searchQuery, deepSites, { signal });
  const searchResult = await searchAll({
    topic: searchQuery,
    plan: searchPlan,
    sites: deepSites,
    signal,
    timeRange: session.searchOptions?.timeRange,
    sortMode: session.searchOptions?.sortMode,
    skipLlmJudgement: true,
  });

  const existingUrls = new Set(session.results.map((r) => normalizeUrl(r.url)));
  const added = searchResult.results.filter((r) => !existingUrls.has(normalizeUrl(r.url)));
  const mergedResults = [...session.results, ...added];

  // 抓取 2 篇代表性资料补充材料
  let addedDocs: Document[] = [];
  if (added.length > 0) {
    const targets = added
      .filter((r) => r.relevance?.verdict !== "unlikely" && r.value?.verdict !== "low")
      .slice(0, 2);
    if (targets.length > 0) {
      try {
        const fetchTimeout = AbortSignal.timeout(15_000);
        const fetchSig = signal ? AbortSignal.any([signal, fetchTimeout]) : fetchTimeout;
        addedDocs = (await extractMany(targets, { concurrency: 2, signal: fetchSig }))
          .filter((d) => !d.error && d.wordCount >= 30);
      } catch {}
    }
  }

  const nextDocuments = [...session.documents, ...addedDocs];
  const addedDocIds = addedDocs.map((d) => d.id);

  // 支撑资料与新节点绑定
  const updatedNewNodes = newNodes.map((n) => ({
    ...n,
    docIds: Array.from(new Set([...n.docIds, ...addedDocIds])),
  }));

  const updatedNextNodes = [
    ...graph.nodes.map((n) =>
      n.id === node.id
        ? {
            ...n,
            degree: n.degree + newEdges.length,
            docIds: Array.from(new Set([...n.docIds, ...addedDocIds])),
          }
        : n,
    ),
    ...updatedNewNodes,
  ];

  const updatedNextEdges = [...graph.edges, ...newEdges];

  const nextGraph: GraphModel = {
    ...graph,
    nodes: updatedNextNodes,
    edges: updatedNextEdges,
    stats: {
      ...graph.stats,
      nodeCount: updatedNextNodes.length,
      edgeCount: updatedNextEdges.length,
      docCount: nextDocuments.length,
    },
  };

  await saveSession({
    ...session,
    results: mergedResults,
    documents: nextDocuments,
    graph: nextGraph,
    providerLog: [...session.providerLog, ...searchResult.log],
    topic: { ...topic, updatedAt: new Date().toISOString() },
  });

  return Response.json({
    expanded: updatedNewNodes,
    edges: newEdges,
    added,
    addedDocs,
    graph: nextGraph,
    results: mergedResults,
    total: mergedResults.length,
  });
}
