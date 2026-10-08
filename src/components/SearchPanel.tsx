"use client";

/**
 * 左栏：搜索条件 + 逐站点结果 + 提供方日志。
 *
 * 「提供方日志」是刻意放在用户看得见的地方的。这套系统里最常见的困惑是
 * 「为什么知乎没有结果」—— 把每个 provider 在每个站点上的命中数与失败原因
 * 直接摊开，比让用户去猜有用得多。
 */

import type { ProviderLogEntry, SearchResult, SiteKey } from "@/core/types";
import { methodLabel } from "./NodeDetail";
import type { Document } from "@/core/types";

/** 站点展示名。与 core/search/sites.ts 的注册表保持一致。 */
export const SITE_LABELS: Record<SiteKey, string> = {
  zhihu: "知乎",
  xiaohongshu: "小红书",
  youtube: "YouTube",
  x: "X",
  bilibili: "B 站",
  web: "全网",
};

export interface SearchPanelProps {
  query: string;
  onQueryChange: (q: string) => void;
  sites: SiteKey[];
  onToggleSite: (s: SiteKey) => void;
  onSearch: () => void;
  searching: boolean;

  results: SearchResult[];
  logs: ProviderLogEntry[];
  /** 站点 → 该站点本轮的结果数，用于展示「哪些站点有货」。 */
  siteCounts: Map<SiteKey, number>;

  documents: Document[];
  onFetch: () => void;
  fetching: boolean;
  fetchProgress: { done: number; total: number } | null;

  onBuildGraph: () => void;
  building: boolean;
  graphError: string | null;
  hasGraph: boolean;
}

