/**
 * 簇配色。
 *
 * 单独成一个模块，因为前端图和导出的 Markdown 报告要给出同一套颜色 ——
 * 报告里看到「装备配置」是蓝色，回到界面点开同一个簇也应该是蓝色，
 * 否则两个视图就对不上了。两处各写一份数组必然会漂移。
 */

/**
 * 挑的是暗底上区分度足够、且对色盲相对友好的一组。
 * 数量多于配色数时循环取用 —— 超过 12 个簇的图本来就超出了「一眼看懂」的
 * 极限，配色重复不是主要矛盾。
 */
export const CLUSTER_COLORS = [
  "#58a6ff", "#3fb950", "#d29922", "#bc8cff", "#f85149", "#39c5cf",
  "#ff7b72", "#7ee787", "#e3b341", "#a5a5ff", "#56d4dd", "#ffa657",
] as const;

/** 第 i 个簇的颜色。索引即簇在 graph.clusters 里的位置。 */
export function clusterColor(index: number): string {
  return CLUSTER_COLORS[index % CLUSTER_COLORS.length];
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
