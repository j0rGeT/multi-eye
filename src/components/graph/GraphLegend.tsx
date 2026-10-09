"use client";

/**
 * 图例。
 *
 * 簇的颜色和标签在导出的 Markdown 报告里用的是同一套（`core/graph/palette.ts`），
 * 两处对得上，报告里的图和界面里的图才像是同一个东西。
 *
 * 和上一版最大的差别是**它现在能点**：点一行就把视野收拢到那个簇。原来的图例
 * 挂着 pointerEvents: none，是纯装饰 —— 一个列出了七个簇名却点不动的面板，
 * 除了占地方没有别的作用。
 */

import type { Cluster } from "@/core/types";
import { clusterColor } from "@/core/graph/palette";

export interface GraphLegendProps {
  clusters: Cluster[];
  /** 点一行 → 聚焦该簇。 */
  onFocus: (cluster: Cluster) => void;
  /** 当前聚焦的簇 id，用于高亮那一行。 */
  activeId?: string | null;
}

export default function GraphLegend({
  clusters,
  onFocus,
  activeId,
}: GraphLegendProps) {
  // 只有一个簇时图例没有信息量（整张图同色），不显示
  if (clusters.length <= 1) return null;

  return (
    <div className="glegend">
      {clusters.map((c, i) => (
        <button
          key={c.id}
          type="button"
          className={`glegend-row${activeId === c.id ? " on" : ""}`}
          onClick={() => onFocus(c)}
          title={`聚焦「${c.label}」：${c.size} 个概念、${c.docIds.length} 篇资料`}
        >
          <span className="dot" style={{ background: clusterColor(i) }} />
          <span className="glegend-label">{c.label}</span>
          <span className="dim glegend-size">{c.size}</span>
        </button>
      ))}
    </div>
  );
}
