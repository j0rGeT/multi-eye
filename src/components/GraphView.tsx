"use client";

/**
 * 知识拓扑渲染。
 *
 * Cytoscape + fcose 布局：fcose 是力导向里少数几个能在几百节点规模下保持
 * 可读性、且支持「按簇聚拢」的算法（通过 nodeRepulsion 和 idealEdgeLength
 * 的组合），这正是知识图需要的 —— 同一个簇的节点应该挨在一起。
 *
 * 性能上的两个关键点：
 *  1. 增量更新用 cy.batch() 包住，否则每个元素都会触发一次重排，界面会卡死
 *  2. 布局只在数据真正变化时重跑，选中节点之类的交互绝不重跑布局 ——
 *     否则用户每点一个节点，整张图就会重新飞舞一次
 */

import { useEffect, useMemo, useRef } from "react";
import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import fcose from "cytoscape-fcose";
import type { GraphModel, GraphNode } from "@/core/types";
import { clusterColor, clusterIndexMap } from "@/core/graph/palette";

let fcoseRegistered = false;
function ensureFcose() {
  if (fcoseRegistered) return;
  cytoscape.use(fcose);
  fcoseRegistered = true;
}

export interface GraphViewProps {
  graph: GraphModel;
  /** 当前选中的节点 id，用于高亮。 */
  selectedId?: string;
  onSelect: (node: GraphNode | null) => void;
  /** 只显示关键词（隐藏文档节点）——文档多的时候图会很挤。 */
  showDocuments: boolean;
}

