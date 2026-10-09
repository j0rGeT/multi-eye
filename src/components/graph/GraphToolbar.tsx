"use client";

/**
 * 图上的浮动工具栏。
 *
 * 全部是**视图操作**，没有一个是改数据的 —— 构图结果在服务端就已经定死了，
 * 这里能做的只是换个角度看它。这条界线让「重新布局」永远是安全的：它不会
 * 改变图里有什么，只会改变它们摆在哪。
 */

export interface GraphToolbarProps {
  onRelayout: () => void;
  onFit: () => void;
  /** 锁定当前选中的节点，让它们扛得住「重新布局」。 */
  onPinSelected: () => void;
  onUnpinAll: () => void;
  onExportPng: () => void;
  onToggleBoxSelect: () => void;
  onFullscreen: () => void;
  /** 框选中。开启时平移会被关掉（Cytoscape 里两者互斥）。 */
  boxSelect: boolean;
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
  boxSelect,
  selectedCount,
  pinnedCount,
  fullscreen,
}: GraphToolbarProps) {
  return (
    <div className="gtool">
      <button type="button" className="gtool-btn" onClick={onRelayout}
        title="按当前的连接关系重新排布。已锁定的节点不会动">
        重新布局
      </button>
      <button type="button" className="gtool-btn" onClick={onFit}
        title="缩放到刚好装下整张图">
        适应窗口
      </button>

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

      <button
        type="button"
        className={`gtool-btn${boxSelect ? " on" : ""}`}
        onClick={onToggleBoxSelect}
        title="开启后按住拖拽是框选；此时平移改为按住空白处滚动，或按住空格拖拽"
      >
        框选{boxSelect && selectedCount > 0 ? ` ${selectedCount}` : ""}
      </button>
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
