/**
 * 图元的尺寸映射。
 *
 * 单独成文件是因为它有**三个**消费者：浏览器里的 Cytoscape 渲染、
 * `export/svg.ts` 生成示例图、以及将来任何再画一次这张图的地方。
 * 半径公式抄三遍的话，「同一张图」迟早会长得不一样。
 */

/**
 * 核心概念节点的尺寸阈值 (px)。
 *
 * 直径大于等于 32px 的概念节点视为核心/主干概念，文字将居中内嵌并加粗，
 * 消除空心大圆圈内部空旷、底部下挂小字的视觉割裂感。
 */
export const CORE_NODE_SIZE_THRESHOLD = 32;

/**
 * 判断节点是否为核心大节点。
 */
export function isCoreNode(size: number, kind: string): boolean {
  return kind !== "document" && size >= CORE_NODE_SIZE_THRESHOLD;
}

/**
 * 节点半径。
 *
 * 开方压缩而不是线性映射：权重分布是长尾的，纯线性会让头部几个节点大到
 * 遮住其它所有节点，反而看不清结构。
 */
export function nodeSize(weight: number, maxWeight: number, kind: string): number {
  if (kind === "document") return 12;
  const max = Math.max(1, maxWeight);
  return 14 + Math.sqrt(Math.max(0, weight) / max) * 46;
}

/** 边宽。同样压缩，否则最粗的那条会盖住它连的两个节点。 */
export function edgeWidth(weight: number, maxWeight: number): number {
  const max = Math.max(1, maxWeight);
  return 0.4 + (Math.max(0, weight) / max) * 2.4;
}
