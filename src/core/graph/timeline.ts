import type { Document, GraphEdge, GraphModel, GraphNode, NodeKind } from "@/core/types";

/**
 * 拓扑图节点的时间归属与时序趋势计算（叶子模块，客户端与服务端通用）。
 *
 * 核心纪律：
 * 1. 节点的年份首选严格取自其支撑文档的最早 publishedAt（准确原生时间）。
 * 2. 对缺失 publishedAt 的文档或拓展节点，通过拓扑邻居连线中位数、所属簇中位数
 *    与语料基准时间进行多级时序推导，保证每个节点均有年份以支持时间分层，
 *    同时显式标记 isYearInferred 标识，绝不伪造虚假资料。
 */

/**
 * 计算单个节点的发布时间（最早发布年份与 ISO 时间）。
 */
export function nodePublishTime(
  node: { docIds: string[] },
  docMap: Map<string, Document>,
): { year?: number; firstPublishedAt?: string } {
  let earliestMs: number | undefined;
  let earliestIso: string | undefined;

  for (const docId of node.docIds) {
    const doc = docMap.get(docId);
    if (!doc?.publishedAt) continue;
    const ms = Date.parse(doc.publishedAt);
    if (Number.isNaN(ms)) continue;

    if (earliestMs === undefined || ms < earliestMs) {
      earliestMs = ms;
      earliestIso = doc.publishedAt;
    }
  }

  if (earliestMs === undefined || !earliestIso) {
    return {};
  }

  const d = new Date(earliestMs);
  const year = d.getUTCFullYear();
  return { year, firstPublishedAt: earliestIso };
}

/**
 * 计算数字数组的中位数（四舍五入为整年份）。
 */
