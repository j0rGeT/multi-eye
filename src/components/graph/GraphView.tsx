"use client";

/**
 * 知识拓扑渲染。
 *
 * Cytoscape + fcose：fcose 是力导向里少数几个能在几百节点规模下保持可读性、
 * 且能按簇聚拢的算法（靠 nodeRepulsion 与 idealEdgeLength 的组合），
 * 这正是知识图需要的 —— 同一个簇的节点应该挨在一起。
 *
 * ── 这一版解决的三个问题 ──
 *
 * 1. **位置会丢**。上一版每次数据变化都 `cy.elements().remove()` + `cy.add()` +
 *    `randomize: true`，而依赖数组里的 `elements` 又跟着 `showDocuments` 变 ——
 *    于是勾一下「显示资料节点」整张图就重新随机一遍，用户手动摆的位置全没了。
 *    现在位置是**我们自己的数据**（`positionsRef`），数据变化走 diff 而不是
 *    推倒重来，重排时用 `fixedNodeConstraint` 把已有节点钉住。
 *
 * 2. **锁定的语义**。知道了位置之后，「锁定」不该只是「别丢我的位置」——
 *    那个所有节点都默认享有。所以锁定被定义为**扛得住「重新布局」**，
 *    这让工具栏上两个按钮各有各的用处：重新布局 = 除锁定外全部重排，
 *    解锁全部 + 重新布局 = 彻底推倒重来。
 *
 * 3. **图是死的**。`animate: false` 让它瞬间出现在最终位置，样式切换没有过渡，
 *    悬停没有任何反馈。现在布局带入场动画、样式带 transition、悬停高亮邻域
 *    并跟一个浮层。
 *
 * ── 性能上的两个关键点（沿用上一版）──
 *
 *  - 增量更新一律用 `cy.batch()` 包住，否则每个元素都触发一次重排，界面会卡死
 *  - 布局只在**节点集合变化**时重跑。选中、悬停、缩放这些交互绝不重跑布局，
 *    否则用户每点一个节点整张图就会重新飞舞一次
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import cytoscape, {
  type Core,
  type ElementDefinition,
  type EventObject,
  type NodeSingular,
  type StylesheetStyle,
} from "cytoscape";
import fcose from "cytoscape-fcose";
import type {
  Cluster,
  Document,
  EdgeKind,
  GraphModel,
  GraphNode,
  SessionViewState,
} from "@/core/types";
import {
  clusterColor,
  clusterIndexMap,
  ENTITY_TYPE_COLORS,
  getGraphTheme,
  type GraphStyleKey,
  type GraphStyleTheme,
} from "@/core/graph/palette";
import { edgeWidth, isCoreNode, nodeSize } from "@/core/graph/geometry";
import { buildYearDimensions, type YearDimensionStat } from "@/core/graph/timeline";
import GraphFilterBar from "./GraphFilterBar";
import GraphLegend from "./GraphLegend";
import GraphToolbar from "./GraphToolbar";
import GraphTooltip, { type TooltipState } from "./GraphTooltip";
import TrendChart from "./TrendChart";

let fcoseRegistered = false;
function ensureFcose() {
  if (fcoseRegistered) return;
  cytoscape.use(fcose);
  fcoseRegistered = true;
}

interface XY {
  x: number;
  y: number;
}

/** 节点超过这个数量就降级布局质量并关掉动画 —— 力导向动画在这个量级只会变成卡顿。 */
const LARGE_GRAPH = 400;

/**
 * 根据当前风格主题构建 Cytoscape 样式表。
 * 所有色彩与描边、线型配置均来自 `palette.ts`，不在组件内硬编码色值。
 */
