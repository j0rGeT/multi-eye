/**
 * 簇配色与拓扑图视觉风格。
 *
 * 单独成一个模块，因为前端图和导出的 Markdown 报告以及 SVG 导出要给出同一套颜色 ——
 * 报告里看到「装备配置」是蓝色，回到界面点开同一个簇也应该是蓝色，
 * 否则两个视图就对不上了。两处各写一份必然会漂移。
 * 配色是整个拓扑图可视化的唯一色彩来源。
 */

/**
 * 默认风格下的基础簇调色板。
 * 挑的是暗底上区分度足够、且对色盲相对友好的一组。
 * 数量多于配色数时循环取用 —— 超过 12 个簇的图本来就超出了「一眼看懂」的
 * 极限，配色重复不是主要矛盾。
 */
export const CLUSTER_COLORS = [
  "#58a6ff", "#3fb950", "#d29922", "#bc8cff", "#f85149", "#39c5cf",
  "#ff7b72", "#7ee787", "#e3b341", "#a5a5ff", "#56d4dd", "#ffa657",
] as const;

/**
 * 拓扑图风格键名。
 */
export type GraphStyleKey = "default" | "dark" | "paper" | "contrast";

/**
 * 拓扑图整体色彩与视觉方案规格。
 */
export interface GraphStyleTheme {
  key: GraphStyleKey;
  label: string;
  description: string;
  /** 画布/背景色 */
  canvasBg: string;
  /** 主文字（标题等高对比度文本） */
  textPrimary: string;
  /** 次要文字（副标题、统计、图例说明等） */
  textSecondary: string;
  /** 辅助弱化文字（SVG 空状态、底部出处说明等） */
  captionColor: string;
  /** 节点标签文字颜色 */
  nodeLabelColor: string;
  /** 概念节点描边颜色 */
  conceptBorder: string;
  /** 概念节点描边粗细 */
  conceptBorderWidth: number;
  /** 概念节点填充透明度 */
  conceptFillOpacity: number;
  /** 资料节点填充颜色 */
  docFill: string;
  /** 资料节点填充透明度 */
  docFillOpacity: number;
  /** 资料节点描边颜色 */
  docBorder: string;
  /** 资料节点描边粗细 */
  docBorderWidth: number;
  /** 资料节点文字颜色 */
  docLabelColor: string;
  /** 普通关联边颜色 */
  edgeColor: string;
  /** 普通边不透明度 */
  edgeOpacity: number;
  /** 普通边线型 */
  edgeLineStyle: "solid" | "dashed" | "dotted";
  /** 包含关系 edge[kind="contains"] 在前端 Cytoscape 的颜色 */
  edgeContainsColor: string;
  /** 包含关系 edge[kind="contains"] 在前端 Cytoscape 的不透明度 */
  edgeContainsOpacity: number;
  /** 包含关系线型 */
  edgeContainsLineStyle: "solid" | "dashed" | "dotted";
  /** 包含关系在 SVG 导出中的颜色（保持 default 模式下与原有 SVG 逐字节一致） */
  svgEdgeContainsColor: string;
  /** 包含关系在 SVG 导出中的不透明度 */
  svgEdgeContainsOpacity: number;
  /** 语义关系 edge[kind="relation"] 颜色与箭头颜色 */
  edgeRelationColor: string;
  /** 语义关系不透明度 */
  edgeRelationOpacity: number;
  /** 语义关系标签文字背景颜色 */
  relationLabelBg: string;
  /** 语义关系标签文字颜色 */
  relationLabelColor: string;
  /** 选中高亮边框/颜色 */
  highlightBorder: string;
  /** 悬停边颜色 */
  hoverEdgeColor: string;
  /** 框选节点边框颜色 */
  selectedBorder: string;
  /** 核心概念大节点内部标签颜色 */
  coreNodeLabelColor: string;
  /** 常态核心概念节点同色光晕透明度（0 为无发光） */
  ambientGlowOpacity: number;
  /** 常态核心概念节点光晕外扩扩散半径 (px) */
  ambientGlowPadding: number;
  /** 悬停与选中时的高亮光晕透明度 */
  activeGlowOpacity: number;
  /** 悬停与选中时的高亮光晕外扩扩散半径 (px) */
  activeGlowPadding: number;
  /** 资料卡片节点尺寸 [宽, 高] (px) */
  docDimensions: { width: number; height: number };
  /** 概念节点是否启用双层复古轮廓边框 (paper 风格) */
  useDoubleBorder?: boolean;
  /** 簇颜色映射函数：接收簇索引，返回该风格下适配背景与明度/饱和度的色值 */
  getClusterColor: (index: number) => string;
}

