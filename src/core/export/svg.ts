/**
 * 把 GraphModel 画成一张静态 SVG。
 *
 * ── 为什么是自己画，而不是让 Cytoscape 导 ──
 *
 * 实测（`node -e` 跑过）：
 *   - `cy.svg()` 不是函数（SVG 导出在另一个扩展包里，本项目没装）
 *   - `cy.png()` 在 headless 下直接抛 `A headless instance can not render images`
 *
 * 所以拿不到 Cytoscape 的渲染结果，只能要它的**坐标**、然后自己画。这反而
 * 更好：不用引 canvas / sharp 这类要 node-gyp 的原生依赖（本项目刻意避开），
 * SVG 是文本、git 里可 diff、GitHub 能直接渲染、放大不糊。
 *
 * ── 为什么值得跟界面长得一样 ──
 *
 * 配色走 `graph/palette.ts`、尺寸走 `graph/geometry.ts`，和前端是**同一份
 * 代码**。README 里那张图因此是这个应用真实的输出，而不是一张手画的示意图 ——
 * 手画的图迟早会和产品长得不一样，然后开始骗人。
 *
 * 已知的取舍：边用直线而不是界面的 bezier。静态图里直线更清楚，而且少一层
 * 路径数学。
 */

import cytoscape from "cytoscape";
import fcose from "cytoscape-fcose";
import type { GraphModel } from "../types";
import { clusterColor, clusterIndexMap } from "../graph/palette";
import { edgeWidth, nodeSize } from "../graph/geometry";

let registered = false;
function ensureFcose() {
  if (registered) return;
  cytoscape.use(fcose);
  registered = true;
}

export interface SvgOptions {
  /** 画布宽度。高度按布局的实际包围盒算。 */
  width?: number;
  /**
   * 固定布局的随机种子。
   *
   * fcose 用 Math.random 决定初始位置，不给种子的话每次生成的图都不一样 ——
   * 提交进仓库的示例图会在每次重新生成时产生一大片无意义的 diff。
   */
  seed?: number;
  /** 隐藏资料节点。节点多的时候图会糊成一团。 */
  showDocuments?: boolean;
  /** 图下方的出处说明，比如「来自会话 xxxxx · 主题 露营装备」。 */
  caption?: string;
}

const DOC_COLOR = "#484f58";
const DOC_BORDER = "#6e7681";
const EDGE_COLOR = "#30363d";

/**
 * 用给定的种子替换 Math.random，跑完再换回去。
 *
 * 是个 monkey patch，但 fcose 没有提供 seed 参数，而我们确实需要可重复的
 * 输出。作用域严格限制在同步的布局调用里，跑完立刻还原。
 */