function buildCyStylesheet(theme: GraphStyleTheme): StylesheetStyle[] {
  return [
    {
      selector: "node",
      style: {
        "background-color": "data(color)",
        "background-opacity": theme.conceptFillOpacity,
        "border-width": theme.conceptBorderWidth,
        "border-color": theme.conceptBorder,
        ...(theme.useDoubleBorder ? { "border-style": "double" } : {}),
        label: "data(displayLabel)",
        "font-size": 9,
        "font-weight": 500,
        color: theme.nodeLabelColor,
        "text-valign": "bottom",
        "text-margin-y": 4,
        "text-max-width": "90px",
        "text-wrap": "ellipsis",
        /*
          外挂小标签防裁切描边遮罩：给文字添加一层背景色的柔和描边，
          阻断从节点下方穿插交叉的连接线切割文字笔画，极大提升文字可读性。
        */
        "text-outline-color": theme.canvasBg,
        "text-outline-width": 2,
        "text-outline-opacity": 0.95,
        width: "data(size)",
        height: "data(size)",
        /*
          包含 underlay-opacity / underlay-padding 的平滑过渡，
          营造 Obsidian/Linear 式呼吸发光与悬停光晕。
        */
        "transition-property":
          "opacity background-color border-color border-width underlay-opacity underlay-padding",
        "transition-duration": 180,
      },
    },
    {
      /**
       * 核心概念大节点 (Core Node, 直径 >= 32px)：
       * 1. 文字居中置于圆心内部 (text-valign: center)，字重加粗 (600)，字号提升至 10.5px；
       * 2. 消除空心大圆圈中空无物、底部挂小细字的生硬感；
       * 3. 注入常态同色系环境光晕 (underlay-color: data(color))。
       */
      selector: "node.core-node",
      style: {
        "text-valign": "center",
        "text-halign": "center",
        "text-margin-y": 0,
        "text-max-width": "data(size)",
        "text-wrap": "ellipsis",
        "font-size": 10.5,
        "font-weight": 600,
        color: theme.coreNodeLabelColor,
        "text-outline-width": 0,
        "underlay-color": "data(color)",
        "underlay-shape": "ellipse",
        "underlay-padding": theme.ambientGlowPadding,
        "underlay-opacity": theme.ambientGlowOpacity,
      },
    },
    {
      /**
       * 文档/资料节点：精致圆形微徽章 (Circle Token) 造型。
       * 彻底抛弃方形/直角/矩形视觉，采用 14px 正圆双环设计，
       * 外圈带发光描边、半透明磨砂质感，与整体拓扑球体美学完全统一。
       */
      selector: 'node[kind = "document"]',
      style: {
        shape: "ellipse",
        width: theme.docDimensions.width,
        height: theme.docDimensions.height,
        "background-color": theme.docFill,
        "background-opacity": theme.docFillOpacity,
        "border-width": theme.docBorderWidth,
        "border-color": theme.docBorder,
        "text-valign": "bottom",
        "text-margin-y": 3,
        "font-size": 7,
        "font-weight": 400,
        color: theme.docLabelColor,
        "text-outline-width": 1.5,
        "text-outline-color": theme.canvasBg,
        "text-outline-opacity": 0.9,
      },
    },
    {
      selector: "edge",
      style: {
        width: "data(width)",
        "line-color": theme.edgeColor,
        "line-style": theme.edgeLineStyle,
        "curve-style": "bezier",
        opacity: theme.edgeOpacity,
        "transition-property": "opacity line-color width",
        "transition-duration": 180,
      },
    },
    {
      /** 共现边：虚线 + 弱化透明度，大幅消除发线团毛球感 */
      selector: 'edge[kind = "cooccur"]',
      style: {
        "line-style": theme.edgeCooccurLineStyle,
        opacity: theme.edgeCooccurOpacity,
      },
    },
    {
      selector: 'edge[kind = "contains"]',
      style: {
        "line-style": theme.edgeContainsLineStyle,
        "line-color": theme.edgeContainsColor,
        opacity: theme.edgeContainsOpacity,
      },
    },
    /*
      关系边（relation）：核心语义关联。实线高亮 + 显式谓词标签。
      把谓词直接标在线上，一眼看出“大模型与高校是研发关系、与技术是实现关系”。
    */
    {
      selector: 'edge[kind = "relation"]',
      style: {
        "line-style": "solid",
        "line-color": theme.edgeRelationColor,
        opacity: theme.edgeRelationOpacity,
        label: "data(label)",
        "font-size": 8.5,
        "font-weight": 600,
        color: theme.relationLabelColor,
        "text-background-color": theme.relationLabelBg,
        "text-background-opacity": 0.88,
        "text-background-padding": "3px",
        "text-rotation": "autorotate",
      },
    },
    // 实体类型边框映射（与簇背景色双层共存：簇色定主题，边框色定身份）
    ...Object.entries(ENTITY_TYPE_COLORS).map(([type, color]) => ({
      selector: `node[type = "${type}"]`,
      style: {
        "border-color": color,
        "border-width": 2.2,
      },
    })),
    // 选中的邻域（点击选中，或悬停时以悬停节点为中心）
    {
      selector: "node.highlighted",
      style: {
        "border-width": 2.5,
        "border-color": theme.highlightBorder,
        opacity: 1,
        "underlay-color": "data(color)",
        "underlay-shape": "ellipse",
        "underlay-padding": theme.activeGlowPadding,
        "underlay-opacity": theme.activeGlowOpacity * 0.75,
      },
    },
    {
      selector: "edge.highlighted",
      style: {
        "line-color": theme.hoverEdgeColor,
        opacity: 0.95,
        width: "mapData(width, 1, 6, 2, 4.5)",
      },
    },
    { selector: ".dimmed", style: { opacity: 0.15 } },
    /*
      悬停压暗比选中更轻（0.35 vs 0.15）：悬停是探索，选中是聚焦。
      两者一样重的话，鼠标随便划过就会把图压得跟真选中了一样。
    */
    { selector: ".hover-dimmed", style: { opacity: 0.35 } },
    {
      selector: "node.hovered",
      style: {
        "border-width": 2.5,
        "border-color": theme.highlightBorder,
        "underlay-color": "data(color)",
        "underlay-shape": "ellipse",
        "underlay-padding": theme.activeGlowPadding,
        "underlay-opacity": theme.activeGlowOpacity,
      },
    },
    {
      selector: "edge.hovered",
      style: {
        "line-color": theme.hoverEdgeColor,
        opacity: 0.95,
        width: "mapData(width, 1, 6, 2, 4.5)",
      },
    },
    // 框选出来的节点（Cytoscape 内建的 :selected）—— 和点击选中的邻域高亮区分开
    {
      selector: "node:selected",
      style: {
        "border-width": 3,
        "border-color": theme.selectedBorder,
        "border-opacity": 1,
        "underlay-color": theme.selectedBorder,
        "underlay-shape": "ellipse",
        "underlay-padding": theme.activeGlowPadding,
        "underlay-opacity": 0.45,
      },
    },
  ];
}

export interface GraphViewProps {
  graph: GraphModel;
  /** 当前选中的节点 id，用于高亮。 */
  selectedId?: string;
  onSelect: (node: GraphNode | null) => void;
  /** 只显示关键词（隐藏文档节点）——文档多的时候图会很挤。 */
  showDocuments: boolean;
  /** 拓扑图色彩风格 */
  graphStyle?: GraphStyleKey;
  /** 切换拓扑图色彩风格 */
  onStyleChange?: (style: GraphStyleKey) => void;
  /** 上次离开时的布局：节点位置与锁定集合。只在挂载时读一次。 */
  initialView?: SessionViewState;
  /** 位置变化后回调（已 debounce）。保存失败由调用方静默处理。 */
  onViewChange?: (view: SessionViewState) => void;
  /** 已抓取资料，用于文档节点双击时直接打开本地预览。 */
  documents?: Document[];
  /** 双击文档节点时打开预览。 */
  onOpenDocument?: (doc: Document) => void;
  /** 拓扑空间维度："2d" | "3d" */
  dimensionMode?: "2d" | "3d";
  /** 切换 2D / 3D 维度模式 */
  onToggleDimension?: () => void;
}

