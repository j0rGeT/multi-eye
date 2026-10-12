"use client";

import { useMemo } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
} from "recharts";
import type { Document, GraphModel } from "@/core/types";
import { buildTrendData } from "@/core/graph/timeline";
import { clusterColor } from "@/core/graph/palette";

interface TrendChartProps {
  graph: GraphModel;
  documents: Document[];
  selectedId?: string;
  onSelectNode?: (nodeId: string) => void;
}

export default function TrendChart({
  graph,
  documents,
  selectedId,
  onSelectNode,
}: TrendChartProps) {
  const { years, series, unknownDocs } = useMemo(() => {
    return buildTrendData(graph, documents, 8);
  }, [graph, documents]);

  // 把 series 数据转换为 Recharts 所需的行格式:
  // [{ year: 2023, "DeepSeek-V3": 2, "KVCache": 5 }, ...]
  const chartData = useMemo(() => {
    if (years.length === 0) return [];

    return years.map((year) => {
      const row: Record<string, number | string> = { year: String(year) };
      for (const s of series) {
        const pt = s.points.find((p) => p.year === year);
        row[s.label] = pt?.count ?? 0;
      }
      return row;
    });
  }, [years, series]);

  // 给每条曲线指定稳定的颜色（根据簇索引分配调色板颜色）
  const seriesMeta = useMemo(() => {
    const clusterMap = new Map<string, number>();
    graph.clusters.forEach((c, idx) => clusterMap.set(c.id, idx));

    return series.map((s, idx) => {
      const cIdx = clusterMap.get(s.clusterId) ?? idx;
      const color = clusterColor(cIdx);
      return {
        ...s,
        color,
      };
    });
  }, [series, graph.clusters]);

  if (series.length === 0) {
    return (
      <div
        style={{
          padding: "16px",
          textAlign: "center",
          fontSize: 12,
          color: "var(--fg-dim)",
        }}
      >
        暂无可提取的技术概念节点
      </div>
    );
  }

  if (years.length < 2) {
    return (
      <div
        style={{
          padding: "14px 18px",
          fontSize: 12,
          color: "var(--fg-dim)",
          background: "var(--bg-subtle)",
          borderRadius: 6,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span>
          资料的时间维度单一（仅涵盖 {years.length === 1 ? `${years[0]} 年` : "未标注发布时间"}）
          ，收集更多跨年份资料后将呈现出现时序折线。
        </span>
        {unknownDocs > 0 && (
          <span className="dim" style={{ fontSize: 11 }}>
            （另有 {unknownDocs} 篇资料无发布日期）
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        background: "var(--bg-subtle)",
        border: "1px solid var(--border-subtle)",
        borderRadius: 8,
        padding: "10px 14px",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--fg)" }}>
            📈 核心技术节点时序演变折线图
          </span>
          <span className="dim" style={{ fontSize: 11 }}>
            （节点关联资料在各年度的出现频次分布）
          </span>
        </div>
        {unknownDocs > 0 && (
          <span className="dim" style={{ fontSize: 11 }}>
            注：{unknownDocs} 篇资料无发布日期未计入时间轴
          </span>
        )}
      </div>

      <div style={{ width: "100%", height: 180 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData} margin={{ top: 8, right: 16, left: -20, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" />
            <XAxis
              dataKey="year"
              stroke="#8b949e"
              fontSize={11}
              tickLine={false}
            />
            <YAxis
              allowDecimals={false}
              stroke="#8b949e"
              fontSize={11}
              tickLine={false}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "#161b22",
                borderColor: "#30363d",
                borderRadius: "6px",
                fontSize: "12px",
                boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
              }}
              labelStyle={{ color: "#c9d1d9", fontWeight: 600, marginBottom: 4 }}
            />
            <Legend
              wrapperStyle={{ fontSize: 11, paddingTop: 4 }}
              iconType="circle"
              iconSize={8}
            />
            {seriesMeta.map((s) => {
              const isSelected = selectedId === s.nodeId;
              return (
                <Line
                  key={s.nodeId}
                  type="monotone"
                  dataKey={s.label}
                  stroke={s.color}
                  strokeWidth={isSelected ? 3 : 1.6}
                  strokeOpacity={selectedId && !isSelected ? 0.35 : 1}
                  dot={{ r: isSelected ? 4 : 2.5 }}
                  activeDot={{ r: 5, strokeWidth: 1 }}
                  cursor="pointer"
                  onClick={() => onSelectNode?.(s.nodeId)}
                />
              );
            })}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
