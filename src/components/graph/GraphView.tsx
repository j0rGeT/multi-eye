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
} from "cytoscape";
import fcose from "cytoscape-fcose";
import type { Cluster, GraphModel, GraphNode, SessionViewState } from "@/core/types";
import { clusterColor, clusterIndexMap } from "@/core/graph/palette";
import { edgeWidth, nodeSize } from "@/core/graph/geometry";
import GraphLegend from "./GraphLegend";
import GraphToolbar from "./GraphToolbar";
import GraphTooltip, { type TooltipState } from "./GraphTooltip";

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

export interface GraphViewProps {
  graph: GraphModel;
  /** 当前选中的节点 id，用于高亮。 */
  selectedId?: string;
  onSelect: (node: GraphNode | null) => void;
  /** 只显示关键词（隐藏文档节点）——文档多的时候图会很挤。 */
  showDocuments: boolean;
  /** 上次离开时的布局：节点位置与锁定集合。只在挂载时读一次。 */
  initialView?: SessionViewState;
  /** 位置变化后回调（已 debounce）。保存失败由调用方静默处理。 */
  onViewChange?: (view: SessionViewState) => void;
}

export default function GraphView({
  graph,
  selectedId,
  onSelect,
  showDocuments,
  initialView,
  onViewChange,
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
  const hoverRef = useRef<string | null>(null);
  const initialViewRef = useRef(initialView);
  /** 首次布局才自动 fit；之后 fit 会毁掉用户当前的缩放与平移。 */
  const fittedRef = useRef(false);

  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [boxSelect, setBoxSelect] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [selectedCount, setSelectedCount] = useState(0);
  const [pinnedCount, setPinnedCount] = useState(0);

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

    const visibleNodes = graph.nodes.filter(
      (n) => showDocuments || n.kind !== "document",
    );

    const nodes: ElementDefinition[] = visibleNodes.map((n) => ({
      data: {
        id: n.id,
        label: n.label,
        kind: n.kind,
        weight: n.weight,
        degree: n.degree,
        clusterId: n.clusterId,
        color: clusterColor(clusterIndex.get(n.clusterId) ?? 0),
        size: nodeSize(n.weight, maxWeight, n.kind),
      },
    }));

    const visible = new Set(visibleNodes.map((n) => n.id));

    const edges: ElementDefinition[] = graph.edges
      .filter((e) => visible.has(e.source) && visible.has(e.target))
      .map((e) => ({
        data: {
          id: e.id,
          source: e.source,
          target: e.target,
          kind: e.kind,
          weight: e.weight,
          width: edgeWidth(e.weight, maxEdge),
        },
      }));

    return { nodeDefs: nodes, edgeDefs: edges };
  }, [graph, showDocuments]);

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
            /*
              没有这些 transition，选中和压暗都是硬切，整张图会显得很生硬。
              180ms 是刻意的：再长就跟不上鼠标，再短就看不出是过渡。
            */
            "transition-property": "opacity background-color border-color border-width",
            "transition-duration": 180,
          },
        },
        {
          /**
           * 文档节点：方形 + 中性灰，不跟随簇配色。
           *
           * 本来按所属簇上色，但那会传达一个错误信息：这份语料的 60 个概念里
           * 40 个落在同一个簇，于是 43 篇资料里 38 篇被判给它 —— 几乎所有资料
           * 节点同色，看着像配色坏了。实际上「资料属于某个簇」这个设定本身
           * 就不成立：资料的归属是「跟哪个方向更相关」，那是个连续量。
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
            "transition-property": "opacity line-color width",
            "transition-duration": 180,
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
        // 选中的邻域（点击选中，或悬停时以悬停节点为中心）
        {
          selector: ".highlighted",
          style: { "border-width": 3, "border-color": "#e6edf3", opacity: 1 },
        },
        { selector: ".dimmed", style: { opacity: 0.15 } },
        /*
          悬停压暗比选中更轻（0.35 vs 0.15）：悬停是探索，选中是聚焦。
          两者一样重的话，鼠标随便划过就会把图压得跟真选中了一样。
        */
        { selector: ".hover-dimmed", style: { opacity: 0.35 } },
        { selector: "node.hovered", style: { "border-width": 2, "border-color": "#e6edf3" } },
        { selector: "edge.hovered", style: { "line-color": "#8b949e", opacity: 0.9 } },
        // 框选出来的节点（Cytoscape 内建的 :selected）—— 和点击选中的邻域高亮区分开
        {
          selector: "node:selected",
          style: {
            "border-width": 3,
            "border-color": "#58a6ff",
            "border-opacity": 1,
          },
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

    // 双击 → 把该节点及其邻域放大到填满视野
    cy.on("dbltap", "node", (evt) => {
      const node = evt.target as NodeSingular;
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

    runLayout(cy, fittedRef.current ? "keep" : "initial", positionsRef.current, pinnedRef.current);

    if (!fittedRef.current) {
      fittedRef.current = true;
      cy.animate({
        fit: { eles: cy.elements(), padding: 40 },
        duration: 600,
        easing: "ease-out-cubic",
      });
    }
  }, [nodeDefs, edgeDefs, graph]);

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
    runLayout(cy, "full", positionsRef.current, pinnedRef.current);
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

      const url = cy.png({ scale: 2, bg: "#0d1117" });
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

  return (
    <div ref={panelRef} className="graph-canvas">
      <div
        ref={containerRef}
        className={`graph-cy${boxSelect ? " box-select" : ""}`}
      />

      <GraphToolbar
        onRelayout={handleRelayout}
        onFit={handleFit}
        onPinSelected={handlePinSelected}
        onUnpinAll={handleUnpinAll}
        onExportPng={handleExportPng}
        onToggleBoxSelect={handleToggleBoxSelect}
        onFullscreen={handleFullscreen}
        boxSelect={boxSelect}
        selectedCount={selectedCount}
        pinnedCount={pinnedCount}
        fullscreen={fullscreen}
      />

      <GraphTooltip state={tooltip} />

      <GraphLegend clusters={graph.clusters} onFocus={handleFocusCluster} />

      {fullscreen && graph.clusters.length > 1 && (
        <div className="graph-fs-hint">按 Esc 退出全屏</div>
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
) {
  const large = cy.nodes().length > LARGE_GRAPH;
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
    quality: large ? "draft" : "default",
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