export default function GraphView({
  graph,
  selectedId,
  onSelect,
  showDocuments,
  graphStyle = "default",
  onStyleChange,
  initialView,
  onViewChange,
  documents,
  onOpenDocument,
  dimensionMode = "2d",
  onToggleDimension,
}: GraphViewProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);

  /** 权威位置表。Cytoscape 实例里的位置是它的，这里这份才是我们的。 */
  const positionsRef = useRef<Map<string, XY>>(new Map());
  /** 用户显式锁定的节点：扛得住「重新布局」。 */
  const pinnedRef = useRef<Set<string>>(new Set());

  /**
   * 最新的 graph / onSelect / 选中态经 ref 转发给 Cytoscape 的事件回调。
   *
   * 为什么必须这么做：事件回调是「创建实例」那一刻注册的，把这些放进那个
   * effect 的依赖里，数据每更新一次就要销毁重建整个 Cytoscape 实例 ——
   * 用户的缩放、平移、拖拽位置全丢。用 ref 之后实例只建一次。
   */
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const selectedIdRef = useRef<string | undefined>(selectedId);
  selectedIdRef.current = selectedId;
  const showDocumentsRef = useRef(showDocuments);
  showDocumentsRef.current = showDocuments;
  const documentsRef = useRef(documents ?? []);
  documentsRef.current = documents ?? [];
  const onOpenDocumentRef = useRef(onOpenDocument);
  onOpenDocumentRef.current = onOpenDocument;
  const hoverRef = useRef<string | null>(null);
  const initialViewRef = useRef(initialView);
  /** 首次布局才自动 fit；之后 fit 会毁掉用户当前的缩放与平移。 */
  const fittedRef = useRef(false);

  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [boxSelect, setBoxSelect] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [selectedCount, setSelectedCount] = useState(0);
  const [pinnedCount, setPinnedCount] = useState(0);
  const [yearDimensions, setYearDimensions] = useState<YearDimensionStat[]>([]);
  const [layoutMode, setLayoutMode] = useState<"free" | "yearly">(
    initialView?.layoutMode ?? "free",
  );
  const [showTimeline, setShowTimeline] = useState<boolean>(
    initialView?.showTimeline ?? true,
  );
  const [hiddenNodeTypes, setHiddenNodeTypes] = useState<Set<string>>(
    () => new Set(initialView?.hiddenNodeTypes ?? []),
  );
  const [hiddenEdgeKinds, setHiddenEdgeKinds] = useState<Set<EdgeKind>>(
    () => new Set(initialView?.hiddenEdgeKinds ?? []),
  );

  const layoutModeRef = useRef<"free" | "yearly">(layoutMode);
  layoutModeRef.current = layoutMode;
  const showTimelineRef = useRef<boolean>(showTimeline);
  showTimelineRef.current = showTimeline;
  const hiddenNodeTypesRef = useRef(hiddenNodeTypes);
  hiddenNodeTypesRef.current = hiddenNodeTypes;
  const hiddenEdgeKindsRef = useRef(hiddenEdgeKinds);
  hiddenEdgeKindsRef.current = hiddenEdgeKinds;
  const graphStyleRef = useRef<GraphStyleKey>(graphStyle);
  graphStyleRef.current = graphStyle;
  const theme = useMemo(() => getGraphTheme(graphStyle), [graphStyle]);

  const clusterLabelById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of graph.clusters) m.set(c.id, c.label);
    return m;
  }, [graph.clusters]);
  // 同样必须走 ref：浮层回调在「创建实例」时注册，直接闭包捕获会让
  // 簇一变就重建整个 Cytoscape 实例
  const clusterLabelsRef = useRef(clusterLabelById);
  clusterLabelsRef.current = clusterLabelById;

  // ── 把 GraphModel 翻译成 Cytoscape 元素 ──
  //
  // useMemo 而不是在 effect 里现算：元素数组每次渲染都重建的话，下面的
  // effect 会误判成「数据变了」而反复重跑布局。
  const { nodeDefs, edgeDefs } = useMemo(() => {
    const clusterIndex = clusterIndexMap(graph.clusters);
    const maxWeight = Math.max(1, ...graph.nodes.map((n) => n.weight));
    const maxEdge = Math.max(1, ...graph.edges.map((e) => e.weight));

    const visibleNodes = graph.nodes.filter((n) => {
      if (!showDocuments && n.kind === "document") return false;
      // 实体类型过滤：如果节点的 type 在隐藏列表中，则不展示
      if (n.type && hiddenNodeTypes.has(n.type)) return false;
      return true;
    });

    const nodes: ElementDefinition[] = visibleNodes.map((n) => {
      const yearLabel = n.publishedYear ? ` [${n.publishedYear}${n.isYearInferred ? "*" : ""}]` : "";
      const size = nodeSize(n.weight, maxWeight, n.kind);
      const isCore = isCoreNode(size, n.kind);
      return {
        data: {
          id: n.id,
          label: n.label,
          displayLabel: `${n.label}${layoutMode === "yearly" ? yearLabel : ""}`,
          publishedYear: n.publishedYear,
          isYearInferred: n.isYearInferred,
          kind: n.kind,
          type: n.type,
          weight: n.weight,
          degree: n.degree,
          clusterId: n.clusterId,
          color: clusterColor(clusterIndex.get(n.clusterId) ?? 0, graphStyle),
          size,
        },
        classes: [
          n.kind === "document" ? "document-node" : "concept-node",
          isCore ? "core-node" : "leaf-node",
        ].join(" "),
      };
    });

    const visible = new Set(visibleNodes.map((n) => n.id));

    const edges: ElementDefinition[] = graph.edges
      .filter((e) => {
        if (!visible.has(e.source) || !visible.has(e.target)) return false;
        // 边类型过滤：如果边的 kind 在隐藏列表中，则不展示
        if (hiddenEdgeKinds.has(e.kind)) return false;
        return true;
      })
      .map((e) => ({
        data: {
          id: e.id,
          source: e.source,
          target: e.target,
          kind: e.kind,
          weight: e.weight,
          width: edgeWidth(e.weight, maxEdge),
          label: e.label ?? "",
        },
      }));

    return { nodeDefs: nodes, edgeDefs: edges };
  }, [graph, showDocuments, layoutMode, graphStyle, hiddenNodeTypes, hiddenEdgeKinds]);

  // ── 位置持久化（debounce）──
  const saveTimer = useRef<number | null>(null);
  const onViewChangeRef = useRef(onViewChange);
  onViewChangeRef.current = onViewChange;

  const flushView = useCallback(() => {
    // 只报当前图里还存在的节点：否则换个主题之后位置表会一直堆着上一个主题的节点
    const live = new Set(graphRef.current.nodes.map((n) => n.id));
    const positions: Record<string, XY> = {};
    for (const [id, p] of positionsRef.current) {
      if (live.has(id)) positions[id] = p;
    }
    const pinned = [...pinnedRef.current].filter((id) => live.has(id));
    onViewChangeRef.current?.({
      positions,
      pinned,
      showDocuments: showDocumentsRef.current,
      layoutMode: layoutModeRef.current,
      showTimeline: showTimelineRef.current,
      hiddenNodeTypes: [...hiddenNodeTypesRef.current],
      hiddenEdgeKinds: [...hiddenEdgeKindsRef.current],
    });
  }, []);

  const scheduleSave = useCallback(() => {
    if (!onViewChangeRef.current) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    // 拖动过程中每帧都发请求会把服务端淹掉，攒一下再发
    saveTimer.current = window.setTimeout(flushView, 800);
  }, [flushView]);

  const scheduleSaveRef = useRef(scheduleSave);
  scheduleSaveRef.current = scheduleSave;

  // ── 创建实例（只在挂载时一次）──
  useEffect(() => {
    ensureFcose();
    if (!containerRef.current) return;

    // 从上次离开的位置恢复。挂载时读一次就够，之后由用户操作驱动。
    const iv = initialViewRef.current;
    if (iv?.positions) {
      for (const [id, p] of Object.entries(iv.positions)) {
        if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
          positionsRef.current.set(id, { x: p.x, y: p.y });
        }
      }
    }
    if (iv?.pinned) pinnedRef.current = new Set(iv.pinned);

    const cy = cytoscape({
      container: containerRef.current,
      elements: [],
      wheelSensitivity: 0.2,
      // 平移与框选在 Cytoscape 里可以共存：开着平移时框选需要按 Shift。
      // 「框选模式」按钮做的是把平移关掉，让拖拽直接就是框选。
      boxSelectionEnabled: true,
      style: buildCyStylesheet(getGraphTheme(graphStyleRef.current)),
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

    /*
      双击 → 文档节点直接打开本地资料详情，其它节点把邻域放大到填满视野。

      单击仍然只做选中：右栏可以先看清这个节点连了什么，再决定要不要打开正文。
      这样既保留了原来的导航动作，也给「资料节点」补上一条直达预览的路径。
    */
    cy.on("dbltap", "node", (evt) => {
      const node = evt.target as NodeSingular;
      const gn = graphRef.current.nodes.find((n) => n.id === node.id());
      if (gn?.kind === "document") {
        const doc = documentsRef.current.find((d) => gn.docIds.includes(d.id));
        if (doc) {
          onSelectRef.current(gn);
          onOpenDocumentRef.current?.(doc);
          return;
        }
      }
      cy.animate({
        fit: { eles: node.closedNeighborhood(), padding: 50 },
        duration: 500,
        easing: "ease-out-cubic",
      });
    });

    // ── 悬停：高亮邻域 + 浮层 ──
    const showTooltip = (evt: EventObject) => {
      const node = evt.target as NodeSingular;
      const gn = graphRef.current.nodes.find((n) => n.id === node.id());
      if (!gn) return;
      const p = node.renderedPosition();
      const box = containerRef.current?.getBoundingClientRect();
      const w = box?.width ?? 0;
      const h = box?.height ?? 0;
      setTooltip({
        x: p.x,
        y: p.y,
        node: gn,
        clusterLabel: clusterLabelsRef.current.get(gn.clusterId),
        // 贴近边缘就翻到另一侧，否则浮层会被容器裁掉
        flipX: w > 0 && p.x > w - 260,
        flipY: h > 0 && p.y > h - 120,
      });
    };

    cy.on("mouseover", "node", (evt) => {
      hoverRef.current = (evt.target as NodeSingular).id();
      applyEmphasis(cy, selectedIdRef.current ?? null, hoverRef.current);
      showTooltip(evt);
    });
    cy.on("mousemove", "node", (evt) => {
      if (hoverRef.current) showTooltip(evt);
    });
    cy.on("mouseout", "node", () => {
      hoverRef.current = null;
      applyEmphasis(cy, selectedIdRef.current ?? null, null);
      setTooltip(null);
    });

    // ── 位置记账 ──
    cy.on("free", "node", (evt) => {
      const node = evt.target as NodeSingular;
      const p = node.position();
      positionsRef.current.set(node.id(), { x: p.x, y: p.y });
      scheduleSaveRef.current();
    });
    cy.on("layoutstop", () => {
      cy.nodes().forEach((n) => {
        const p = n.position();
        positionsRef.current.set(n.id(), { x: p.x, y: p.y });
      });
      scheduleSaveRef.current();
    });

    cy.on("select unselect", "node", () => {
      setSelectedCount(cy.nodes(":selected").length);
    });

    cyRef.current = cy;
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      cy.destroy();
      cyRef.current = null;
    };
    // 空依赖：实例只建一次，数据与回调通过上面的 ref 送达
  }, []);

  // ── 容器尺寸变化 ──
  //
  // 只调 cy.resize() 是不够的：画布变宽了，但视口（pan/zoom）还停在原地，
  // 于是节点全挤在左边半屏，右边一片空白 —— 用户收掉两侧栏正是为了把宽度
  // 让给图，结果白白浪费。所以这里要跟着调整视口，分两种情况：
  //
  //   原本整张图就在视野里（用户没往里缩放过）→ 重新适应窗口，图跟着变大
  //   用户在某个细节上放大了        → 只保持**视野中心**不变，不打断他
  //
  // 后者是必须的：无脑重排会把用户的缩放进度推倒，他每拖一下窗口就白缩放了。
  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    let prev = { w: 0, h: 0 };

    const ro = new ResizeObserver(() => {
      const cy = cyRef.current;
      if (!cy) return;
      cy.resize();
      const w = cy.width();
      const h = cy.height();
      if (w === 0 || h === 0 || (w === prev.w && h === prev.h)) return;

      // 首次回调只记尺寸：那时布局还没跑完，任何 fit 都会在下一帧作废
      if (prev.w > 0 && fittedRef.current) {
        const bb = cy.elements().renderedBoundingBox();
        const slack = 12;
        const wasFullyVisible =
          bb.x1 >= -slack &&
          bb.y1 >= -slack &&
          bb.x2 <= prev.w + slack &&
          bb.y2 <= prev.h + slack;

        if (wasFullyVisible) {
          cy.animate({
            fit: { eles: cy.elements(), padding: 40 },
            duration: 300,
            easing: "ease-out-cubic",
          });
        } else {
          // 把旧视口中心对应的模型坐标，重新摆到新视口的中心
          const z = cy.zoom();
          const pan = cy.pan();
          const modelX = (prev.w / 2 - pan.x) / z;
          const modelY = (prev.h / 2 - pan.y) / z;
          cy.pan({ x: w / 2 - modelX * z, y: h / 2 - modelY * z });
        }
      }
      prev = { w, h };
    });

    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── 全屏状态（用户按 Esc 退出也要跟上）──
  useEffect(() => {
    const on = () => setFullscreen(document.fullscreenElement === panelRef.current);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);

  // ── 数据变化：diff 更新 + 按需重排 ──
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    const wantedNodes = new Map(nodeDefs.map((d) => [d.data.id as string, d]));
    let added = 0;
    let removed = 0;

    cy.batch(() => {
      // 节点做 diff：已存在的原地更新 data，位置天然保留（这是「位置不丢」的关键）
      const stale = cy.nodes().filter((n) => !wantedNodes.has(n.id()));
      removed = stale.length;
      stale.remove();
      for (const def of nodeDefs) {
        const el = cy.getElementById(def.data.id as string);
        if (el.empty()) {
          cy.add(def);
          added += 1;
        } else {
          el.data(def.data);
        }
      }
      /*
        边全部重建，不做 diff。边没有位置可保，而它的 source/target 变了的话
        Cytoscape 不允许原地改 —— 与其写一段判重逻辑，不如直接重来，成本可以忽略。
        必须放在节点之后：边引用不存在的节点会报错。
      */
      cy.edges().remove();
      cy.add(edgeDefs);
    });

    // 位置表只保留当前图里还存在的节点。
    // 注意是按 graph.nodes 而不是可见节点裁剪 —— 否则切一下「显示资料节点」，
    // 被隐藏的那些节点的位置就被自己删掉了，再开回来只能重新布局。
    const live = new Set(graphRef.current.nodes.map((n) => n.id));
    for (const id of [...positionsRef.current.keys()]) {
      if (!live.has(id)) positionsRef.current.delete(id);
    }

    /*
      节点集合变了就记一笔 —— 收起资料节点时只有删除、没有新增，不会触发布局，
      但那同样是「用户改了什么」，得存。放在这里而不是只挂在 layoutstop 上，
      是为了让「隐藏资料节点」这个开关也进 session.viewState。
    */
    if (removed > 0 || added > 0) scheduleSaveRef.current();

    // 布局只在**新增**了节点时重跑。只删节点、只改边、只改选中态都轮不到它 ——
    // 删掉几个孤立节点就重排整张图，是上一版最招人烦的行为之一。
    if (added === 0) return;

    // 把已知位置先贴回去，否则恢复出来的节点会从原点飞过来
    cy.nodes().forEach((n) => {
      const p = positionsRef.current.get(n.id());
      if (p) n.position(p);
    });

    if (layoutModeRef.current === "yearly") {
      setYearDimensions(buildYearDimensions(graph.nodes));
    } else {
      setYearDimensions([]);
    }

    runLayout(
      cy,
      fittedRef.current ? "keep" : "initial",
      positionsRef.current,
      pinnedRef.current,
      graphRef.current,
      layoutModeRef.current,
    );

    if (!fittedRef.current) {
      fittedRef.current = true;
      cy.animate({
        fit: { eles: cy.elements(), padding: 40 },
        duration: 600,
        easing: "ease-out-cubic",
      });
    }
  }, [nodeDefs, edgeDefs, graph]);

  // ── 风格变化：原地更新样式表，不重跑布局 ──
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.style(buildCyStylesheet(theme));
  }, [theme]);

  // ── 选中态高亮 ──
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    applyEmphasis(cy, selectedId ?? null, hoverRef.current);
  }, [selectedId]);

  // ── 工具栏动作 ──

  /** 重新布局：锁定外的全部重排。这是「我摆乱了，重来」的出口。 */
  const handleRelayout = useCallback(() => {
    const cy = cyRef.current;
    if (!cy) return;
    runLayout(cy, "full", positionsRef.current, pinnedRef.current, graphRef.current, layoutModeRef.current);
  }, []);

  /** 切换按年份分层布局 */
  const handleToggleYearlyLayout = useCallback(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const nextMode = layoutModeRef.current === "yearly" ? "free" : "yearly";
    setLayoutMode(nextMode);
    layoutModeRef.current = nextMode;
    if (nextMode === "yearly") {
      setYearDimensions(buildYearDimensions(graphRef.current.nodes));
    } else {
      setYearDimensions([]);
    }
    scheduleSaveRef.current();
    runLayout(cy, "full", positionsRef.current, pinnedRef.current, graphRef.current, nextMode);
  }, []);

  /** 切换下方节点时序折线图 */
  const handleToggleTimeline = useCallback(() => {
    setShowTimeline((prev) => {
      const next = !prev;
      showTimelineRef.current = next;
      scheduleSaveRef.current();
      return next;
    });
  }, []);

  const handleFit = useCallback(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.animate({
      fit: { eles: cy.elements(), padding: 40 },
      duration: 400,
      easing: "ease-out-cubic",
    });
  }, []);

  const handlePinSelected = useCallback(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.nodes(":selected").forEach((n) => {
      pinnedRef.current.add(n.id());
      const p = n.position();
      positionsRef.current.set(n.id(), { x: p.x, y: p.y });
    });
    setPinnedCount(pinnedRef.current.size);
    scheduleSaveRef.current();
    applyEmphasis(cy, selectedIdRef.current ?? null, hoverRef.current);
  }, []);

  const handleUnpinAll = useCallback(() => {
    pinnedRef.current.clear();
    setPinnedCount(0);
    scheduleSaveRef.current();
  }, []);

  const handleExportPng = useCallback(() => {
    const cy = cyRef.current;
    const host = containerRef.current;
    if (!cy || !host) return;
    // 收起侧栏时容器宽度为 0，直接出图会得到一张空白
    cy.resize();

    const frame = exportFrame(cy);
    const fw = Math.max(1, frame.x2 - frame.x1);
    const fh = Math.max(1, frame.y2 - frame.y1);
    const pad = Math.max(28, Math.max(fw, fh) * 0.06);

    /*
      画布尺寸跟着取景框的宽高比走。

      不跟的话，一张宽高比 4:1 的图会被塞进近方形的画布里，上下留出两大块
      空白 —— 图本身没变，但看的人只会觉得「怎么这么小」。这里让画布就是
      取景框放大后的样子，空白只由 pad 控制。
    */
    const longest = 1400;
    const k = longest / Math.max(fw, fh);
    const cw = Math.max(320, Math.round(fw * k));
    const ch = Math.max(320, Math.round(fh * k));

    const prevStyle = host.getAttribute("style") ?? "";
    const prevZoom = cy.zoom();
    const prevPan = { ...cy.pan() };

    try {
      /*
        把画布临时挪到屏幕外、换成取景框的形状。

        这一整段是**同步**的：改样式 → resize → 定视口 → 抓图 → 还原，浏览器
        中间不会重绘，所以用户看不到任何抖动。用 position:absolute 是为了让
        面板的 flex 布局别来掺和尺寸。
      */
      host.style.cssText = `position:absolute;left:-99999px;top:0;width:${cw}px;height:${ch}px;`;
      cy.resize();

      // 让取景框恰好落在画布中间，四周各留 pad
      const z = Math.min(
        cy.width() / (fw + pad * 2),
        cy.height() / (fh + pad * 2),
      );
      cy.zoom(z);
      cy.pan({
        x: cy.width() / 2 - (frame.x1 + fw / 2) * z,
        y: cy.height() / 2 - (frame.y1 + fh / 2) * z,
      });

      const currentTheme = getGraphTheme(graphStyleRef.current);
      const url = cy.png({ scale: 2, bg: currentTheme.canvasBg });
      const a = document.createElement("a");
      a.href = url;
      a.download = `${graphRef.current.topic.query || "topology"}-拓扑.png`;
      a.click();
    } finally {
      // 还原：样式、画布尺寸、用户原来的视口，一个都不能少
      host.setAttribute("style", prevStyle);
      cy.resize();
      cy.zoom(prevZoom);
      cy.pan(prevPan);
    }
  }, []);

  const handleToggleBoxSelect = useCallback(() => {
    const cy = cyRef.current;
    if (!cy) return;
    setBoxSelect((prev) => {
      const next = !prev;
      // 框选模式下必须关掉平移，否则用户按住一拖，图跑了而不是框出来了
      cy.userPanningEnabled(!next);
      return next;
    });
  }, []);

  const handleFullscreen = useCallback(() => {
    if (document.fullscreenElement === panelRef.current) {
      void document.exitFullscreen();
    } else {
      void panelRef.current?.requestFullscreen();
    }
  }, []);

  /** 点图例 → 聚焦该簇。用簇内部节点 + 它们之间的边取景，不带上外部邻居。 */
  const handleFocusCluster = useCallback((cluster: Cluster) => {
    const cy = cyRef.current;
    if (!cy) return;
    const nodes = cy.collection();
    for (const id of cluster.nodeIds) {
      const n = cy.getElementById(id);
      if (n.nonempty()) nodes.merge(n);
    }
    if (nodes.empty()) return;
    cy.animate({
      fit: { eles: nodes.union(nodes.edgesWith(nodes)), padding: 60 },
      duration: 500,
      easing: "ease-out-cubic",
    });
  }, []);

  // ── 节点类型与边类型过滤回调 ──
  const handleToggleNodeType = useCallback((type: string) => {
    setHiddenNodeTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      hiddenNodeTypesRef.current = next;
      scheduleSaveRef.current();
      return next;
    });
  }, []);

  const handleResetNodeTypes = useCallback(() => {
    setHiddenNodeTypes(new Set());
    hiddenNodeTypesRef.current = new Set();
    scheduleSaveRef.current();
  }, []);

  const handleToggleEdgeKind = useCallback((kind: EdgeKind) => {
    setHiddenEdgeKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      hiddenEdgeKindsRef.current = next;
      scheduleSaveRef.current();
      return next;
    });
  }, []);

  const handleShowOnlyRelations = useCallback(() => {
    const next = new Set<EdgeKind>(["cooccur", "contains"]);
    setHiddenEdgeKinds(next);
    hiddenEdgeKindsRef.current = next;
    scheduleSaveRef.current();
  }, []);

  const handleResetEdgeKinds = useCallback(() => {
    setHiddenEdgeKinds(new Set());
    hiddenEdgeKindsRef.current = new Set();
    scheduleSaveRef.current();
  }, []);

  // 当前图中出现的节点类型与边类型统计
  const { availableNodeTypes, nodeTypeCounts, edgeKindCounts } = useMemo(() => {
    const types: Record<string, number> = {};
    for (const n of graph.nodes) {
      if (n.type) {
        types[n.type] = (types[n.type] ?? 0) + 1;
      }
    }

    const edges: Record<EdgeKind, number> = {
      relation: 0,
      cooccur: 0,
      contains: 0,
    };
    for (const e of graph.edges) {
      if (e.kind in edges) {
        edges[e.kind] += 1;
      }
    }

    return {
      availableNodeTypes: Object.keys(types),
      nodeTypeCounts: types,
      edgeKindCounts: edges,
    };
  }, [graph]);

  return (
    <div
      ref={panelRef}
      className="graph-canvas"
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        position: "relative",
        background: theme.canvasBg,
        transition: "background 0.18s",
      }}
    >
      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        <div
          ref={containerRef}
          className={`graph-cy${boxSelect ? " box-select" : ""}`}
        />

        <GraphFilterBar
          availableNodeTypes={availableNodeTypes}
          nodeTypeCounts={nodeTypeCounts}
          hiddenNodeTypes={hiddenNodeTypes}
          onToggleNodeType={handleToggleNodeType}
          onResetNodeTypes={handleResetNodeTypes}
          edgeKindCounts={edgeKindCounts}
          hiddenEdgeKinds={hiddenEdgeKinds}
          onToggleEdgeKind={handleToggleEdgeKind}
          onShowOnlyRelations={handleShowOnlyRelations}
          onResetEdgeKinds={handleResetEdgeKinds}
        />

        <GraphToolbar
          onRelayout={handleRelayout}
          onFit={handleFit}
          onPinSelected={handlePinSelected}
          onUnpinAll={handleUnpinAll}
          onExportPng={handleExportPng}
          onToggleBoxSelect={handleToggleBoxSelect}
          onFullscreen={handleFullscreen}
          onToggleYearlyLayout={handleToggleYearlyLayout}
          layoutMode={layoutMode}
          onToggleTimeline={handleToggleTimeline}
          showTimeline={showTimeline}
          dimensionMode={dimensionMode}
          onToggleDimension={onToggleDimension}
          graphStyle={graphStyle}
          onStyleChange={onStyleChange}
          boxSelect={boxSelect}
          selectedCount={selectedCount}
          pinnedCount={pinnedCount}
          fullscreen={fullscreen}
        />

        <GraphTooltip state={tooltip} />

        <GraphLegend
          clusters={graph.clusters}
          onFocus={handleFocusCluster}
          graphStyle={graphStyle}
        />

        {layoutMode === "yearly" && yearDimensions.length > 0 && (
          <div
            style={{
              position: "absolute",
              left: 12,
              top: 54,
              zIndex: 3,
              display: "flex",
              flexDirection: "column",
              gap: 5,
              maxWidth: 240,
              maxHeight: "calc(100% - 110px)",
              overflowY: "auto",
              padding: "8px 10px",
              background: "rgba(13, 17, 23, 0.88)",
              border: "1px solid var(--border-subtle)",
              borderRadius: 6,
              backdropFilter: "blur(6px)",
              fontSize: 11,
              pointerEvents: "auto",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                fontWeight: 600,
                color: "var(--fg)",
                borderBottom: "1px solid var(--border-subtle)",
                paddingBottom: 4,
                marginBottom: 2,
              }}
            >
              <span>年份分层维度 (最近10年)</span>
              <span className="dim" style={{ fontSize: 10 }}>共 {yearDimensions.length} 个维度</span>
            </div>
            {yearDimensions.map((yd) => (
              <div
                key={yd.key}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                  padding: "3px 4px",
                  borderRadius: 4,
                  background: "rgba(255, 255, 255, 0.03)",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontWeight: 600, color: "var(--accent)" }}>{yd.key}</span>
                  <span className="dim" style={{ fontSize: 10 }}>
                    {yd.conceptCount} 概念 · {yd.documentCount} 资料
                  </span>
                </div>
                {yd.topConcepts.length > 0 && (
                  <div
                    className="dim"
                    style={{
                      fontSize: 10,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={yd.topConcepts.join("、")}
                  >
                    核心: {yd.topConcepts.join("、")}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {fullscreen && graph.clusters.length > 1 && (
          <div className="graph-fs-hint">按 Esc 退出全屏</div>
        )}
      </div>

      {showTimeline && documents && documents.length > 0 && (
        <div
          style={{
            flex: "0 0 auto",
            borderTop: "1px solid var(--border-subtle)",
            padding: "8px 12px",
            background: "var(--bg-panel)",
            maxHeight: 240,
            overflowY: "auto",
          }}
        >
          <TrendChart
            graph={graph}
            documents={documents}
            selectedId={selectedId}
            onSelectNode={(nodeId) => {
              const node = graph.nodes.find((n) => n.id === nodeId) ?? null;
              onSelect(node);
            }}
          />
        </div>
      )}
    </div>
  );
}

// ─────────────────────────── 布局 ───────────────────────────

type LayoutMode = "initial" | "keep" | "full";

/**
 * 跑一次 fcose。
 *
 * 三种模式的区别**只在于钉住哪些节点**：
 *  - `initial` / `keep` —— 钉住所有已知位置的节点。数据变化时用户看到的东西
 *    一个都不动，新节点围绕既有结构生长。
 *  - `full` —— 只钉住用户锁定的节点，其余全部重排。
 *
 * 为什么用 `fixedNodeConstraint` 而不是 `node.lock()`：lock 是和布局算法较劲，
 * 布局会把锁住的节点当障碍物绕开，形状会别扭；约束是直接告诉算法「这些位置
 * 是给定的」，收敛结果自然得多。
 */
function runLayout(
  cy: Core,
  mode: LayoutMode,
  positions: Map<string, XY>,
  pinned: Set<string>,
  graphModel?: GraphModel,
  yearlyMode: "free" | "yearly" = "free",
) {
  const large = cy.nodes().length > LARGE_GRAPH;

  // ── 年份分层布局特殊处理（最大 10 年，超出归入基准层）──
  if (yearlyMode === "yearly" && graphModel) {
    const nodeMap = new Map<string, GraphNode>(graphModel.nodes.map((n) => [n.id, n]));
    const yearsSet = new Set<number>();
    cy.nodes().forEach((n) => {
      const gn = nodeMap.get(n.id());
      if (gn?.publishedYear) yearsSet.add(gn.publishedYear);
    });

    const sortedYears = [...yearsSet].sort((a, b) => b - a); // 降序：最新的年份排在最上面
    // 严格限制最大 10 年分层
    const top10Years = sortedYears.slice(0, 10);
    const cutoffYear = top10Years[top10Years.length - 1];
    const hasOlder = sortedYears.length > 10;

    const yearBandMap = new Map<number, number>();
    top10Years.forEach((yr, idx) => yearBandMap.set(yr, idx));
    const olderBandIndex = top10Years.length; // 早于 10 年的历史基准层
    const unknownBandIndex = hasOlder ? olderBandIndex + 1 : olderBandIndex; // 无年份的排在最底层

    const BAND_HEIGHT = 220;
    const bandTargetY = new Map<string, number>();

    // 按年份分桶，在每层内横向均匀排布并适度抖动，避免节点重叠
    const bandNodes = new Map<number, string[]>();
    cy.nodes().forEach((n) => {
      const gn = nodeMap.get(n.id());
      let bandIdx: number;
      if (!gn?.publishedYear) {
        bandIdx = unknownBandIndex;
      } else if (yearBandMap.has(gn.publishedYear)) {
        bandIdx = yearBandMap.get(gn.publishedYear)!;
      } else if (hasOlder && gn.publishedYear < cutoffYear) {
        bandIdx = olderBandIndex;
      } else {
        bandIdx = unknownBandIndex;
      }

      const list = bandNodes.get(bandIdx) ?? [];
      list.push(n.id());
      bandNodes.set(bandIdx, list);
    });

    cy.batch(() => {
      for (const [bandIdx, nodeIds] of bandNodes.entries()) {
        const targetY = bandIdx * BAND_HEIGHT;
        const total = nodeIds.length;
        const SPACING = 140;
        const startX = -((total - 1) * SPACING) / 2;

        nodeIds.forEach((id, index) => {
          // 如果节点已被用户锁定钉住，保持其 X 坐标不动，仅在 Y 轴规整对齐到该年份
          const p = positions.get(id);
          const isPinned = pinned.has(id);
          const targetX = isPinned && p ? p.x : startX + index * SPACING;
          bandTargetY.set(id, targetY);
          const node = cy.getElementById(id);
          node.position({ x: targetX, y: targetY });
          positions.set(id, { x: targetX, y: targetY });
        });
      }
    });

    // 运行力导向让有连线的节点在 X 轴向邻居靠拢，并限制迭代收敛
    const options = {
      name: "fcose",
      quality: "default",
      packComponents: true,
      animate: !large,
      animationDuration: 400,
      randomize: false,
      nodeRepulsion: 4500,
      idealEdgeLength: 70,
      gravity: 0.2,
      numIter: 300,
    } as unknown as cytoscape.LayoutOptions;

    // 清除此前可能遗留的 yearly 回吸监听器，避免在模式快速切换时串扰下一次自由布局
    cy.removeListener("layoutstop.yearly");

    // 布局动画结束后再次将 Y 轴稳稳吸附回该年份层，确保时间层次分明
    cy.one("layoutstop.yearly", () => {
      cy.batch(() => {
        cy.nodes().forEach((n) => {
          const y = bandTargetY.get(n.id());
          if (y !== undefined) {
            n.position("y", y);
            positions.set(n.id(), { x: n.position("x"), y });
          }
        });
      });
    });

    try {
      cy.layout(options).run();
    } catch {
      // 容错：若极端情况下 fcose 抛错，直接保留已计算完成的精确分层坐标
      cy.nodes().forEach((n) => {
        const y = bandTargetY.get(n.id());
        if (y !== undefined) {
          n.position("y", y);
          positions.set(n.id(), { x: n.position("x"), y });
        }
      });
    }
    return;
  }

  // 切入自由布局时清除此前 yearly 分层残留的监听器，确保不受上一次动画结束回吸干扰
  cy.removeListener("layoutstop.yearly");

  const isFixed = (id: string) =>
    mode === "full" ? pinned.has(id) : positions.has(id);

  const fixedIds: string[] = [];
  cy.nodes().forEach((n) => {
    if (isFixed(n.id())) fixedIds.push(n.id());
  });

  const anchors = fixedIds.map((id) => {
    const p = positions.get(id);
    const node = cy.getElementById(id);
    return {
      nodeId: id,
      position: p ?? { x: node.position("x"), y: node.position("y") },
    };
  });

  /*
    没被钉住的节点先打散到已有结构的质心周围。

    为什么必须打散：fcose 的 randomize 关掉之后是从**当前位置**出发迭代的。
    initial/keep 模式下新节点默认落在原点，会挤成一坨再慢慢推开；而 full 模式
    下如果从当前位置出发，力导向会收敛回几乎一样的结果 —— 「重新布局」看起来
    就像没反应。打散一次，两种模式都得到该有的行为。
  */
  const fixedSet = new Set(fixedIds);
  let sumX = 0;
  let sumY = 0;
  let anchorCount = 0;
  cy.nodes().forEach((n) => {
    if (!fixedSet.has(n.id())) return;
    sumX += n.position("x");
    sumY += n.position("y");
    anchorCount += 1;
  });
  const cx = anchorCount > 0 ? sumX / anchorCount : 0;
  const cy0 = anchorCount > 0 ? sumY / anchorCount : 0;
  const radius = 260;
  cy.nodes().forEach((n) => {
    if (fixedSet.has(n.id())) return;
    const angle = Math.random() * Math.PI * 2;
    const r = radius * (0.35 + Math.random() * 0.65);
    n.position({ x: cx + Math.cos(angle) * r, y: cy0 + Math.sin(angle) * r });
  });

  const options = {
    name: "fcose",
    /*
      quality 恒为 default，不能按图大小降级成 draft。

      draft 只跑谱布局，而谱布局只在 randomize:true 时才算出来 —— 我们必须
      randomize:false（既有节点不动、新节点围绕既有结构生长），于是 spectralResult
      是空的，fcose 在 relocateComponent 里读 componentResult.nodeIndexes 直接抛
      「Cannot read properties of undefined (reading 'nodeIndexes')」。
      就算有 fixedNodeConstraint 把那次读躲过去，draft + randomize:false 也是 fcose
      自己写明的矛盾组合（它会打日志让你改回 default/proof），布局等于空跑 ——
      大图点「重新布局」看起来就像没反应。代价是大图跑完整 CoSE，
      由下面的 numIter 收敛上限兜住耗时。
    */
    quality: "default",
    /*
      有固定约束时关掉 packComponents。

      实测说明（`fixedNodeConstraint` + packComponents:true，两个不连通分量）：
      钉住的节点**没有**被搬走，a 仍然精确停在 {123,456}。所以这不是一个已复现
      的 bug，只是「把一组坐标交给一个做过整体平移的算法」在语义上就说不通 ——
      它没出错是运气好，不是承诺。关掉它不花任何代价，就关了。

      没有约束时才开着：那时它有用，能把孤立节点收拢到主图旁边而不是散在远处。
    */
    packComponents: anchors.length === 0,
    animate: !large,
    animationDuration: 700,
    animationEasing: "ease-out-cubic",
    randomize: false,
    fixedNodeConstraint: anchors.length > 0 ? anchors : undefined,
    // 增量布局的初始能量压低，新节点围绕已稳定的结构生长而不是把整张图推倒
    initialEnergyOnIncremental: 0.3,
    nodeRepulsion: 6000,
    idealEdgeLength: 70,
    // 让同簇节点互相吸引 —— 这是「分簇可读」的关键
    nestingFactor: 0.1,
    gravity: 0.28,
    numIter: large ? 800 : 2000,
    nodeSeparation: 60,
    nodeDimensionsIncludeLabels: true,
  } as unknown as cytoscape.LayoutOptions;

  cy.layout(options).run();
}

/**
 * 导出 PNG 用的取景框（模型坐标）。
 *
 * 为什么不能直接 `cy.png({ full: true })`：
 *
 *   1. 它取的是**全部元素**的包围盒，且不给任何留白 —— 贴着边缘的标签会被
 *      裁掉半截。
 *   2. 它不会剔除离群点。实测某个 127 节点的会话：两个资料节点被甩到 4000px
 *      外，包围盒因此是 4608×837，而 90% 的节点只占中间 596×413 —— 导出的
 *      图上拓扑只占宽度的 6%，用户看到的就是「图太小了」。
 *
 * 所以自己算：用四分位距（IQR）把离群点摘出来，取剩下节点的外框。离群点不多
 * 时（稳健框 ≥ 全量框的一半）还是用全量框，一个节点都不裁 —— 宁可图宽一点，
 * 也不该悄悄少画几个节点。
 *
 * 为什么是 IQR 而不是分位数：一个离群点占 127 个节点的 0.8%，2% 分位根本切不掉
 * 它，图照样被撑成一条细带；IQR 对「一个还是十个」都成立。
 */
function exportFrame(cy: Core) {
  const boxes: { x: number; y: number; x1: number; y1: number; x2: number; y2: number }[] = [];
  cy.nodes().forEach((n) => {
    const bb = n.boundingBox({ includeLabels: true, includeOverlays: false });
    const p = n.position();
    boxes.push({ x: p.x, y: p.y, x1: bb.x1, y1: bb.y1, x2: bb.x2, y2: bb.y2 });
  });
  if (boxes.length === 0) return cy.elements().boundingBox();

  const area = (b: { x1: number; y1: number; x2: number; y2: number }) =>
    Math.max(1, b.x2 - b.x1) * Math.max(1, b.y2 - b.y1);
  const full = {
    x1: Math.min(...boxes.map((b) => b.x1)),
    y1: Math.min(...boxes.map((b) => b.y1)),
    x2: Math.max(...boxes.map((b) => b.x2)),
    y2: Math.max(...boxes.map((b) => b.y2)),
  };
  // 节点太少时四分位数没有意义，直接全量
  if (boxes.length < 8) return full;

  const quantile = (vals: number[], f: number) => {
    const s = [...vals].sort((a, b) => a - b);
    const pos = (s.length - 1) * f;
    const lo = Math.floor(pos);
    return lo === pos ? s[lo] : s[lo] + (s[lo + 1] - s[lo]) * (pos - lo);
  };
  /** 超出 Q1-3·IQR / Q3+3·IQR 的算离群点 */
  const fence = (vals: number[]) => {
    const q1 = quantile(vals, 0.25);
    const q3 = quantile(vals, 0.75);
    const iqr = q3 - q1;
    return { lo: q1 - 3 * iqr, hi: q3 + 3 * iqr };
  };

  const fx = fence(boxes.map((b) => b.x));
  const fy = fence(boxes.map((b) => b.y));
  const kept = boxes.filter(
    (b) => b.x >= fx.lo && b.x <= fx.hi && b.y >= fy.lo && b.y <= fy.hi,
  );
  if (kept.length === 0) return full;

  const core = {
    x1: Math.min(...kept.map((b) => b.x1)),
    y1: Math.min(...kept.map((b) => b.y1)),
    x2: Math.max(...kept.map((b) => b.x2)),
    y2: Math.max(...kept.map((b) => b.y2)),
  };

  return area(core) >= area(full) * 0.5 ? full : core;
}

/**
 * 唯一的高亮入口。
 *
 * 悬停和选中都会改这些 class，如果各自 addClass/removeClass，两者会在
 * 「鼠标划过一个有选中的图」时互相覆盖，出现闪一下又复原的抖动。
 * 收敛到一个函数、每次都从干净状态重算，就不会打得起来。
 */
function applyEmphasis(cy: Core, selectedId: string | null, hoverId: string | null) {
  cy.batch(() => {
    cy.elements().removeClass("highlighted dimmed hovered hover-dimmed");
    const focusId = hoverId ?? selectedId;
    if (!focusId) return;
    const node = cy.getElementById(focusId);
    if (node.empty()) return;

    // 选中节点的邻域保持高亮，其余压暗 —— 一眼看出它连了哪些资料
    const neighborhood = node.closedNeighborhood();
    const hovering = Boolean(hoverId);
    cy.elements()
      .difference(neighborhood)
      .addClass(hovering ? "hover-dimmed" : "dimmed");
    neighborhood.addClass(hovering ? "hovered" : "highlighted");
  });
}