/**
 * 深色（dark）风格簇调色板：
 * 采用黑曜石纯黑底（#05070a），为避免高饱和杂光刺眼，簇色在保持原色相家族的基础上，
 * 适度提升明度与发光感（霓虹夜景感），使节点在极深背景下呈现通透的微发光聚类效果。
 */
const DARK_CLUSTER_COLORS = [
  "#70b5ff", "#52cb64", "#e5aa33", "#ca9fff", "#ff6b64", "#4fe0eb",
  "#ff9189", "#95f59d", "#f0c454", "#b9b9ff", "#6ee4ec", "#ffb873",
] as const;

/**
 * 纸质/文档风（paper）风格簇调色板：
 * 适配温暖的暖白/米宣纸底色（#f6f4ee）。原色在浅底上如果明度过高会泛白失焦，
 * 因此严格保持同一色相（蓝、绿、琥珀、紫、红、青等），但将明度调低至沉稳的墨印深度、
 * 饱和度适度收敛，如同印制在精装报告书籍上的矿物墨水，优雅耐看。
 */
const PAPER_CLUSTER_COLORS = [
  "#205493", "#286835", "#875a14", "#5b3794", "#9e2a2b", "#1d6e75",
  "#a0362f", "#256d34", "#7d5d12", "#3a3c99", "#1b6f79", "#944e15",
] as const;

/**
 * 高对比（contrast）风格簇调色板：
 * 适合强光投影仪投屏、截图印刷与色弱辨识。
 * 纯黑纯白强轮廓骨架为主，簇色提纯为极致纯正的高饱和单色，
 * 不依赖微妙的色调渐变，仅靠极高的色彩辨识度确保即便在劣质显示设备上也能一眼分清不同簇。
 */
const CONTRAST_CLUSTER_COLORS = [
  "#388bfd", "#2ea043", "#d29922", "#a371f7", "#f85149", "#1f6feb",
  "#da3633", "#238636", "#bb8009", "#8957e5", "#0969da", "#d47616",
] as const;

/**
 * 四种风格的详尽定义与设计意图：
 *
 * 1. default: 默认深色控制台风。基线方案，保持完全现有观感不变，黑灰暗底 (#0d1117)，GitHub Dark 经典克制。
 * 2. dark: 极深暗夜高亮风。纯黑背景 (#05070a)，降低暗部杂光，提升边线与荧光对比，适合深夜专注研究或 OLED 屏幕展示。
 * 3. paper: 实体文档/纸质报告风。暖米色浅底 (#f6f4ee)，低饱和墨印色相与细边框勾勒，如同打印出来的学术报告，适合白昼阅读与文档插图。
 * 4. contrast: 高对比度投屏风。纯黑极简硬朗风格 (#000000)，加粗纯白节点边框与虚线共现边，去除半透明朦胧感，专为投影仪与截图分享优化。
 */
