"use client";

/**
 * 节点详情侧栏。
 *
 * 「知识拓扑」与「词云」的区别就在这个面板：点一个概念，这里列出支撑它的
 * 原始资料，每一条都能点回原文。图是入口，资料才是终点。
 */

import type { Document, GraphModel, GraphNode } from "@/core/types";
import { dateSpan, formatDate, formatSpan } from "@/core/time";

export interface NodeDetailProps {
  node: GraphNode | null;
  graph: GraphModel;
  documents: Document[];
  /** 从节点详情跳去看某篇文档。 */
  onOpenDocument: (doc: Document) => void;
}

export default function NodeDetail({
  node,
  graph,
  documents,
  onOpenDocument,
}: NodeDetailProps) {
  if (!node) {
    return (
      <div className="empty" style={{ padding: "32px 16px", fontSize: 13 }}>
        点击图中的节点
        <br />
        查看它的关联资料
      </div>
    );
  }

  const docById = new Map(documents.map((d) => [d.id, d]));
  const cluster = graph.clusters.find((c) => c.id === node.clusterId);

  // 文档节点只有自己一篇；概念节点列出全部支撑资料
  const related = node.docIds
    .map((id) => docById.get(id))
    .filter((d): d is Document => Boolean(d));

  /** 与当前节点相连的概念 —— 用于「这个概念常和什么一起出现」。 */
  const neighbors = neighborLabels(node, graph);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
            {node.label}
          </h3>
          <span className="badge">
            {node.kind === "keyword"
              ? "概念"
              : node.kind === "entity"
                ? "实体"
                : "资料"}
          </span>
        </div>
        <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>
          权重 {node.weight.toFixed(2)} · 连接 {node.degree} · 支撑 {related.length} 篇
        </div>
      </div>

      {cluster && (
        <div
          style={{
            padding: "10px 12px",
            background: "var(--bg)",
            border: "1px solid var(--border-subtle)",
            borderRadius: 6,
          }}
        >
          <div className="dim" style={{ fontSize: 11, marginBottom: 4 }}>
            所属簇 · {cluster.size} 个概念 / {cluster.docIds.length} 篇资料
          </div>
          {/*
            heuristic 路径下 summary 是统计式的一句话（由模板拼出），
            LLM 路径下才是模型写的综述。这里不做区分地展示 —— 用户不需要
            知道它是怎么来的，只需要知道这一簇在讲什么。
          */}
          <div style={{ fontSize: 13 }}>{cluster.summary}</div>
        </div>
      )}

      {neighbors.length > 0 && (
        <div>
          <div className="dim" style={{ fontSize: 11, marginBottom: 6 }}>
            共现概念
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {neighbors.map((n) => (
              <span key={n.id} className="badge" title={`连接强度 ${n.weight}`}>
                {n.label}
              </span>
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="dim" style={{ fontSize: 11, marginBottom: 6 }}>
          支撑资料
        </div>
        {related.length === 0 && (
          <p className="dim" style={{ fontSize: 12 }}>
            这篇资料没有可提取的正文（可能只拿到了搜索摘要）。
          </p>
        )}
        {related.length > 0 && <SpanLine docs={related} />}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {related.map((doc) => (
            <button
              key={doc.id}
              onClick={() => onOpenDocument(doc)}
              style={{
                textAlign: "left",
                padding: "9px 11px",
                background: "var(--bg)",
                border: "1px solid var(--border-subtle)",
                borderRadius: 6,
                color: "var(--fg)",
                display: "block",
                width: "100%",
              }}
            >
              <div style={{ fontSize: 13, lineHeight: 1.4, marginBottom: 3 }}>
                {doc.title || doc.url}
              </div>
              <div className="dim" style={{ fontSize: 11 }}>
                {doc.site} · {doc.wordCount} 字 · {methodLabel(doc.extractMethod)}
                {/*
                  发布于 ≠ 抓取于，分开放。没有发布日期时这一整段都不出现 ——
                  拿 fetchedAt 顶上会让人以为一篇旧文是刚发的。
                */}
                {doc.publishedAt && ` · 发布于 ${formatDate(doc.publishedAt)}`}
                {/*
                  同源转载。这里尤其要标出来：这个面板的作用就是让用户判断
                  「这个概念有几篇资料在支撑」，而三篇其实是同一篇被转了三手，
                  和有三种独立说法，是完全不同的证据强度。
                */}
                {doc.duplicateOf && (
                  <span style={{ color: "var(--warn, #d29922)" }}> · 同源转载</span>
                )}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** 取与 node 相连的概念标签，按边权降序。 */
function neighborLabels(
  node: GraphNode,
  graph: GraphModel,
): { id: string; label: string; weight: number }[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const out: { id: string; label: string; weight: number }[] = [];

  for (const e of graph.edges) {
    // 只看概念之间的共现边：contains 边连的是资料，不是「相关概念」
    if (e.kind !== "cooccur") continue;
    let otherId: string | undefined;
    if (e.source === node.id) otherId = e.target;
    else if (e.target === node.id) otherId = e.source;
    if (!otherId) continue;

    const other = byId.get(otherId);
    if (!other) continue;
    out.push({ id: other.id, label: other.label, weight: e.weight });
  }

  return out.sort((a, b) => b.weight - a.weight).slice(0, 12);
}

/**
 * 支撑资料的时间分布 —— 给「时效感」，零副作用。
 *
 * 「这个概念有几篇资料在支撑」回答了**证据有多厚**，但没回答**有多新**：
 * 4 篇全来自 2019 年，和 4 篇来自上个月，是完全不同的两件事。
 *
 * 刻意**不动拓扑权重**。图的权重回答的是「语义结构长什么样」，把「新颖度」
 * 混进去会让权重无法解释（见 P8.5 的取舍）；所以时间只在这里如实展示。
 *
 * 只统计 `publishedAt`，**绝不用 `fetchedAt` 顶上** —— 那是「我们什么时候去看的」，
 * 不是「这篇文章什么时候写的」。没有发布日期的资料单独报出数量，否则
 * 「4 篇 · 跨度 X」会让人以为这 4 篇全都落在那段区间里。
 */
function SpanLine({ docs }: { docs: Document[] }) {
  const span = formatSpan(dateSpan(docs.map((d) => d.publishedAt)));
  const dated = docs.filter((d) => d.publishedAt).length;

  // 一个可解析的日期都没有：直说，而不是显示一个空跨度
  if (!span) {
    return (
      <p className="dim" style={{ fontSize: 11, margin: "0 0 8px" }}>
        这 {docs.length} 篇都没有发布日期，无法判断新旧。
      </p>
    );
  }

  const undated = docs.length - dated;
  return (
    <p className="dim" style={{ fontSize: 11, margin: "0 0 8px" }}>
      {dated} 篇有发布日期 · 跨度 {span}
      {undated > 0 && `（另 ${undated} 篇日期未知）`}
    </p>
  );
}

export function methodLabel(m: Document["extractMethod"]): string {
  switch (m) {
    case "readability":
      return "正文";
    case "playwright":
      return "无头浏览器";
    case "ytdlp-subtitle":
      return "字幕";
    case "bilibili-api":
      return "B站接口";
    case "raw":
      return "仅摘要";
  }
}
