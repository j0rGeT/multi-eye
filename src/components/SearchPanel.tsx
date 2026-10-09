"use client";

/**
 * 左栏：搜索条件 + 逐站点结果 + 提供方日志。
 *
 * 「提供方日志」是刻意放在用户看得见的地方的。这套系统里最常见的困惑是
 * 「为什么知乎没有结果」—— 把每个 provider 在每个站点上的命中数与失败原因
 * 直接摊开，比让用户去猜有用得多。
 */

import { useState } from "react";
import type {
  ProviderLogEntry,
  ResultSignal,
  SearchResult,
  SiteKey,
  SortMode,
  TimeRange,
} from "@/core/types";
import { SITE_ORDER, providerLabel, siteShortLabel } from "@/core/search/sites";
import {
  SORT_LABELS,
  TIME_RANGE_LABELS,
  TIME_RANGE_ORDER,
} from "@/core/search/filter";
import { formatDate, relativeTime } from "@/core/time";
import { BODY_GRADE_LABELS, bodyGrade } from "@/core/quality";
import { formatSignalValue, signalSummary } from "@/core/signals";
import { methodLabel } from "./NodeDetail";
import FeedPanel from "./FeedPanel";
import type { Document } from "@/core/types";

/** 排序模式的一句话解释 —— 挂在下拉框的 title 上。 */
const SORT_HELP: Record<SortMode, string> = {
  relevant:
    "默认。被多个独立来源提到的资料排在前面，其次按上游排名。这是「多源印证优先」的核心主张。",
  recent: "按发布日期降序。没有发布日期的排在最后 —— 我们不知道它有多新，插在中间就是编造秩序。",
  mixed: "印证数与新鲜度各占一部分权重，30 天半衰期。",
  quality:
    "按来源自带的客观指标（star / 播放 / 评论）排，没有任何指标的一律排最后。\n注意：它排的是「公开声量」，不是「内容是否正确」。一个 20k star 的仓库仍然可能有坑，一条百万播放的视频仍然可能是错的。",
};

export interface SearchPanelProps {
  query: string;
  onQueryChange: (q: string) => void;
  sites: SiteKey[];
  onToggleSite: (s: SiteKey) => void;
  onSearch: () => void;
  searching: boolean;

  /** 时效窗口。空串表示不限。 */
  timeRange: TimeRange | "";
  onTimeRangeChange: (r: TimeRange | "") => void;
  sortMode: SortMode;
  onSortModeChange: (m: SortMode) => void;
  /** 上一次搜索的时效过滤副作用。null 表示还没搜过。 */
  timeFilter: { dropped: number; unknown: number } | null;

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
    timeRange, onTimeRangeChange, sortMode, onSortModeChange, timeFilter,
    results, logs, siteCounts,
    documents, onFetch, fetching, fetchProgress,
    onBuildGraph, building, graphError, hasGraph,
  } = props;

  const allSites = SITE_ORDER;

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
                {siteShortLabel(s)}
                {count !== undefined && ` ${count}`}
              </button>
            );
          })}
        </div>

        {/*
          订阅源管理。只在勾了 RSS 这个源时才显示 —— 没勾的时候摆一个
          「订阅管理」在那儿，用户会以为它对所有源都生效。
        */}
        {sites.includes("rss") && <FeedPanel />}

        {/*
          时效与排序。放在搜索条件里而不是结果之上，是因为它们是**下一次搜索
          的输入**，不是对已有结果的视图操作 —— 勾完要点「搜索」才生效。
        */}
        <div
          style={{
            display: "flex",
            gap: 10,
            marginTop: 12,
            alignItems: "center",
            flexWrap: "wrap",
            fontSize: 12,
          }}
        >
          <label className="dim" style={{ display: "flex", gap: 6, alignItems: "center" }}>
            时效
            <select
              className="input"
              style={{ padding: "3px 6px", fontSize: 12, width: "auto" }}
              value={timeRange}
              onChange={(e) => onTimeRangeChange(e.target.value as TimeRange | "")}
              disabled={searching}
              title="只保留该时间窗口内发布的资料。没有发布日期的结果会被保留并标注。"
            >
              <option value="">不限</option>
              {TIME_RANGE_ORDER.map((r) => (
                <option key={r} value={r}>
                  {TIME_RANGE_LABELS[r]}
                </option>
              ))}
            </select>
          </label>

          <label className="dim" style={{ display: "flex", gap: 6, alignItems: "center" }}>
            排序
            <select
              className="input"
              style={{ padding: "3px 6px", fontSize: 12, width: "auto" }}
              value={sortMode}
              onChange={(e) => onSortModeChange(e.target.value as SortMode)}
              disabled={searching}
              title={SORT_HELP[sortMode]}
            >
              {(Object.keys(SORT_LABELS) as SortMode[]).map((m) => (
                <option key={m} value={m}>
                  {SORT_LABELS[m]}
                </option>
              ))}
            </select>
          </label>
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
                <span className="dim">@{siteShortLabel(l.site)}</span>
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
        <ResultList
          results={results}
          documents={documents}
          timeFilter={timeFilter}
        />
      )}
    </div>
  );
}

