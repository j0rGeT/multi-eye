"use client";

import {
  GRAPH_STYLES,
  type GraphStyleKey,
} from "@/core/graph/palette";

/**
 * 图上的浮动工具栏。
 *
 * 全部是**视图操作**，没有一个是改数据的 —— 构图结果在服务端就已经定死了，
 * 这里能做的只是换个角度看它。这条界线让「重新布局」永远是安全的：它不会
 * 改变图里有什么，只会改变它们摆在哪。
 */

const STYLE_KEYS = Object.keys(GRAPH_STYLES) as GraphStyleKey[];

export interface GraphToolbarProps {
  onRelayout: () => void;
  onFit: () => void;
  /** 锁定当前选中的节点，让它们扛得住「重新布局」。 */
  onPinSelected: () => void;
  onUnpinAll: () => void;
  onExportPng: () => void;
  onToggleBoxSelect?: () => void;
  onFullscreen: () => void;
  /** 切换按年份分层布局 */
  onToggleYearlyLayout?: () => void;
  layoutMode?: "free" | "yearly";
  /** 切换下方时序折线图显示 */
  onToggleTimeline?: () => void;
  showTimeline?: boolean;
  /** 拓扑图空间维度模式："2d" (平面) | "3d" (三维空间星云) */
  dimensionMode?: "2d" | "3d";
  /** 切换 2D / 3D 维度模式 */
  onToggleDimension?: () => void;
  /** 当前拓扑图配色风格 */
  graphStyle?: GraphStyleKey;
  /** 切换拓扑图配色风格 */
  onStyleChange?: (style: GraphStyleKey) => void;
  /** 框选中。开启时平移会被关掉（Cytoscape 里两者互斥）。不传就不出这个按钮。 */
  boxSelect?: boolean;
  selectedCount: number;
  pinnedCount: number;
  fullscreen: boolean;
}

export default function GraphToolbar({
  onRelayout,
  onFit,
  onPinSelected,
  onUnpinAll,
  onExportPng,
  onToggleBoxSelect,
  onFullscreen,
  onToggleYearlyLayout,
  layoutMode = "free",
  onToggleTimeline,
  showTimeline = true,
  dimensionMode = "2d",
  onToggleDimension,
  graphStyle = "default",
  onStyleChange,
  boxSelect = false,
  selectedCount,
  pinnedCount,
  fullscreen,
}: GraphToolbarProps) {
  return (
    <div className="gtool">
      {onToggleDimension && (
        <button
          type="button"
          className={`gtool-btn${dimensionMode === "3d" ? " on" : ""}`}
          onClick={onToggleDimension}
          title={
            dimensionMode === "3d"
              ? "当前是三维空间星云视图。点击切回 2D 平面"
              : "切换为 3D 知识星云视图：左键拖拽旋转 · 滚轮缩放 · 右键平移"
          }
        >
          {dimensionMode === "3d" ? "2D 视图" : "3D 视图"}
        </button>
      )}

      <button type="button" className="gtool-btn" onClick={onRelayout}
        title="按当前的连接关系重新排布。已锁定的节点不会动">
        重新布局
      </button>
      <button type="button" className="gtool-btn" onClick={onFit}
        title="缩放到刚好装下整张图">
        适应窗口
      </button>

      {onToggleYearlyLayout && (
        <button
          type="button"
          className={`gtool-btn${layoutMode === "yearly" ? " on" : ""}`}
          onClick={onToggleYearlyLayout}
          title={
            layoutMode === "yearly"
              ? "当前为按年份分层布局。点击切回自由力导向"
              : "按资料发布年份分层布局：最新在顶层，历年向下拉开，呈现技术出现时序"
          }
        >
          {layoutMode === "yearly" ? "分层布局" : "按年份分层"}
        </button>
      )}

      {onToggleTimeline && (
        <button
          type="button"
          className={`gtool-btn${showTimeline ? " on" : ""}`}
          onClick={onToggleTimeline}
          title={showTimeline ? "隐藏下方的时序演变折线图" : "展开下方的技术节点时序演变折线图"}
        >
          {showTimeline ? "隐藏时序图" : "时序折线图"}
        </button>
      )}

      {onStyleChange && (
        <>
          <span className="gtool-sep" />
          {STYLE_KEYS.map((key) => {
            const st = GRAPH_STYLES[key];
            const active = graphStyle === key;
            return (
              <button
                key={key}
                type="button"
                className={`gtool-btn${active ? " on" : ""}`}
                onClick={() => onStyleChange(key)}
                title={`${st.label}风格：${st.description}`}
              >
                {st.label}
              </button>
            );
          })}
        </>
      )}

      <span className="gtool-sep" />

      <button
        type="button"
        className="gtool-btn"
        onClick={onPinSelected}
        disabled={selectedCount === 0}
        title="把选中的节点钉在原地。之后无论怎么重新布局、怎么切换资料节点，它们都不会动"
      >
        锁定{selectedCount > 0 ? ` ${selectedCount}` : ""}
      </button>
      <button
        type="button"
        className={`gtool-btn${pinnedCount > 0 ? " on" : ""}`}
        onClick={onUnpinAll}
        disabled={pinnedCount === 0}
        title="解除全部锁定。全部解锁后再点「重新布局」就是一次彻底重排"
      >
        解锁{pinnedCount > 0 ? ` ${pinnedCount}` : ""}
      </button>

      <span className="gtool-sep" />

      {onToggleBoxSelect && (
        <button
          type="button"
          className={`gtool-btn${boxSelect ? " on" : ""}`}
          onClick={onToggleBoxSelect}
          title="开启后按住拖拽是框选；此时平移改为按住空白处滚动，或按住空格拖拽"
        >
          框选{boxSelect && selectedCount > 0 ? ` ${selectedCount}` : ""}
        </button>
      )}
      <button type="button" className="gtool-btn" onClick={onExportPng}
        title="导出成 PNG 图片（2 倍分辨率，包含全部节点）">
        导出 PNG
      </button>
      <button type="button" className="gtool-btn" onClick={onFullscreen}
        title={fullscreen ? "退出全屏" : "图占满整个屏幕"}>
        {fullscreen ? "退出全屏" : "全屏"}
      </button>
    </div>
  );
}