export const GRAPH_STYLES: Record<GraphStyleKey, GraphStyleTheme> = {
  default: {
    key: "default",
    label: "默认",
    description: "经典暗调基线风格，GitHub 深色设计规范，视觉克制沉稳",
    canvasBg: "#0d1117",
    textPrimary: "#e6edf3",
    textSecondary: "#8b949e",
    captionColor: "#6e7681",
    nodeLabelColor: "#c9d1d9",
    conceptBorder: "#0d1117",
    conceptBorderWidth: 1,
    conceptFillOpacity: 0.85,
    docFill: "#21262d",
    docFillOpacity: 0.85,
    docBorder: "#58a6ff",
    docBorderWidth: 1.2,
    docLabelColor: "#8b949e",
    edgeColor: "#30363d",
    edgeOpacity: 0.55,
    edgeLineStyle: "solid",
    edgeContainsColor: "#21262d",
    edgeContainsOpacity: 0.4,
    edgeContainsLineStyle: "dotted",
    svgEdgeContainsColor: "#30363d",
    svgEdgeContainsOpacity: 0.35,
    edgeRelationColor: "#8b949e",
    edgeRelationOpacity: 0.85,
    relationLabelBg: "#0d1117",
    relationLabelColor: "#8b949e",
    highlightBorder: "#e6edf3",
    hoverEdgeColor: "#8b949e",
    selectedBorder: "#58a6ff",
    coreNodeLabelColor: "#ffffff",
    ambientGlowOpacity: 0.16,
    ambientGlowPadding: 4,
    activeGlowOpacity: 0.4,
    activeGlowPadding: 7,
    docDimensions: { width: 14, height: 14 },
    getClusterColor: (i: number) => CLUSTER_COLORS[i % CLUSTER_COLORS.length],
  },
  dark: {
    key: "dark",
    label: "深色",
    description: "纯黑极深夜间底色，簇色微亮发光，边线更亮更通透，适合暗光环境",
    canvasBg: "#05070a",
    textPrimary: "#f0f6fc",
    textSecondary: "#9aa2ab",
    captionColor: "#7d8590",
    nodeLabelColor: "#e1e7ef",
    conceptBorder: "#1b222c",
    conceptBorderWidth: 1.5,
    conceptFillOpacity: 0.92,
    docFill: "#161b22",
    docFillOpacity: 0.9,
    docBorder: "#70b5ff",
    docBorderWidth: 1.2,
    docLabelColor: "#9aa2ab",
    edgeColor: "#485260",
    edgeOpacity: 0.72,
    edgeLineStyle: "solid",
    edgeContainsColor: "#2d3540",
    edgeContainsOpacity: 0.52,
    edgeContainsLineStyle: "dotted",
    svgEdgeContainsColor: "#38414e",
    svgEdgeContainsOpacity: 0.48,
    edgeRelationColor: "#b8c2cc",
    edgeRelationOpacity: 0.92,
    relationLabelBg: "#05070a",
    relationLabelColor: "#b8c2cc",
    highlightBorder: "#ffffff",
    hoverEdgeColor: "#d0d7de",
    selectedBorder: "#70b5ff",
    coreNodeLabelColor: "#ffffff",
    ambientGlowOpacity: 0.26,
    ambientGlowPadding: 5,
    activeGlowOpacity: 0.52,
    activeGlowPadding: 8,
    docDimensions: { width: 14, height: 14 },
    getClusterColor: (i: number) => DARK_CLUSTER_COLORS[i % DARK_CLUSTER_COLORS.length],
  },
  paper: {
    key: "paper",
    label: "纸质",
    description: "米白暖宣纸底色，低饱和矿物色泽与细边框勾勒，像打印出来的学术报告",
    canvasBg: "#f6f4ee",
    textPrimary: "#1b1f24",
    textSecondary: "#57606a",
    captionColor: "#6e7781",
    nodeLabelColor: "#24292f",
    conceptBorder: "#424a53",
    conceptBorderWidth: 1.2,
    conceptFillOpacity: 0.88,
    docFill: "#e1ddd3",
    docFillOpacity: 0.85,
    docBorder: "#8c857b",
    docBorderWidth: 0.8,
    docLabelColor: "#57606a",
    edgeColor: "#b5aea2",
    edgeOpacity: 0.68,
    edgeLineStyle: "solid",
    edgeContainsColor: "#cdc6ba",
    edgeContainsOpacity: 0.6,
    edgeContainsLineStyle: "dotted",
    svgEdgeContainsColor: "#c5beb2",
    svgEdgeContainsOpacity: 0.55,
    edgeRelationColor: "#424a53",
    edgeRelationOpacity: 0.88,
    relationLabelBg: "#f6f4ee",
    relationLabelColor: "#32383f",
    highlightBorder: "#1b1f24",
    hoverEdgeColor: "#24292f",
    selectedBorder: "#205493",
    coreNodeLabelColor: "#f6f4ee",
    ambientGlowOpacity: 0,
    ambientGlowPadding: 0,
    activeGlowOpacity: 0,
    activeGlowPadding: 0,
    useDoubleBorder: true,
    docDimensions: { width: 14, height: 14 },
    getClusterColor: (i: number) => PAPER_CLUSTER_COLORS[i % PAPER_CLUSTER_COLORS.length],
  },
  contrast: {
    key: "contrast",
    label: "高对比",
    description: "纯黑极简硬朗对比，强白描边与虚实线型区分，适合投屏演示与截图",
    canvasBg: "#000000",
    textPrimary: "#ffffff",
    textSecondary: "#cccccc",
    captionColor: "#999999",
    nodeLabelColor: "#ffffff",
    conceptBorder: "#ffffff",
    conceptBorderWidth: 2,
    conceptFillOpacity: 0.95,
    docFill: "#262626",
    docFillOpacity: 0.9,
    docBorder: "#ffffff",
    docBorderWidth: 1.5,
    docLabelColor: "#e6e6e6",
    edgeColor: "#808080",
    edgeOpacity: 0.8,
    edgeLineStyle: "dashed",
    edgeContainsColor: "#595959",
    edgeContainsOpacity: 0.65,
    edgeContainsLineStyle: "dotted",
    svgEdgeContainsColor: "#666666",
    svgEdgeContainsOpacity: 0.6,
    edgeRelationColor: "#ffffff",
    edgeRelationOpacity: 1,
    relationLabelBg: "#000000",
    relationLabelColor: "#ffffff",
    highlightBorder: "#ffff00",
    hoverEdgeColor: "#ffffff",
    selectedBorder: "#388bfd",
    coreNodeLabelColor: "#ffffff",
    ambientGlowOpacity: 0,
    ambientGlowPadding: 0,
    activeGlowOpacity: 0.4,
    activeGlowPadding: 6,
    docDimensions: { width: 14, height: 14 },
    getClusterColor: (i: number) => CONTRAST_CLUSTER_COLORS[i % CONTRAST_CLUSTER_COLORS.length],
  },
};