/**
 * 结果分组方式。
 *
 * `site` 回答「知乎有什么、B 站有什么」，是用户最常见的心智模型，所以是默认。
 * `provider` 回答「这批资料是从哪条通道捞回来的」—— 引入主题源之后这两者不再
 * 等价：一条 HN story 的内容可能住在 github.com，按站点归是 GitHub、按来源归是
 * Hacker News。想知道「HN 这个源到底给了什么」就只能看来源视图。
 */
type GroupBy = "site" | "provider";

function ResultList({
  results,
  documents,
  timeFilter,
}: {
  results: SearchResult[];
  documents: Document[];
  timeFilter: { dropped: number; unknown: number } | null;
}) {
  const docByUrl = new Map(documents.map((d) => [d.url, d]));
  // 把 duplicateOf 的 id 还原成标题，用于「与《X》同源」的提示
  const docById = new Map(documents.map((d) => [d.id, d]));
  const [groupBy, setGroupBy] = useState<GroupBy>("site");

  // 融合后的 results 是全局排序的，但用户的心智模型是分桶的，
  // 所以这里按选定的维度重新分。
  const groups = new Map<string, SearchResult[]>();
  for (const r of results) {
    const key = groupBy === "site" ? r.site : r.provider;
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }

  const ordered = [...groups.entries()].sort(
    (a, b) => b[1].length - a[1].length,
  );

  return (
    <div className="panel" style={{ padding: 14 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 10,
        }}
      >
        <h2>搜索结果 · {results.length} 条</h2>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <span className="dim" style={{ fontSize: 11 }}>按</span>
          {(["site", "provider"] as const).map((m) => (
            <button
              key={m}
              className="badge"
              onClick={() => setGroupBy(m)}
              title={
                m === "site"
                  ? "按内容所在的站点分组"
                  : "按检索来源分组 —— 同一条资料可能由不同通道捞到"
              }
              style={{
                cursor: "pointer",
                // 与上面的站点芯片用同一套选中态配色，免得出现两种「被选中」
                color: groupBy === m ? "var(--accent)" : "var(--fg-dim)",
                borderColor: groupBy === m ? "#1f6feb66" : "var(--border)",
                background: groupBy === m ? "#1f6feb15" : "transparent",
              }}
            >
              {m === "site" ? "站点" : "来源"}
            </button>
          ))}
        </div>
      </div>

      {/*
        时效筛选的副作用必须说出来。用户勾了「一周内」却看到一批资料，
        如果没有这行提示，他无从知道其中多少条是**因为没写日期而无法判断**、
        于是被保留下来的 —— 那样「一周内」看起来像一条没生效的筛选。
      */}
      {timeFilter && (timeFilter.dropped > 0 || timeFilter.unknown > 0) && (
        <p className="dim" style={{ fontSize: 11, margin: "0 0 10px" }}>
          {timeFilter.dropped > 0 && `已按时间窗口筛掉 ${timeFilter.dropped} 条。`}
          {timeFilter.unknown > 0 &&
            `另 ${timeFilter.unknown} 条没有发布日期、无从判断新旧，已保留并标为「日期未知」。`}
        </p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {ordered.map(([key, items]) => (
          <div key={key}>
            <div
              className="dim"
              style={{ fontSize: 11, marginBottom: 6, letterSpacing: "0.05em" }}
            >
              {groupBy === "site" ? siteShortLabel(key) : providerLabel(key)} ·{" "}
              {items.length}
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
                      {/*
                        有发布日期才显示时间，没有就什么都不显示。

                        这里**绝不**回退到 fetchedAt（「抓取于…」）—— 那是
                        「我们什么时候去看的」，不是「这篇文章什么时候写的」。
                        拿它顶替发布时间，用户会把一篇 2019 年的文章当成今天发的。
                      */}
                      {r.publishedAt && (
                        <span title={`发布于 ${formatDate(r.publishedAt)}`}>
                          · {relativeTime(r.publishedAt)}发布
                        </span>
                      )}
                      {r.durationSec !== undefined && (
                        <span>· {fmtDuration(r.durationSec)}</span>
                      )}
                      {/*
                        上游给的客观指标原样摆出来。它们不是「质量分」——
                        只是「播放 12.3万 · 弹幕 456」这样的事实，判断留给用户。
                      */}
                      {r.signals && r.signals.length > 0 && (
                        <span title={signalTitle(r.signals)}>
                          · {signalSummary(r.signals)}
                        </span>
                      )}
                      {/*
                        「来源」= 不同的检索入口，**不是**不同的独立出处。
                        转载会被折叠（见报告里的同源转载一栏），所以这个数字
                        本身不构成可信度证据 —— 悬浮里把话说全。
                      */}
                      {r.hitCount > 1 && (
                        <span
                          title={
                            `命中的检索入口：${(r.sources ?? []).map(providerLabel).join("、")}\n\n` +
                            "这是「有几个入口指向这里」，不是「有几个独立来源证实了它」：\n" +
                            "同一个病毒式假消息也会被很多入口提到，\n" +
                            "而多家转载同一篇稿子仍然只是一个信息源。"
                          }
                        >
                          · {r.hitCount} 个来源命中
                        </span>
                      )}
                      {/*
                        同源转载标记。只提示、不隐藏 —— 链接照样能点，
                        但读者知道这一篇不算独立出处。
                      */}
                      {doc?.duplicateOf && (
                        <span
                          style={{ color: "var(--warn, #d29922)" }}
                          title={
                            `与《${docById.get(doc.duplicateOf)?.title ?? "另一篇"}》正文高度相似，` +
                            "判定为同源转载。\n统计独立出处时两篇只算一个。"
                          }
                        >
                          · 同源转载
                        </span>
                      )}
                      {doc && <BodyBadge doc={doc} />}
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

/** 声量指标的悬浮解释 —— 点名它**不是**可信度。 */
function signalTitle(signals: ResultSignal[]): string {
  return [
    signals.map((s) => `${s.label} ${formatSignalValue(s)}`).join("\n"),
    "",
    "这是来源给出的客观计数，不是内容可信度：",
    "高播放/高 star 只说明很多人在看，不说明它是对的。",
  ].join("\n");
}

/**
 * 抓取结果的正文分级标记。
 *
 * 三档用颜色区分是有意的：`full` 是常态，不必强调；而 `snippet` 意味着
 * **这条根本没有正文**，只有搜索摘要 —— 拿它进语料，拓扑会退化成一张按
 * 标题匹配的假图（启发式构图按正文长度给文档权重，摘要长度全在同一个
 * 量级，权重也就全被拉平）。所以这件事必须在结果列表里就能一眼看出来。
 */
function BodyBadge({ doc }: { doc: Document }) {
  const grade = bodyGrade(doc);
  const color =
    grade === "full" ? "var(--ok)" : grade === "thin" ? "var(--warn)" : "var(--err)";

  const title =
    grade === "snippet"
      ? `没有抓到正文，正文退化为搜索摘要。${doc.error ? `原因：${doc.error}` : ""}`
      : grade === "thin"
        ? `${doc.wordCount} 字。可能是短视频/短贴，也可能抓成了导航栏 —— 点开看一眼。`
        : `${doc.wordCount} 字正文。`;

  return (
    <span style={{ color }} title={title}>
      · {BODY_GRADE_LABELS[grade]} {doc.wordCount} 字（{methodLabel(doc.extractMethod)}）
    </span>
  );
}