function withSeed<T>(seed: number | undefined, fn: () => T): T {
  if (seed === undefined) return fn();
  const original = Math.random;
  let s = seed >>> 0 || 1;
  Math.random = () => {
    // xorshift32，够用且不需要引依赖
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1e6) / 1e6;
  };
  try {
    return fn();
  } finally {
    Math.random = original;
  }
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderTopologySvg(
  graph: GraphModel,
  opts: SvgOptions = {},
): string {
  ensureFcose();

  const width = opts.width ?? 1600;
  const showDocuments = opts.showDocuments ?? true;

  const nodes = graph.nodes.filter(
    (n) => showDocuments || n.kind !== "document",
  );
  const visible = new Set(nodes.map((n) => n.id));
  const edges = graph.edges.filter(
    (e) => visible.has(e.source) && visible.has(e.target),
  );

  if (nodes.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="80"><rect width="${width}" height="80" fill="#0d1117"/><text x="24" y="46" fill="#6e7681" font-family="sans-serif" font-size="14">这张图是空的</text></svg>`;
  }

  const maxWeight = Math.max(1, ...nodes.map((n) => n.weight));
  const maxEdge = Math.max(1, ...edges.map((e) => e.weight));
  const radiusOf = (n: (typeof nodes)[number]) =>
    n.kind === "document" ? 9 : nodeSize(n.weight, maxWeight, n.kind);

  // ── 算坐标 ──
  const raw = withSeed(opts.seed, () => {
    const cy = cytoscape({
      headless: true,
      styleEnabled: true,
      /*
        必须把**节点尺寸**告诉布局。

        不告诉的话 force 布局把每个节点当成一个点，算出来的间距只够点与点
        之间不重叠；而下面画的是半径几十像素的圆，于是圆圈会糊成一团。
        界面上不会有这个问题，因为 Cytoscape 在那儿本来就知道每个节点的
        真实宽高（style 里 width: data(size)）。

        打开 styleEnabled 并把 width/height 映射到 data，`outerWidth()` 才会
        返回真实值，fcose 的 nodeDimensionsIncludeLabels 才有东西可依。
      */
      style: [
        {
          selector: "node",
          style: { width: "data(w)", height: "data(h)" },
        },
      ],
      elements: [
        ...nodes.map((n) => {
          const d = radiusOf(n) * 2;
          return { data: { id: n.id, w: d, h: d } };
        }),
        ...edges.map((e) => ({
          data: { id: e.id, source: e.source, target: e.target },
        })),
      ],
    });

    // 参数与前端 GraphView 保持一致，否则示例图会和界面上看到的不一样
    cy.layout({
      name: "fcose",
      quality: "default",
      packComponents: true,
      animate: false,
      randomize: true,
      nodeRepulsion: 6000,
      idealEdgeLength: 70,
      nestingFactor: 0.1,
      gravity: 0.28,
      numIter: 2000,
      nodeSeparation: 60,
      nodeDimensionsIncludeLabels: true,
    } as unknown as cytoscape.LayoutOptions).run();

    const positions = new Map<string, { x: number; y: number }>();
    cy.nodes().forEach((n) => {
      const p = n.position();
      positions.set(n.id(), { x: p.x, y: p.y });
    });
    cy.destroy();
    return positions;
  });

  // ── 包围盒 → 缩放 ──
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    const p = raw.get(n.id);
    if (!p) continue;
    const r = radiusOf(n);
    minX = Math.min(minX, p.x - r);
    maxX = Math.max(maxX, p.x + r);
    minY = Math.min(minY, p.y - r);
    maxY = Math.max(maxY, p.y + r);
  }

  const sideMargin = 44;
  // 顶部：标题 / 副标题 / 图例 三行，各自要有自己的基线，不能挤在一起
  const titleY = 34;
  const subtitleY = 58;
  const legendY = 80;
  const topBand = 96;
  const bottomBand = opts.caption ? 46 : 26;
  const labelSpace = 16; // 节点标签落在节点下方，别让它们被裁掉

  const bboxW = Math.max(1, maxX - minX);
  const bboxH = Math.max(1, maxY - minY + labelSpace);

  /*
    **整体等比缩放**，位置、半径、字号、线宽用同一个系数。

    只缩放位置、不缩半径（第一版就是这么写的）会把图变得极其稀疏：节点间距
    拉大 3 倍而圆圈还是原来那么大，看着像撒了一地的豆子，和界面上完全是两个
    东西。等比缩放之后，这张图就是「把界面上的布局放大 N 倍」，密度和界面
    一致 —— 这正是示例图该有的样子。

    上限 2.6：再大就只是把几个圆画得更大，没有更多信息。
  */
  const scale = Math.min(
    2.6,
    (width - sideMargin * 2) / bboxW,
    760 / bboxH,
  );
  const canvasH = bboxH * scale;
  const height = Math.round(topBand + canvasH + bottomBand);

  // 水平居中。只按 minX 对齐的话图会贴在左边，右边空一大片
  const tx = (width - bboxW * scale) / 2 - minX * scale;
  const ty = topBand - minY * scale;
  const px = (x: number) => tx + x * scale;
  const py = (y: number) => ty + y * scale;

  // ── 标签：只标权重靠前的那些 ──
  //
  // 1600px 宽塞 60 个标签就是一片糊。按权重取前 40%，剩下的靠颜色和大小读。
  const sorted = [...nodes].sort((a, b) => b.weight - a.weight);
  const labelCount = Math.max(
    8,
    Math.round(nodes.length * (nodes.length > 40 ? 0.35 : 0.6)),
  );
  const labelled = new Set(sorted.slice(0, labelCount).map((n) => n.id));

  const clusterIndex = clusterIndexMap(graph.clusters);

  // ── 拼 SVG ──
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', sans-serif">`,
  );
  parts.push(
    `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#8b949e"/></marker></defs>`,
  );
  parts.push(`<rect width="${width}" height="${height}" fill="#0d1117"/>`);

  // 标题
  parts.push(
    `<text x="${sideMargin}" y="${titleY}" fill="#e6edf3" font-size="21" font-weight="600">${esc(graph.topic.query)} · 知识拓扑</text>`,
  );
  parts.push(
    `<text x="${sideMargin}" y="${subtitleY}" fill="#8b949e" font-size="13">${graph.stats.nodeCount} 节点 · ${graph.stats.edgeCount} 边 · ${graph.stats.clusterCount} 簇 · ${
      graph.stats.generatedBy === "llm" ? "LLM 语义构图" : "本地启发式构图"
    }（jieba + TF-IDF + 共现 + Louvain）</text>`,
  );

  // 图例：一行色块。放不下就只报个数
  let legendX = sideMargin;
  let legendShown = 0;
  for (let i = 0; i < graph.clusters.length; i += 1) {
    const c = graph.clusters[i];
    const label = c.label.length > 10 ? `${c.label.slice(0, 10)}…` : c.label;
    // 中文按 12px/字 估宽（font-size 12 的方块字），再加色块与间距
    const chipW = 14 + label.length * 12 + 14;
    if (legendX + chipW > width - sideMargin) break;
    parts.push(
      `<rect x="${legendX}" y="${legendY - 9}" width="9" height="9" rx="2" fill="${clusterColor(i)}"/>`,
      `<text x="${legendX + 14}" y="${legendY}" fill="#8b949e" font-size="12">${esc(label)}</text>`,
    );
    legendX += chipW;
    legendShown += 1;
  }
  if (legendShown < graph.clusters.length) {
    parts.push(
      `<text x="${legendX}" y="${legendY}" fill="#6e7681" font-size="12">+${graph.clusters.length - legendShown} 个簇</text>`,
    );
  }

  // 边先画，节点盖在上面
  //
  // contains 是「这篇资料提到了这个概念」，数量最多且信息量最低 —— 用虚线
  // 压到最轻。relation 是 LLM 给的带谓词的边，是这张图里最贵的信息，给箭头
  // 和更亮的颜色。
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  for (const e of edges) {
    const a = raw.get(e.source);
    const b = raw.get(e.target);
    const na = nodeById.get(e.source);
    const nb = nodeById.get(e.target);
    if (!a || !b || !na || !nb) continue;

    const x1 = px(a.x);
    const y1 = py(a.y);
    const x2 = px(b.x);
    const y2 = py(b.y);
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;

    /*
      把两端裁到圆周上。

      不裁的话线是从圆心画到圆心的：节点填充是半透明的（0.85），线和目标端
      的箭头会**透过圆盘露出来**，看着像圆圈里画了箭头。裁掉之后线只在节点
      之间可见，也就是界面上看到的那个样子。
    */
    const ra = radiusOf(na) * scale + 1;
    const rb = radiusOf(nb) * scale + 1;
    if (len <= ra + rb + 2) continue; // 两个节点几乎贴在一起，没有可画的线段

    const ux = dx / len;
    const uy = dy / len;
    const w = edgeWidth(e.weight, maxEdge);
    const relation = e.kind === "relation";

    parts.push(
      `<line x1="${(x1 + ux * ra).toFixed(1)}" y1="${(y1 + uy * ra).toFixed(1)}" x2="${(x2 - ux * rb).toFixed(1)}" y2="${(y2 - uy * rb).toFixed(1)}" stroke="${
        relation ? "#8b949e" : EDGE_COLOR
      }" stroke-width="${(w * scale).toFixed(2)}" stroke-opacity="${
        relation ? 0.85 : e.kind === "contains" ? 0.35 : 0.55
      }"${relation ? ' marker-end="url(#arrow)"' : ""}${
        e.kind === "contains" ? ' stroke-dasharray="2 3"' : ""
      }/>`,
    );
  }

  // 节点
  for (const n of nodes) {
    const p = raw.get(n.id);
    if (!p) continue;
    const cx = px(p.x);
    const cyy = py(p.y);
    const r = radiusOf(n) * scale;
    const color =
      n.kind === "document"
        ? DOC_COLOR
        : clusterColor(clusterIndex.get(n.clusterId) ?? 0);
    const stroke = n.kind === "document" ? DOC_BORDER : "#0d1117";

    if (n.kind === "document") {
      const side = r * 2;
      parts.push(
        `<rect x="${(cx - r).toFixed(1)}" y="${(cyy - r).toFixed(1)}" width="${side.toFixed(1)}" height="${side.toFixed(1)}" rx="2" fill="${color}" fill-opacity="0.5" stroke="${stroke}"/>`,
      );
    } else {
      parts.push(
        `<circle cx="${cx.toFixed(1)}" cy="${cyy.toFixed(1)}" r="${r.toFixed(1)}" fill="${color}" fill-opacity="0.85" stroke="${stroke}"/>`,
      );
    }

    if (labelled.has(n.id) && n.kind !== "document") {
      // 字号跟着一起缩放，但夹住上下限：太小看不清、太大喧宾夺主
      const fs = Math.max(10, Math.min(26, 10 * scale));
      parts.push(
        `<text x="${cx.toFixed(1)}" y="${(cyy + r + fs * 0.95).toFixed(1)}" fill="#c9d1d9" font-size="${fs.toFixed(1)}" text-anchor="middle">${esc(n.label)}</text>`,
      );
    }
  }

  // 出处
  if (opts.caption) {
    parts.push(
      `<text x="${sideMargin}" y="${height - 18}" fill="#6e7681" font-size="12">${esc(opts.caption)}</text>`,
    );
  }

  parts.push("</svg>");
  return parts.join("\n");
}