export const DEFAULT_GRAPH_STYLE: GraphStyleKey = "default";

/**
 * 校验并规范化风格键名，未知值回退到 default。
 */
export function resolveGraphStyle(key?: string | null): GraphStyleKey {
  if (key && key in GRAPH_STYLES) {
    return key as GraphStyleKey;
  }
  return DEFAULT_GRAPH_STYLE;
}

/**
 * 获取指定风格的完整主题配置。
 */
export function getGraphTheme(style: GraphStyleKey = "default"): GraphStyleTheme {
  return GRAPH_STYLES[style] ?? GRAPH_STYLES.default;
}

/**
 * 第 i 个簇的颜色。
 * 兼容旧代码直接调用 clusterColor(i)，也支持传入 style 参数取对应风格的簇颜色。
 */
export function clusterColor(index: number, style: GraphStyleKey = "default"): string {
  const theme = getGraphTheme(style);
  return theme.getClusterColor(index);
}

/**
 * 簇在 GraphModel.clusters 数组中的位置。
 *
 * 配色按位置而不是按簇 id 取：id 是 Louvain 重编号后的 c0/c1/…，同名不代表
 * 同一主题（换个查询，c0 可能是完全不同的簇），而位置对应的是「第几大簇」，
 * 这个语义在多次构图之间是稳定的。
 */
export function clusterIndexMap(
  clusters: { id: string }[],
): Map<string, number> {
  return new Map(clusters.map((c, i) => [c.id, i] as const));
}