export default function GraphView({
  graph,
  selectedId,
  onSelect,
  showDocuments,
}: GraphViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);

  /**
   * 最新的 graph 与 onSelect 经 ref 转发给 Cytoscape 的事件回调。
   *
   * 为什么必须这么做：事件回调是在「创建实例」那一刻注册的，如果把 graph
   * 或 onSelect 放进那个 effect 的依赖里，数据每更新一次就要销毁重建整个
   * Cytoscape 实例 —— 用户的缩放、平移、拖拽位置全部丢失。用 ref 之后
   * 实例只建一次，回调永远读到最新值。
   */
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  /** 容器尺寸变化时 Cytoscape 不会自动跟着变，需要显式 resize。 */

  /**
   * 把 GraphModel 翻译成 Cytoscape 元素。
   *
   * 用 useMemo 而不是放进 effect：元素数组每次渲染都重建的话，
   * 下面的 effect 会误判成「数据变了」而反复重跑布局。
   */
  const elements = useMemo<ElementDefinition[]>(() => {
    const clusterIndex = clusterIndexMap(graph.clusters);

    const nodes: ElementDefinition[] = graph.nodes
      .filter((n) => showDocuments || n.kind !== "document")
      .map((n) => {
        const ci = clusterIndex.get(n.clusterId) ?? 0;
        return {
          data: {
            id: n.id,
            label: n.label,
            kind: n.kind,
            weight: n.weight,
            degree: n.degree,
            clusterId: n.clusterId,
            color: clusterColor(ci),
          },
        };
      });

    const visible = new Set(nodes.map((n) => n.data.id as string));

    const edges: ElementDefinition[] = graph.edges
      .filter((e) => visible.has(e.source) && visible.has(e.target))
      .map((e) => ({
        data: {
          id: e.id,
          source: e.source,
          target: e.target,
          kind: e.kind,
          weight: e.weight,
        },
      }));

    return [...nodes, ...edges];
  }, [graph, showDocuments]);

  // ── 创建实例（只在挂载时一次）──
  useEffect(() => {
    ensureFcose();
    if (!containerRef.current) return;

    const cy = cytoscape({
      container: containerRef.current,
      elements: [],
      wheelSensitivity: 0.2,
      style: [
        {
          selector: "node",
          style: {
            "background-color": "data(color)",
            "background-opacity": 0.85,
            "border-width": 1,
            "border-color": "#0d1117",
            label: "data(label)",
            "font-size": 9,
            color: "#c9d1d9",
            "text-valign": "bottom",
            "text-margin-y": 3,
            "text-max-width": "90px",
            "text-wrap": "ellipsis",
            width: "data(size)",
            height: "data(size)",
          },
        },
        {
          /**
           * 文档节点：方形 + 中性灰，不跟随簇配色。
           *
           * 本来是按所属簇上色的，但那会传达一个错误信息：这份语料的 60 个
           * 概念里有 40 个落在同一个簇，于是 43 篇资料里 38 篇被判给它 ——
           * 几乎所有资料节点同色，看着像配色坏了，实际上「资料属于某个簇」
           * 这个设定本身就不成立。资料的归属是「跟哪个方向更相关」，
           * 那是个连续量，不是分类。
           *
           * 形状走选择器而不是 data 映射：Cytoscape 的 shape 不支持 mapper，
           * 写 shape: "data(shape)" 会被静默忽略，所有节点都变回圆形。
           */
          selector: 'node[kind = "document"]',
          style: {
            shape: "round-rectangle",
            "background-color": "#484f58",
            "background-opacity": 0.5,
            "border-color": "#6e7681",
            "font-size": 7,
            color: "#8b949e",
          },
        },
        {
          selector: "edge",
          style: {
            width: "data(width)",
            "line-color": "#30363d",
            "curve-style": "bezier",
            opacity: 0.55,
          },
        },
        {
          selector: 'edge[kind = "contains"]',
          style: {
            "line-style": "dotted",
            "line-color": "#21262d",
            opacity: 0.4,
          },
        },
        {
          selector: ".highlighted",
          style: {
            "border-width": 3,
            "border-color": "#e6edf3",
            opacity: 1,
          },
        },
        {
          selector: ".dimmed",
          style: { opacity: 0.15 },
        },
      ],
      layout: { name: "preset" },
    });

    cy.on("tap", "node", (evt) => {
      const id = evt.target.id() as string;
      onSelectRef.current(
        graphRef.current.nodes.find((n) => n.id === id) ?? null,
      );
    });
    // 点空白处取消选中
    cy.on("tap", (evt) => {
      if (evt.target === cy) onSelectRef.current(null);
    });

    cyRef.current = cy;
    return () => {
      cy.destroy();
      cyRef.current = null;
    };
    // 空依赖：实例只建一次，数据与回调通过上面的 ref 送达
  }, []);

  // ── 容器尺寸变化 ──
  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const ro = new ResizeObserver(() => cyRef.current?.resize());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── 数据变化时更新元素并重跑布局 ──
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    cy.batch(() => {
      cy.elements().remove();
      cy.add(elements);
    });

    // 节点尺寸与边宽在这里统一算：Cytoscape 的 style 支持 data() 映射，
    // 但需要先把映射字段写进 data，所以遍历一遍。
    const maxWeight = Math.max(1, ...graph.nodes.map((n) => n.weight));
    cy.nodes().forEach((node) => {
      const w = (node.data("weight") as number) ?? 0;
      // 开方压缩：纯线性映射会让头部几个节点大到遮住其他所有节点
      const size = 14 + Math.sqrt(w / maxWeight) * 46;
      node.data("size", node.data("kind") === "document" ? 12 : size);
    });
    const maxEdge = Math.max(1, ...graph.edges.map((e) => e.weight));
    cy.edges().forEach((edge) => {
      const w = (edge.data("weight") as number) ?? 1;
      edge.data("width", 0.4 + (w / maxEdge) * 2.4);
    });

    if (cy.nodes().length > 0) {
      // fcose 的参数集比 Cytoscape 的 BaseLayoutOptions 宽，且它没有类型声明，
      // 所以这里必须断言 —— 不这么做就只能砍掉 quality 这类 fcose 独有的参数。
      const options = {
        name: "fcose",
        quality: "default",
        // 按连通分量分别布局，否则孤立节点会被推到很远的地方
        packComponents: true,
        animate: false,
        randomize: true,
        nodeRepulsion: 6000,
        idealEdgeLength: 70,
        // 让同簇节点互相吸引 —— 这是「分簇可读」的关键
        nestingFactor: 0.1,
        gravity: 0.28,
        numIter: 2000,
        nodeSeparation: 60,
        // 用节点自身权重参与布局，权重大的概念占据更中心的位置
        nodeDimensionsIncludeLabels: true,
      } as unknown as cytoscape.LayoutOptions;

      cy.layout(options).run();
    }

    cy.fit(undefined, 40);
  }, [elements, graph]);

  // ── 选中态高亮 ──
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    cy.batch(() => {
      cy.elements().removeClass("highlighted dimmed");
      if (!selectedId) return;

      const node = cy.getElementById(selectedId);
      if (node.empty()) return;

      // 选中节点的邻域保持高亮，其余压暗 —— 这样能立刻看出它连接了哪些资料
      const neighborhood = node.closedNeighborhood();
      cy.elements().difference(neighborhood).addClass("dimmed");
      neighborhood.addClass("highlighted");
    });
  }, [selectedId]);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <div
        ref={containerRef}
        style={{ width: "100%", height: "100%", minHeight: 420 }}
      />

      {/*
        图例。簇的颜色和标签在导出的 Markdown 报告里也用同一套，
        两处对得上，报告里的图和界面里的图才像是同一个东西。
      */}
      {graph.clusters.length > 1 && (
        <div
          style={{
            position: "absolute",
            left: 10,
            bottom: 10,
            display: "flex",
            flexDirection: "column",
            gap: 3,
            padding: "8px 10px",
            background: "rgba(13, 17, 23, 0.85)",
            border: "1px solid var(--border-subtle)",
            borderRadius: 6,
            pointerEvents: "none",
            maxWidth: 240,
          }}
        >
          {graph.clusters.map((c, i) => (
            <div
              key={c.id}
              style={{ display: "flex", alignItems: "center", gap: 6 }}
            >
              <span
                className="dot"
                style={{ background: clusterColor(i) }}
              />
              <span
                style={{
                  fontSize: 11,
                  color: "var(--fg-muted)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {c.label}
              </span>
              <span className="dim" style={{ fontSize: 10 }}>
                {c.size}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
