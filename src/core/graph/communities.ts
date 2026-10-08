/**
 * 社区发现（Louvain）。
 *
 * 用 graphology 的纯 JS 实现，不引 native 模块 —— 构图这条链已经够多依赖了，
 * 社区发现是唯一一个「跑不了也能退化成单簇」的环节，不值得为它增加编译风险。
 */

import Graph from "graphology";
import louvain from "graphology-communities-louvain";

export interface CommunityInput {
  /** 节点 id → 权重（用于加权模块度）。 */
  nodes: Map<string, number>;
  /** 边，无向。自环会被忽略。 */
  edges: { source: string; target: string; weight: number }[];
  /** Louvain 分辨率，省略则用默认值。 */
  resolution?: number;
}

export interface CommunityResult {
  /** 节点 id → 社区 id（"c0"、"c1"…，按簇大小降序重编号）。 */
  assignment: Map<string, string>;
  /** 簇 id → 成员节点 id。 */
  clusters: Map<string, string[]>;
}

/**
 * 跑 Louvain 分簇。
 *
 * 失败时退化为「所有节点同属一簇」——簇划分是呈现层的锦上添花，
 * 没有它图依然可读；而抛异常会让整个 /api/graph 挂掉。
 */
export function detectCommunities(input: CommunityInput): CommunityResult {
  const ids = [...input.nodes.keys()];
  if (ids.length === 0) {
    return { assignment: new Map(), clusters: new Map() };
  }

  try {
    const graph = new Graph({ type: "undirected", multi: false });

    for (const [id, w] of input.nodes) {
      // Louvain 在加权模块度里用节点权重，负数会让它直接报错
      graph.addNode(id, { weight: Number.isFinite(w) && w > 0 ? w : 1 });
    }

    for (const e of input.edges) {
      if (e.source === e.target) continue;
      if (!graph.hasNode(e.source) || !graph.hasNode(e.target)) continue;
      // 同一对节点可能因不同文档多次贡献共现，累加而不是覆盖
      if (graph.hasEdge(e.source, e.target)) {
        const prev = graph.getEdgeAttribute(e.source, e.target, "weight") ?? 0;
        graph.setEdgeAttribute(e.source, e.target, "weight", prev + e.weight);
      } else {
        graph.addEdge(e.source, e.target, {
          weight: Number.isFinite(e.weight) && e.weight > 0 ? e.weight : 1,
        });
      }
    }

    const raw = louvain(graph, {
      getEdgeWeight: "weight",
      // 关闭随机游走：同一份资料每次构图应该得到同样的簇划分，
      // 否则用户刷新页面看到图在跳变，会怀疑数据本身不稳定
      randomWalk: false,
      /**
       * 分辨率默认 1（Louvain 的原义）。
       *
       * 试过调高，结论是它解决不了问题反而更糟。在「露营装备」语料（60 词）上
       * 实测：r=1 → 4 簇 [40,9,6,5]，最大簇占 67%；r=1.6 → 6 簇但已是
       * [43,6,5,3,2,1]；r=3 → 10 簇 [35,7,4,4,3,2,2,1,1,1]。
       * 提高分辨率不会让大簇变小，只会把小簇切成只含一两个词的单例 ——
       * 那些簇没有主题含义，是纯噪音。
       *
       * 根因是这份语料真的只有一个主干：所有资料都在讲露营，通用词（营地、
       * 经验、装备）必然横跨全部文档。这是数据的性质，不是算法的参数。
       * 需要更细的粒度时由调用方显式传入。
       */
      resolution: input.resolution ?? 1,
    }) as Record<string, number>;

    return reindex(raw);
  } catch {
    // 退化：全部归为一簇
    return {
      assignment: new Map(ids.map((id) => [id, "c0"])),
      clusters: new Map([["c0", ids]]),
    };
  }
}

/**
 * 把 Louvain 给的任意整数编号重排成 c0/c1/…，按簇大小降序。
 *
 * 为什么要重排：Louvain 的簇编号取决于内部遍历顺序，没有语义。直接用它
 * 会导致配色在两次构图之间错位（同一主题的「大簇」上次是蓝色这次是红色）。
 * 按大小排序后，最大簇永远是 c0，配色就稳定了。
 */
function reindex(raw: Record<string, number>): CommunityResult {
  const buckets = new Map<number, string[]>();
  for (const [node, c] of Object.entries(raw)) {
    const list = buckets.get(c);
    if (list) list.push(node);
    else buckets.set(c, [node]);
  }

  const ordered = [...buckets.values()].sort((a, b) => b.length - a.length);

  const assignment = new Map<string, string>();
  const clusters = new Map<string, string[]>();

  ordered.forEach((members, i) => {
    const id = `c${i}`;
    clusters.set(id, members);
    for (const m of members) assignment.set(m, id);
  });

  return { assignment, clusters };
}
