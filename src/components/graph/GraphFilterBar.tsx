"use client";

/**
 * 拓扑图节点与关系类型过滤器。
 *
 * 挂在拓扑图左上角（绝对定位，与左下的 GraphLegend 呼应）。
 *
 * 解决的问题：
 *   1. 拓扑图里的实体身份不明（大模型里混着高校、机构、算法、产品）
 *   2. 共现边稠密连结，形成发线团，遮蔽了真正的语义谓词关系
 *
 * 设计纪律：
 *   - 过滤纯属视图层（前端 Cytoscape 与 Three.js 剔除可见元素），
 *     底层的 GraphModel、物理坐标和节点锁定状态完好无损，随时一键还原
 *   - 状态持久化在 SessionViewState（hiddenNodeTypes, hiddenEdgeKinds），
 *     刷新页面不丢失
 */

import { useMemo } from "react";
import type { EdgeKind } from "@/core/types";
import {
  ENTITY_TYPE_COLORS,
  ENTITY_TYPE_ORDER,
  entityTypeColor,
} from "@/core/graph/palette";

export interface GraphFilterBarProps {
  /** 当前图包含的所有实体类型（去重后）。 */
  availableNodeTypes: string[];
  /** 节点各类型在当前图中的数量映射。 */
  nodeTypeCounts: Record<string, number>;
  /** 当前被隐藏的节点类型。 */
  hiddenNodeTypes: Set<string>;
  onToggleNodeType: (type: string) => void;
  onResetNodeTypes: () => void;

  /** 当前图中各边类型的数量映射。 */
  edgeKindCounts: Record<EdgeKind, number>;
  /** 当前被隐藏的边类型。 */
  hiddenEdgeKinds: Set<EdgeKind>;
  onToggleEdgeKind: (kind: EdgeKind) => void;
  onShowOnlyRelations: () => void;
  onResetEdgeKinds: () => void;
}

const EDGE_KIND_LABELS: Record<EdgeKind, { label: string; desc: string }> = {
  relation: { label: "语义关系", desc: "带明确谓词的实体关联（高信息量）" },
  cooccur: { label: "统计共现", desc: "窗口共现边（统计关联）" },
  contains: { label: "资料包含", desc: "文档到概念的归属边" },
};

export default function GraphFilterBar({
  availableNodeTypes,
  nodeTypeCounts,
  hiddenNodeTypes,
  onToggleNodeType,
  onResetNodeTypes,
  edgeKindCounts,
  hiddenEdgeKinds,
  onToggleEdgeKind,
  onShowOnlyRelations,
  onResetEdgeKinds,
}: GraphFilterBarProps) {
  // 严格按规范顺序排序已有的节点类型
  const sortedTypes = useMemo(() => {
    const set = new Set(availableNodeTypes);
    const result: string[] = [];
    for (const t of ENTITY_TYPE_ORDER) {
      if (set.has(t)) result.push(t);
    }
    for (const t of availableNodeTypes) {
      if (!result.includes(t)) result.push(t);
    }
    return result;
  }, [availableNodeTypes]);

  const hasHiddenNodes = hiddenNodeTypes.size > 0;
  const hasHiddenEdges = hiddenEdgeKinds.size > 0;

  // 如果图中既没有任何有类型的节点，也没有任何边，则不渲染以保界面极简
  if (sortedTypes.length === 0 && Object.keys(edgeKindCounts).length === 0) {
    return null;
  }

  const isOnlyRelation =
    hiddenEdgeKinds.has("cooccur") &&
    hiddenEdgeKinds.has("contains") &&
    !hiddenEdgeKinds.has("relation");

  return (
    <div className="gfilter-bar">
      {/* ── 节点类型筛选 ── */}
      {sortedTypes.length > 0 && (
        <div className="gfilter-section">
          <span className="gfilter-title">实体类型</span>
          <button
            type="button"
            className={`gfilter-chip${!hasHiddenNodes ? " on" : ""}`}
            onClick={onResetNodeTypes}
            title="显示所有类型的实体节点"
          >
            全部
          </button>
          {sortedTypes.map((t) => {
            const isHidden = hiddenNodeTypes.has(t);
            const count = nodeTypeCounts[t] ?? 0;
            const color = entityTypeColor(t) ?? "#8b949e";
            return (
              <button
                key={t}
                type="button"
                className={`gfilter-chip${!isHidden ? " on" : " off"}`}
                onClick={() => onToggleNodeType(t)}
                title={`${isHidden ? "点击显示" : "点击隐藏"}「${t}」类型节点（共 ${count} 个）`}
              >
                <span
                  className="gfilter-dot"
                  style={{
                    backgroundColor: color,
                    boxShadow: !isHidden ? `0 0 6px ${color}88` : "none",
                  }}
                />
                <span>{t}</span>
                <span className="gfilter-count">{count}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* 分隔竖线 */}
      {sortedTypes.length > 0 && (
        <div className="gfilter-sep" aria-hidden="true" />
      )}

      {/* ── 边关系与去乱筛选 ── */}
      <div className="gfilter-section">
        <span className="gfilter-title">关系去乱</span>
        {/* 一键聚焦纯净语义关系 */}
        {edgeKindCounts.relation > 0 && (
          <button
            type="button"
            className={`gfilter-chip highlight-chip${isOnlyRelation ? " on" : ""}`}
            onClick={isOnlyRelation ? onResetEdgeKinds : onShowOnlyRelations}
            title="仅保留确凿的谓词语义关系（如高校研发、技术实现等），剔除稠密毛球边"
          >
            ✦ 仅语义
          </button>
        )}
        <button
          type="button"
          className={`gfilter-chip${!hasHiddenEdges ? " on" : ""}`}
          onClick={onResetEdgeKinds}
          title="显示所有关系边"
        >
          全显
        </button>
        {(["relation", "cooccur", "contains"] as EdgeKind[]).map((k) => {
          const count = edgeKindCounts[k] ?? 0;
          if (count === 0) return null;
          const isHidden = hiddenEdgeKinds.has(k);
          const meta = EDGE_KIND_LABELS[k];
          return (
            <button
              key={k}
              type="button"
              className={`gfilter-chip${!isHidden ? " on" : " off"}`}
              onClick={() => onToggleEdgeKind(k)}
              title={`${isHidden ? "点击显示" : "点击隐藏"}「${meta.label}」边：${meta.desc}（共 ${count} 条）`}
            >
              <span>{meta.label}</span>
              <span className="gfilter-count">{count}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