function medianYear(years: number[]): number | undefined {
  if (years.length === 0) return undefined;
  const sorted = [...years].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * 为一组 GraphNode 注解发布年份与首次发布时间，
 * 并通过多级时序推导确保每个节点均具备 publishedYear 信息（用于年份分层拓扑与演化图）。
 */
export function annotateNodeTimes(
  nodes: GraphNode[],
  docs: Document[],
  edges: GraphEdge[] = [],
): GraphNode[] {
  const docMap = new Map<string, Document>(docs.map((d) => [d.id, d]));

  // 1. 寻找全图基准兜底年份（来自文档的 fetchedAt 或当前自然年）
  let fallbackYear = new Date().getUTCFullYear();
  for (const d of docs) {
    if (d.fetchedAt) {
      const ms = Date.parse(d.fetchedAt);
      if (!Number.isNaN(ms)) {
        fallbackYear = new Date(ms).getUTCFullYear();
        break;
      }
    }
  }

  // 2. 第一轮：从支撑文档的 publishedAt 抽取精准年份（L1 精准原生时间）
  const annotated: GraphNode[] = nodes.map((node) => {
    // 文档节点优先看对应 doc 的 publishedAt
    if (node.kind === "document") {
      const doc = docMap.get(node.id.replace(/^d:/, ""));
      if (doc?.publishedAt) {
        const ms = Date.parse(doc.publishedAt);
        if (!Number.isNaN(ms)) {
          return {
            ...node,
            publishedYear: new Date(ms).getUTCFullYear(),
            isYearInferred: false,
            firstPublishedAt: doc.publishedAt,
          };
        }
      }
    }

    const { year, firstPublishedAt } = nodePublishTime(node, docMap);
    if (year !== undefined) {
      return {
        ...node,
        publishedYear: year,
        isYearInferred: false,
        firstPublishedAt,
      };
    }

    return {
      ...node,
      publishedYear: undefined,
      isYearInferred: true,
      firstPublishedAt: undefined,
    };
  });

  // 3. 构建邻接关系表（用于 L2 拓扑邻居时序扩散）
  const neighborMap = new Map<string, Set<string>>();
  for (const e of edges) {
    if (!neighborMap.has(e.source)) neighborMap.set(e.source, new Set());
    if (!neighborMap.has(e.target)) neighborMap.set(e.target, new Set());
    neighborMap.get(e.source)!.add(e.target);
    neighborMap.get(e.target)!.add(e.source);
  }

  const nodeMap = new Map<string, GraphNode>(annotated.map((n) => [n.id, n]));

  // L2 拓扑邻居推导：若节点无年份，沿关联边取一度关联邻居的年份中位数
  let changed = true;
  let rounds = 0;
  while (changed && rounds < 3) {
    changed = false;
    rounds++;
    for (const n of annotated) {
      if (n.publishedYear !== undefined) continue;
      const neighbors = neighborMap.get(n.id);
      if (!neighbors || neighbors.size === 0) continue;

      const neighborYears: number[] = [];
      for (const nid of neighbors) {
        const nb = nodeMap.get(nid);
        if (nb?.publishedYear !== undefined) {
          neighborYears.push(nb.publishedYear);
        }
      }

      const med = medianYear(neighborYears);
      if (med !== undefined) {
        n.publishedYear = med;
        n.isYearInferred = true;
        changed = true;
      }
    }
  }

  // 4. L3 所属簇（Cluster）时序推导：若依然无年份，取所属概念簇内已定年节点的中位数
  const clusterYears = new Map<string, number[]>();
  for (const n of annotated) {
    if (n.publishedYear !== undefined) {
      const list = clusterYears.get(n.clusterId) ?? [];
      list.push(n.publishedYear);
      clusterYears.set(n.clusterId, list);
    }
  }

  for (const n of annotated) {
    if (n.publishedYear !== undefined) continue;
    const cYears = clusterYears.get(n.clusterId);
    const med = cYears ? medianYear(cYears) : undefined;
    if (med !== undefined) {
      n.publishedYear = med;
      n.isYearInferred = true;
    }
  }

  // 5. L4 全图已知年份中位数 或 基准时间最终兜底：确保 100% 覆盖，绝不留 undefined
  const allKnownYears: number[] = [];
  for (const n of annotated) {
    if (n.publishedYear !== undefined && !n.isYearInferred) {
      allKnownYears.push(n.publishedYear);
    }
  }
  const globalMedianYear = medianYear(allKnownYears) ?? fallbackYear;

  for (const n of annotated) {
    if (n.publishedYear === undefined) {
      n.publishedYear = globalMedianYear;
      n.isYearInferred = true;
    }
  }

  return annotated;
}

export interface TrendSeries {
  nodeId: string;
  label: string;
  kind: NodeKind;
  clusterId: string;
  points: { year: number; count: number }[];
}

export interface TrendData {
  years: number[];
  series: TrendSeries[];
  unknownDocs: number;
}

/**
 * 提取核心节点在各年份出现的次数，供 Recharts 折线图展示。
 */
export function buildTrendData(
  graph: GraphModel,
  docs: Document[],
  topN = 8,
): TrendData {
  const docMap = new Map<string, Document>(docs.map((d) => [d.id, d]));
  let unknownDocs = 0;
  for (const d of docs) {
    if (!d.publishedAt) unknownDocs++;
  }

  // 挑选权重最高且非文档的 topN 个节点
  const targetNodes = graph.nodes
    .filter((n) => n.kind !== "document")
    .sort((a, b) => b.weight - a.weight || b.degree - a.degree)
    .slice(0, topN);

  const allYearsSet = new Set<number>();
  const nodeYearCounts = new Map<string, Map<number, number>>();

  for (const node of targetNodes) {
    const yearCounts = new Map<number, number>();
    for (const docId of node.docIds) {
      const doc = docMap.get(docId);
      if (!doc?.publishedAt) continue;
      const ms = Date.parse(doc.publishedAt);
      if (Number.isNaN(ms)) continue;
      const yr = new Date(ms).getUTCFullYear();
      allYearsSet.add(yr);
      yearCounts.set(yr, (yearCounts.get(yr) ?? 0) + 1);
    }
    nodeYearCounts.set(node.id, yearCounts);
  }

  const years = [...allYearsSet].sort((a, b) => a - b);
  const series: TrendSeries[] = targetNodes.map((node) => {
    const counts = nodeYearCounts.get(node.id) ?? new Map<number, number>();
    const points = years.map((year) => ({
      year,
      count: counts.get(year) ?? 0,
    }));
    return {
      nodeId: node.id,
      label: node.label,
      kind: node.kind,
      clusterId: node.clusterId,
      points,
    };
  });

  return { years, series, unknownDocs };
}

/**
 * 拓扑图年份分层统计维度指标（每年一个统计维度）。
 * 满足纪律：按年份分层，最大 10 年，每年一个统计维度。
 */
export interface YearDimensionStat {
  /** 统计年份标识：如 "2026" 或 "早于 2017" */
  key: string;
  year?: number;
  isBaseline: boolean;
  /** 该年份层包含的节点总数（概念 + 资料） */
  nodeCount: number;
  /** 该年份层概念节点数量 */
  conceptCount: number;
  /** 该年份层文档资料数量 */
  documentCount: number;
  /** 该年份出现的核心代表概念词（权重前 3 个） */
  topConcepts: string[];
}

/**
 * 将图中涉及的年份按“最大 10 年”进行收敛聚类，并计算每年统计维度的元数据。
 * 超出最近 10 年的历史年份归入基准层（"早于 <最早年份>"），确保分层不过度分散。
 */
export function buildYearDimensions(nodes: GraphNode[]): YearDimensionStat[] {
  const yearsSet = new Set<number>();
  for (const n of nodes) {
    if (n.publishedYear !== undefined) {
      yearsSet.add(n.publishedYear);
    }
  }

  if (yearsSet.size === 0) return [];

  // 按年份降序排：最新的在最前
  const sortedDesc = [...yearsSet].sort((a, b) => b - a);
  // 最大保留 10 年
  const top10Years = sortedDesc.slice(0, 10);
  const cutoffYear = top10Years[top10Years.length - 1];
  const hasOlder = sortedDesc.length > 10;

  const statsMap = new Map<string, YearDimensionStat>();

  for (const yr of top10Years) {
    statsMap.set(String(yr), {
      key: String(yr),
      year: yr,
      isBaseline: false,
      nodeCount: 0,
      conceptCount: 0,
      documentCount: 0,
      topConcepts: [],
    });
  }

  const baselineKey = `早于 ${cutoffYear}`;
  if (hasOlder) {
    statsMap.set(baselineKey, {
      key: baselineKey,
      year: undefined,
      isBaseline: true,
      nodeCount: 0,
      conceptCount: 0,
      documentCount: 0,
      topConcepts: [],
    });
  }

  // 节点分桶并收集核心概念
  const conceptsPerKey = new Map<string, { label: string; weight: number }[]>();

  for (const n of nodes) {
    if (n.publishedYear === undefined) continue;
    const key =
      n.publishedYear < cutoffYear && hasOlder
        ? baselineKey
        : statsMap.has(String(n.publishedYear))
          ? String(n.publishedYear)
          : baselineKey;

    const stat = statsMap.get(key);
    if (!stat) continue;
    stat.nodeCount++;
    if (n.kind === "document") {
      stat.documentCount++;
    } else {
      stat.conceptCount++;
      const list = conceptsPerKey.get(key) ?? [];
      list.push({ label: n.label, weight: n.weight });
      conceptsPerKey.set(key, list);
    }
  }

  // 提取各年份权重最高的前 3 个概念词
  for (const [key, stat] of statsMap.entries()) {
    const list = conceptsPerKey.get(key) ?? [];
    list.sort((a, b) => b.weight - a.weight);
    stat.topConcepts = list.slice(0, 3).map((item) => item.label);
  }

  return [...statsMap.values()];
}