export default function SearchPanel(props: SearchPanelProps) {
  const {
    query, onQueryChange, sites, onToggleSite, onSearch, searching,
    results, logs, siteCounts,
    documents, onFetch, fetching, fetchProgress,
    onBuildGraph, building, graphError, hasGraph,
  } = props;

  const allSites: SiteKey[] = [
    "zhihu", "bilibili", "youtube", "xiaohongshu", "x", "web",
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* ── 搜索条件 ── */}
      <div className="panel" style={{ padding: 14 }}>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            className="input"
            style={{ flex: 1, minWidth: 0 }}
            placeholder="输入调研主题，例如：露营装备"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !searching && query.trim()) onSearch();
            }}
            disabled={searching}
          />
          <button
            className="btn btn-primary"
            onClick={onSearch}
            disabled={searching || !query.trim()}
          >
            {searching ? "搜索中…" : "搜索"}
          </button>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
          {allSites.map((s) => {
            const on = sites.includes(s);
            const count = siteCounts.get(s);
            return (
              <button
                key={s}
                className="badge"
                onClick={() => onToggleSite(s)}
                style={{
                  cursor: "pointer",
                  color: on ? "var(--accent)" : "var(--fg-dim)",
                  borderColor: on ? "#1f6feb66" : "var(--border)",
                  background: on ? "#1f6feb15" : "transparent",
                }}
                title="点击切换是否检索该站点"
              >
                {SITE_LABELS[s]}
                {count !== undefined && ` ${count}`}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── 后续动作 ── */}
      {results.length > 0 && (
        <div className="panel" style={{ padding: 14 }}>
          <h2>资料处理</h2>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <button
              className="btn"
              onClick={onFetch}
              disabled={fetching || searching}
            >
              {fetching
                ? `抓取正文中… ${fetchProgress ? `${fetchProgress.done}/${fetchProgress.total}` : ""}`
                : documents.length > 0
                  ? `重新抓取正文（已有 ${documents.length} 篇）`
                  : `抓取正文（${results.length} 条结果）`}
            </button>

            <button
              className="btn btn-primary"
              onClick={onBuildGraph}
              disabled={building || fetching || documents.length === 0}
              title={
                documents.length === 0
                  ? "需要先抓取正文才能构图"
                  : "基于已抓取的正文构建知识拓扑"
              }
            >
              {building
                ? "构建拓扑中…"
                : hasGraph
                  ? "重新构建拓扑"
                  : "构建知识拓扑"}
            </button>

            {documents.length === 0 && !fetching && (
              <p className="dim" style={{ fontSize: 12, margin: 0 }}>
                拓扑基于正文构建。摘要太短，用它构图只会得到一张按标题匹配的假图。
              </p>
            )}

            {graphError && (
              <p style={{ fontSize: 12, margin: 0, color: "var(--err)" }}>
                {graphError}
              </p>
            )}
          </div>

          {fetchProgress && fetching && (
            <div
              style={{
                marginTop: 10,
                height: 3,
                background: "var(--border-subtle)",
                borderRadius: 2,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  height: "100%",
                  background: "var(--accent)",
                  width: `${(fetchProgress.done / Math.max(1, fetchProgress.total)) * 100}%`,
                  transition: "width 0.3s",
                }}
              />
            </div>
          )}
        </div>
      )}

      {/* ── 提供方日志 ── */}
      {logs.length > 0 && (
        <div className="panel" style={{ padding: 14 }}>
          <h2>检索日志</h2>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {logs.map((l, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "baseline",
                  fontSize: 12,
                }}
              >
                <span
                  className="dot"
                  style={{ background: l.ok && l.count > 0 ? "var(--ok)" : "var(--fg-dim)" }}
                />
                <span className="mono" style={{ color: "var(--fg-muted)" }}>
                  {l.provider}
                </span>
                <span className="dim">@{SITE_LABELS[l.site] ?? l.site}</span>
                <span style={{ marginLeft: "auto" }} className="dim">
                  {l.count} 条 · {l.ms}ms
                </span>
                {l.error && (
                  <span
                    className="dim"
                    style={{ fontSize: 11, flexBasis: "100%", paddingLeft: 15 }}
                    title={l.error}
                  >
                    {l.error.slice(0, 60)}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── 结果列表 ── */}
      {results.length > 0 && (
        <ResultList results={results} documents={documents} />
      )}
    </div>
  );
}

function ResultList({
  results,
  documents,
}: {
  results: SearchResult[];
  documents: Document[];
}) {
  const docByUrl = new Map(documents.map((d) => [d.url, d]));

  // 按站点分组展示。融合后的 results 是全局排序的，但用户的心智模型是
  // 「知乎有什么、B 站有什么」，所以这里按站点重新分桶。
  const groups = new Map<SiteKey, SearchResult[]>();
  for (const r of results) {
    const list = groups.get(r.site);
    if (list) list.push(r);
    else groups.set(r.site, [r]);
  }

  const ordered = [...groups.entries()].sort(
    (a, b) => b[1].length - a[1].length,
  );

  return (
    <div className="panel" style={{ padding: 14 }}>
      <h2>搜索结果 · {results.length} 条</h2>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {ordered.map(([site, items]) => (
          <div key={site}>
            <div
              className="dim"
              style={{ fontSize: 11, marginBottom: 6, letterSpacing: "0.05em" }}
            >
              {SITE_LABELS[site] ?? site} · {items.length}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {items.map((r) => {
                const doc = docByUrl.get(r.url);
                return (
                  <a
                    key={r.id}
                    href={r.url}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      display: "block",
                      padding: "8px 10px",
                      background: "var(--bg)",
                      border: "1px solid var(--border-subtle)",
                      borderRadius: 6,
                      color: "var(--fg)",
                    }}
                  >
                    <div style={{ fontSize: 13, lineHeight: 1.4 }}>
                      {r.title || r.url}
                    </div>
                    <div
                      className="dim"
                      style={{
                        fontSize: 11,
                        marginTop: 3,
                        display: "flex",
                        gap: 6,
                        flexWrap: "wrap",
                      }}
                    >
                      <span>{r.domain}</span>
                      {r.durationSec !== undefined && (
                        <span>· {fmtDuration(r.durationSec)}</span>
                      )}
                      {r.hitCount > 1 && <span>· {r.hitCount} 个来源命中</span>}
                      {doc && (
                        <span style={{ color: "var(--ok)" }}>
                          · 已抓取 {doc.wordCount} 字（{methodLabel(doc.extractMethod)}）
                        </span>
                      )}
                    </div>
                  </a>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
