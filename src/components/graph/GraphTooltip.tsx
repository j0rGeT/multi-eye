"use client";

/**
 * 悬停浮层。
 *
 * 用 React 自己渲染而不是引 cytoscape-popper：这个应用要打包成桌面应用，
 * 依赖越少越好；浮层还得跟应用配色一致，自己渲染反而更好控制。
 *
 * 定位直接用**容器内坐标**（Cytoscape 的 renderedPosition 本来就是相对容器的，
 * 和 CSS 的 left/top 同一套坐标系，不需要任何换算）。越界翻转在 GraphView
 * 里判断，这里只负责画。
 */

import type { GraphNode } from "@/core/types";

export interface TooltipState {
  /** 相对图容器左上角的坐标（光标位置）。 */
  x: number;
  y: number;
  node: GraphNode;
  clusterLabel?: string;
  /** 光标贴近右/下边缘时翻到另一侧，否则浮层会被容器裁掉。 */
  flipX?: boolean;
  flipY?: boolean;
}

const KIND_LABEL: Record<string, string> = {
  keyword: "概念",
  entity: "实体",
  document: "资料",
};

export default function GraphTooltip({ state }: { state: TooltipState | null }) {
  if (!state) return null;
  const { x, y, node, clusterLabel, flipX, flipY } = state;

  return (
    <div
      className="gtip"
      style={{
        left: x,
        top: y,
        transform: `translate(${flipX ? "calc(-100% - 14px)" : "14px"}, ${
          flipY ? "calc(-100% - 14px)" : "-50%"
        })`,
      }}
      /*
        浮层本身不吃鼠标事件。它跟着光标走，一旦能接收事件就会挡住下面的节点，
        于是 mouseout → 浮层消失 → 又回到节点上 → 浮层出现……抖个不停。
      */
      aria-hidden="true"
    >
      <div className="gtip-title">{node.label}</div>
      <div className="gtip-meta">
        <span className="gtip-kind">{KIND_LABEL[node.kind] ?? node.kind}</span>
        {node.type && <span className="gtip-kind">{node.type}</span>}
        <span className="dim">权重 {node.weight.toFixed(1)}</span>
        <span className="dim">连接 {node.degree}</span>
      </div>
      {node.kind === "document" ? (
        <div className="gtip-foot dim">双击聚焦 · 单击看详情</div>
      ) : (
        <div className="gtip-foot">
          {clusterLabel ?? "未归类"}
          {node.docIds.length > 0 && (
            <span className="dim"> · {node.docIds.length} 篇资料</span>
          )}
        </div>
      )}
    </div>
  );
}
