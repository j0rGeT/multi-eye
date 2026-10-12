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
  RefinementRecord,
  ResultSignal,
  SearchPlan,
  SearchResult,
  SiteKey,
  SortMode,
  TimeRange,
} from "@/core/types";
import { SITE_ORDER, providerLabel, siteShortLabel } from "@/core/search/sites";
import {
  KIND_FILTER_LABELS,
  KIND_FILTER_ORDER,
  SORT_LABELS,
  TIME_RANGE_LABELS,
  TIME_RANGE_ORDER,
  filterByKind,
  type KindFilter,
} from "@/core/search/filter";
import { formatDate, relativeTime } from "@/core/time";
import { BODY_GRADE_LABELS, bodyGrade } from "@/core/quality";
import { DOC_KIND_LABELS, contentKind } from "@/core/kind";
import { relevanceSummary } from "@/core/search/relevance";
import { formatSignalValue, signalSummary } from "@/core/signals";
import { methodLabel } from "./NodeDetail";
import FeedPanel from "./FeedPanel";
import ZhihuLogin from "./ZhihuLogin";
import IndustryPicker from "./IndustryPicker";
import { industryClause } from "@/core/search/industries";
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
  /** 关键词之外的用户意图提示。空串表示不填。 */
  intent: string;
  onIntentChange: (value: string) => void;
  sites: SiteKey[];
  onToggleSite: (s: SiteKey) => void;
  onSearch: () => void;
  searching: boolean;

  /** 用户选定的行业标签列表 */
  industries: string[];
  onIndustriesChange: (tags: string[]) => void;
  /** 搜索迭代深度 (1~6，默认 3) */
  depth: number;
  onDepthChange: (depth: number) => void;

  /** 时效窗口。空串表示不限。 */
  timeRange: TimeRange | "";
  onTimeRangeChange: (r: TimeRange | "") => void;
  sortMode: SortMode;
  onSortModeChange: (m: SortMode) => void;
  /** 上一次搜索的时效过滤副作用。null 表示还没搜过。 */
  timeFilter: { dropped: number; unknown: number } | null;

  /**
   * 本轮搜索的**查询分析**结果。null 表示还没搜过。
   *
   * 刻意把服务端的分析直接摊在界面上 —— 用户原话是「需要搜索词进行分析」，
   * 而分析如果不给人看，它就只是一段看不见的改写，出了偏差无从发现。
   */
  plan: SearchPlan | null;

  results: SearchResult[];
  logs: ProviderLogEntry[];
  /** 站点 → 该站点本轮的结果数，用于展示「哪些站点有货」。 */
  siteCounts: Map<SiteKey, number>;

  documents: Document[];
  onFetch: () => void;
  /** 点击已抓取资料时打开本地预览（Markdown / 视频）。 */
  onPreviewDocument: (doc: Document) => void;
  fetching: boolean;
  fetchProgress: { done: number; total: number } | null;
  /**
   * 抓取开始前的一句告知（目前只用于「跳过了 N 条疑似不相关的」）。
   *
   * 必须有这么一处：跳过的文档不会出现在进度条里，不说明的话用户只知道
   * 「我勾了 35 条，怎么只抓了 28 条」。
   */
  fetchNotice: string | null;

  onBuildGraph: () => void;
  building: boolean;
  graphError: string | null;
  /** 构图成功后的一句告知（目前只用于「N 篇疑似不相关，没进图」）。 */
  graphNotice: string | null;
  hasGraph: boolean;
  /** 抓取正文后，根据正文整理并发起受控补搜。 */
  onRefine: () => void;
  refining: boolean;
  refineNotice: string | null;
  /** 每轮整理补搜的完整记录（summary/categories/queries 等）。 */
  refinements: RefinementRecord[];
  refineIteration: number;
  refineMax: number;
  /** 自动流水线：整理 → 补搜 → 抓取 → 再整理，轮数与手动共用 refineMax。 */
  onPipeline: () => void;
  /** 全流程一键编排：搜索 → 抓取 → 整理补搜 → 构图。 */
  onResearch: () => void;
  pipelining: boolean;
  pipelineStage: string | null;
}

export default function SearchPanel(props: SearchPanelProps) {
  const {
    query, onQueryChange, intent, onIntentChange, sites, onToggleSite, onSearch, searching,
    industries, onIndustriesChange, depth, onDepthChange,
    timeRange, onTimeRangeChange, sortMode, onSortModeChange, timeFilter,
    plan, results, logs, siteCounts,
    documents, onFetch, onPreviewDocument, fetching, fetchProgress, fetchNotice,
    onBuildGraph, building, graphError, graphNotice, hasGraph,
    onRefine, refining, refineNotice, refinements, refineIteration, refineMax,
    onPipeline, onResearch, pipelining, pipelineStage,
  } = props;

  const allSites = SITE_ORDER;

  /*
    某个站点这一轮实际用的查询词。

    服务端的 `variantFor()`（`core/search/plan.ts`）就是这个规则，但那个模块
    import 了 `@/core/env`（读 process.env、引 node 内置模块），客户端组件引不
    进来。规则只有一行，这里照搬 —— **改一边必须同时改另一边**。
  */
  const queryFor = (s: SiteKey) => {
    if (!plan) return "";
    const base = plan.variants[s]?.trim() || plan.raw;
    const clauses = [base];
    const userIntent = plan.userIntent?.trim();
    if (userIntent && !base.toLowerCase().includes(userIntent.toLowerCase())) {
      clauses.push(userIntent);
    }
    const related = (plan.relatedTerms ?? []).filter((term) => term.trim());
    if (related.length > 0) {
      clauses.push(
        `(${related.slice(0, 4).map((term) => `"${term.trim()}"`).join(" OR ")})`,
      );
    }
    const indClause = industryClause(plan.industries);
    if (indClause) {
      clauses.push(indClause);
    }
    return clauses.join(" ");
  };

  /**
   * 真正被改写过查询词的站点。
   *
   * 按 `SITE_ORDER` 而非当前勾选列表来算：用户可以在搜完之后再去改勾选，
   * 而这份分析说的是**刚才那次搜索**，不该跟着勾选变。
   */
  const rewritten = plan
    ? allSites.filter((s) => {
        return queryFor(s) !== plan.raw;
      })
    : [];

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
              if (e.key === "Enter" && !searching && !pipelining && query.trim()) {
                onSearch();
              }
            }}
            disabled={searching || pipelining}
          />
          <button
            className="btn"
            onClick={onSearch}
            disabled={searching || pipelining || !query.trim()}
            title="只做第一步：多站点检索 + 相关性/价值预判，之后自己决定抓哪些"
          >
            {searching && !pipelining ? "搜索中…" : "仅搜索"}
          </button>
          <button
            className="btn btn-primary"
            onClick={onResearch}
            disabled={
              searching || pipelining || fetching || refining || !query.trim()
            }
            title="自动跑完整流程：搜索 → 抓取正文 → 智能整理补搜（最多3轮）→ 构建拓扑"
          >
            {pipelining ? "调研进行中…" : "一键调研"}
          </button>
        </div>

        {/*
          流水线阶段在「资料处理」面板里也有显示，但那个面板要等 results.length>0
          才挂载 —— 一键调研的第一阶段（搜索）恰恰还没出结果，这里必须有一份，
          否则用户点了按钮看着像没反应。
        */}
        {pipelining && pipelineStage && (
          <p className="dim" style={{ fontSize: 12, margin: "8px 0 0" }}>
            {pipelineStage}
          </p>
        )}

        <label style={{ display: "block", marginTop: 10 }}>
          <span className="dim" style={{ fontSize: 11 }}>
            用户意图提示（可选）
          </span>
          <textarea
            className="input"
            style={{
              display: "block",
              width: "100%",
              minHeight: 54,
              marginTop: 4,
              resize: "vertical",
              lineHeight: 1.45,
            }}
            placeholder="例如：只关注推理阶段的 KVCache、显存优化和实际吞吐，排除招聘与股价信息"
            value={intent}
            onChange={(e) => onIntentChange(e.target.value)}
            disabled={searching}
          />
        </label>

        {/* 行业分类多选/自填组件 */}
        <IndustryPicker
          value={industries}
          onChange={onIndustriesChange}
          disabled={searching}
        />

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
          知乎登录态。和 FeedPanel 同一条理由：只有勾了知乎才显示。
          它和别的源的区别是 —— 知乎 403 是唯一一类用户自己扫码就能消掉的
          失败，所以值得摆在这里，而不是藏在设置页里。
        */}
        {sites.includes("zhihu") && <ZhihuLogin />}

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
            深度
            <select
              className="input"
              style={{ padding: "3px 6px", fontSize: 12, width: "auto" }}
              value={depth}
              onChange={(e) => onDepthChange(Number(e.target.value))}
              disabled={searching}
              title="搜索与技术迭代深度（1~6轮，默认3轮），每轮提取技术细节并扩展检索词"
            >
              {[1, 2, 3, 4, 5, 6].map((d) => (
                <option key={d} value={d}>
                  {d} 轮 {d === 3 ? "（默认）" : ""}
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

      {/* ── 搜索词分析 ── */}
      {plan && (
        <div className="panel" style={{ padding: 14 }}>
          <h2>搜索词分析</h2>

          {plan.userIntent && (
            <div style={{ fontSize: 12, marginBottom: 6 }}>
              <span className="dim">用户意图：</span>
              {plan.userIntent}
            </div>
          )}

          {plan.industries && plan.industries.length > 0 && (
            <div style={{ fontSize: 12, marginBottom: 6 }}>
              <span className="dim">限定行业：</span>
              {plan.industries.join("、")}
            </div>
          )}

          {(plan.relatedTerms ?? []).length > 0 && (
            <div style={{ fontSize: 12, marginBottom: 6 }}>
              <span className="dim">关联检索词：</span>
              {(plan.relatedTerms ?? []).join("、")}
            </div>
          )}

          {plan.source === "lexical" ? (
            <p className="dim" style={{ fontSize: 12, margin: 0 }}>
              未做模型分析（{plan.fallbackReason ?? "未知原因"}），各站点按你的原话与意图提示检索。
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
              <div>
                <span className="dim">理解为：</span>
                {plan.intent}
              </div>

              {plan.entity.name && (
                <div>
                  <span className="dim">主题词：</span>
                  {plan.entity.name}
                  {plan.entity.aliases.length > 0 && (
                    <span className="dim">
                      {" "}· 也写作 {plan.entity.aliases.join(" / ")}
                    </span>
                  )}
                </div>
              )}

              {plan.disambiguators.length > 0 && (
                <div>
                  <span className="dim">限定：</span>
                  {plan.disambiguators.join("、")}
                </div>
              )}

              {plan.negatives.length > 0 && (
                <div>
                  <span className="dim">排除：</span>
                  {plan.negatives.join("、")}
                </div>
              )}
            </div>
          )}

          {rewritten.length > 0 && (
            <div style={{ marginTop: 10, fontSize: 12 }}>
              <div className="dim" style={{ marginBottom: 4 }}>
                各站点实际发出的查询词（含意图与关联词）：
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                {rewritten.map((s) => (
                  <div key={s} style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                    <span className="dim" style={{ minWidth: 72 }}>
                      {siteShortLabel(s)}
                    </span>
                    <span className="mono" style={{ wordBreak: "break-all" }}>
                      {queryFor(s)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {plan.source === "llm" && rewritten.length === 0 && (
            <p className="dim" style={{ fontSize: 12, marginTop: 10, marginBottom: 0 }}>
              分析后认为不必改写，各站点均按你的原话检索。
            </p>
          )}
        </div>
      )}

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

            {documents.length > 0 && (
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  className="btn"
                  style={{ flex: 1 }}
                  onClick={onRefine}
                  disabled={refining || pipelining || fetching || searching}
                  title="先整理已抓取正文的分类与缺口，再补搜一轮；最多三轮"
                >
                  {refining
                    ? "整理并补搜中…"
                    : refineIteration >= refineMax
                      ? `整理补搜已完成（${refineIteration}/${refineMax}）`
                      : `智能整理并补搜（${refineIteration}/${refineMax}）`}
                </button>
                <button
                  className="btn btn-primary"
                  style={{ flex: 1 }}
                  onClick={onPipeline}
                  disabled={pipelining || refining || fetching || searching}
                  title="自动跑「整理 → 补搜 → 过滤 → 抓取新增」循环，最多三轮；判为不相关的新结果不会花抓取成本"
                >
                  {pipelining
                    ? "流水线运行中…"
                    : `一键流水线（最多 ${refineMax} 轮）`}
                </button>
              </div>
            )}

            {pipelining && pipelineStage && (
              <p className="dim" style={{ fontSize: 12, margin: 0 }}>
                {pipelineStage}
              </p>
            )}

            {documents.length === 0 && !fetching && (
              <p className="dim" style={{ fontSize: 12, margin: 0 }}>
                拓扑基于正文构建。摘要太短，用它构图只会得到一张按标题匹配的假图。
              </p>
            )}

            {fetchNotice && (
              <p className="dim" style={{ fontSize: 12, margin: 0 }}>
                {fetchNotice}
              </p>
            )}

            {refineNotice && (
              <p className="dim" style={{ fontSize: 12, margin: 0 }}>
                {refineNotice}
              </p>
            )}

            {/* 构图成功但少了几篇 —— 用 dim 而不是红色：这不是错误 */}
            {graphNotice && (
              <p className="dim" style={{ fontSize: 12, margin: 0 }}>
                {graphNotice}
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

      {/* ── 整理与补搜记录 ── */}
      {refinements.length > 0 && (
        <RefinementHistoryPanel refinements={refinements} />
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
          onPreviewDocument={onPreviewDocument}
        />
      )}

      {documents.length > 0 && (
        <FetchedDocsPanel
          documents={documents}
          onPreviewDocument={onPreviewDocument}
        />
      )}
    </div>
  );
}

/**
 * 已抓取资料面板 —— 按整理阶段给出的分类分组，并把低价值的标出来。
 *
 * 分类与价值来自抓取完成后那次 LLM 整理（`core/search/value.ts`）：
 * 没走过整理的会话两个字段都缺，此时退化成「未分类」一列 —— **不猜分类**。
 *
 * 「隐藏低价值」默认关：与结果列表同一条纪律，筛选只改本地视图，
 * 数据一条没少，点一下就能看回来。
 */
function FetchedDocsPanel({
  documents,
  onPreviewDocument,
}: {
  documents: Document[];
  onPreviewDocument: (doc: Document) => void;
}) {
  const [hideLowValue, setHideLowValue] = useState(false);
  const lowValueCount = documents.filter((d) => d.lowValue).length;
  const visible = hideLowValue
    ? documents.filter((d) => !d.lowValue)
    : documents;

  /*
    分组：有分类的按分类，没分类的一律进「未分类」。
    Map 保持首次出现的顺序 —— 分类来自 LLM 输出顺序，重排只会让列表跳动。
  */
  const groups = new Map<string, Document[]>();
  for (const doc of visible) {
    const key = doc.category?.trim() || "未分类";
    const list = groups.get(key);
    if (list) list.push(doc);
    else groups.set(key, [doc]);
  }
  // 「未分类」永远垫底：它是缺省桶，不是一类主题
  const ordered = [...groups.entries()].sort((a, b) => {
    if (a[0] === "未分类") return 1;
    if (b[0] === "未分类") return -1;
    return b[1].length - a[1].length;
  });

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
        <h2 style={{ margin: 0 }}>已抓取资料 · {documents.length}</h2>
        <span className="dim" style={{ fontSize: 11 }}>
          点击标题打开本地预览
        </span>
      </div>

      {lowValueCount > 0 && (
        <p className="dim" style={{ fontSize: 11, margin: "6px 0 0" }}>
          其中 {lowValueCount} 篇被判为低价值（理由在条目上）；它们不进拓扑，
          但仍在列表、报告与下载包里。
          <button
            className="badge"
            onClick={() => setHideLowValue((v) => !v)}
            style={{
              cursor: "pointer",
              marginLeft: 6,
              color: hideLowValue ? "var(--accent)" : "var(--fg-dim)",
              borderColor: hideLowValue ? "#1f6feb66" : "var(--border)",
              background: hideLowValue ? "#1f6feb15" : "transparent",
            }}
          >
            {hideLowValue ? "恢复显示" : `暂时隐藏这 ${lowValueCount} 篇`}
          </button>
        </p>
      )}

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 12,
          marginTop: 10,
          maxHeight: 340,
          overflow: "auto",
        }}
      >
        {ordered.map(([category, docs]) => (
          <div key={category}>
            <div
              className="dim"
              style={{
                fontSize: 11,
                marginBottom: 6,
                letterSpacing: "0.05em",
              }}
            >
              {category} · {docs.length}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {docs.map((doc) => (
                <button
                  key={doc.id}
                  className="btn"
                  onClick={() => onPreviewDocument(doc)}
                  style={{
                    textAlign: "left",
                    width: "100%",
                    display: "block",
                    opacity: doc.lowValue ? 0.7 : 1,
                  }}
                  title={
                    doc.lowValue
                      ? `低价值：${doc.lowValue.reason}`
                      : contentKind(doc.site, doc.url) === "video"
                        ? "打开视频预览"
                        : "打开 Markdown 预览"
                  }
                >
                  <span
                    style={{
                      display: "flex",
                      gap: 8,
                      alignItems: "flex-start",
                      justifyContent: "space-between",
                    }}
                  >
                    <span
                      style={{
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {doc.title || doc.url}
                    </span>
                    <span className="badge" style={{ flexShrink: 0 }}>
                      {contentKind(doc.site, doc.url) === "video"
                        ? "视频预览"
                        : "Markdown 预览"}
                    </span>
                  </span>
                  {doc.lowValue && (
                    <span
                      style={{
                        display: "block",
                        fontSize: 11,
                        color: "var(--warn, #d29922)",
                        marginTop: 4,
                      }}
                    >
                      低价值 · {doc.lowValue.reason}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 整理与补搜的逐轮记录。
 *
 * 展示位置刻意放在「资料处理」之后、「检索日志」之前：它是流程产物（每轮
 * 补搜都会改变结果列表），用户想知道的是「这轮补搜为什么多了这几条」，
 * 答案（missingAngles/queries）就该挨着它产生的东西。
 *
 * 信息全部来自 `Session.refinements`，与服务端落盘的是同一份 ——
 * 界面不存在第二份「整理摘要」真相。
 */
function RefinementHistoryPanel({
  refinements,
}: {
  refinements: RefinementRecord[];
}) {
  return (
    <div className="panel" style={{ padding: 14 }}>
      <h2>整理与补搜记录 · {refinements.length} 轮</h2>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {refinements.map((r) => (
          <div
            key={r.iteration}
            style={{
              padding: "8px 10px",
              background: "var(--bg)",
              border: "1px solid var(--border-subtle)",
              borderRadius: 6,
              fontSize: 12,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 8,
                marginBottom: 4,
              }}
            >
              <strong>第 {r.iteration} 轮</strong>
              <span className="dim">{formatDate(r.at)}</span>
              <span
                className="badge"
                style={{ marginLeft: "auto", color: "var(--accent)" }}
              >
                新增 {r.added} 条
              </span>
            </div>

            <p style={{ margin: "4px 0" }}>{r.summary}</p>

            {r.categories.length > 0 && (
              <div style={{ marginTop: 6 }}>
                <span className="dim">已覆盖分类：</span>
                {r.categories.map((c) => (
                  <span key={c} className="badge" style={{ marginRight: 4 }}>
                    {c}
                  </span>
                ))}
              </div>
            )}

            {r.missingAngles.length > 0 && (
              <div style={{ marginTop: 6 }}>
                <span className="dim">补搜缺口：</span>
                {r.missingAngles.join("、")}
              </div>
            )}

            {r.queries.length > 0 && (
              <div style={{ marginTop: 6 }}>
                <span className="dim">实际补搜词：</span>
                <span className="mono" style={{ fontSize: 11 }}>
                  {r.queries.join("；")}
                </span>
              </div>
            )}

            {r.avoidPatterns.length > 0 && (
              <div className="dim" style={{ marginTop: 6, fontSize: 11 }}>
                规避：{r.avoidPatterns.join("、")}
              </div>
            )}

            {r.fallbackReason && (
              <div
                className="dim"
                style={{ marginTop: 6, fontSize: 11, color: "var(--warn, #d29922)" }}
              >
                本轮降级：{r.fallbackReason}
              </div>
            )}
          </div>
        ))}
      </div>
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
type GroupBy = "site" | "provider" | "kind";

function ResultList({
  results,
  documents,
  timeFilter,
  onPreviewDocument,
}: {
  results: SearchResult[];
  documents: Document[];
  timeFilter: { dropped: number; unknown: number } | null;
  onPreviewDocument: (doc: Document) => void;
}) {
  const docByUrl = new Map(documents.map((d) => [d.url, d]));
  // 把 duplicateOf 的 id 还原成标题，用于「与《X》同源」的提示
  const docById = new Map(documents.map((d) => [d.id, d]));
  const [groupBy, setGroupBy] = useState<GroupBy>("site");

  /*
    「暂时隐藏疑似不相关的」—— **默认关**。

    默认关是这个项目的一贯做法（见 duplicateOf）：标记是为了让人看见，
    不是为了让人看不见。开了也只是**本地视图**上的隐藏，数据一条没少 ——
    报告、打包、抓取都还是全量。真要删，得用户自己在抓取时勾选。
  */
  const [hideIrrelevant, setHideIrrelevant] = useState(false);
  const { judged, unlikely } = relevanceSummary(results);
  /*
    「暂时隐藏预判低价值的」——**默认关**，与 hideIrrelevant 同一条纪律：
    预判只凭标题摘要，可能判错（一个标题平平的深入长文）。隐藏只是本地
    视图，数据/抓取名单都不变 —— 抓取跳过的判定看 `pickTargets` 不看这里。
  */
  const [hideLowValueResults, setHideLowValueResults] = useState(false);
  const lowValueCount = results.filter(
    (r) => r.value?.verdict === "low",
  ).length;

  /* 暂时隐藏未命中所选行业的结果，默认关 */
  const [hideUnmatchedIndustry, setHideUnmatchedIndustry] = useState(false);
  const unmatchedIndustryCount = results.filter(
    (r) => r.industryMatch && r.industryMatch.matched.length === 0,
  ).length;

  /*
    「全部 / 仅视频 / 仅图文」——**默认全部**。

    和上面那个隐藏开关同一立场：筛选是本地视图，默认不该替用户把东西
    藏起来。要把视频和文章分开看时才点。

    类型是**现算**的：搜索结果还没有 Document（没抓正文），所以只能按
    `site + url` 推。用的是与抓取链、打包目录同一个 `contentKind`，
    所以列表里说的「视频」和包里 `视频/` 里的东西一定是一回事。
  */
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");

  const visible = filterByKind(
    (hideIrrelevant
      ? results.filter((r) => r.relevance?.verdict !== "unlikely")
      : results
    )
      .filter((r) => !hideLowValueResults || r.value?.verdict !== "low")
      .filter(
        (r) =>
          !hideUnmatchedIndustry ||
          !r.industryMatch ||
          r.industryMatch.matched.length > 0,
      ),
    kindFilter,
    (r) => contentKind(r.site, r.url),
  );

  // 融合后的 results 是全局排序的，但用户的心智模型是分桶的，
  // 所以这里按选定的维度重新分。
  const groups = new Map<string, SearchResult[]>();
  for (const r of visible) {
    const key =
      groupBy === "site"
        ? r.site
        : groupBy === "provider"
          ? r.provider
          : contentKind(r.site, r.url);
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
          {(["site", "provider", "kind"] as const).map((m) => (
            <button
              key={m}
              className="badge"
              onClick={() => setGroupBy(m)}
              title={
                m === "site"
                  ? "按内容所在的站点分组"
                  : m === "provider"
                    ? "按检索来源分组 —— 同一条资料可能由不同通道捞到"
                    : "按内容类型分组：视频 / 图文 / 社交长文"
              }
              style={{
                cursor: "pointer",
                // 与上面的站点芯片用同一套选中态配色，免得出现两种「被选中」
                color: groupBy === m ? "var(--accent)" : "var(--fg-dim)",
                borderColor: groupBy === m ? "#1f6feb66" : "var(--border)",
                background: groupBy === m ? "#1f6feb15" : "transparent",
              }}
            >
              {m === "site" ? "站点" : m === "provider" ? "来源" : "类型"}
            </button>
          ))}
        </div>
      </div>

      {/*
        「全部 / 仅视频 / 仅图文」。

        和下面那个相关性筛选同一立场：**默认全部**，筛选只改本地视图。
        条数直接标在按钮上，用户不用点一遍才知道哪种有多少。
      */}
      <div
        style={{
          display: "flex",
          gap: 4,
          alignItems: "center",
          margin: "0 0 10px",
        }}
      >
        {KIND_FILTER_ORDER.map((k) => {
          const n =
            k === "all"
              ? results.length
              : filterByKind(results, k, (r) => contentKind(r.site, r.url)).length;
          const on = kindFilter === k;
          return (
            <button
              key={k}
              className="badge"
              onClick={() => setKindFilter(k)}
              title={
                k === "all"
                  ? "不按类型筛，显示全部结果"
                  : `${KIND_FILTER_LABELS[k]}（社交长文与未知类型都归在「图文」侧，与下载包的目录划分一致）`
              }
              style={{
                cursor: "pointer",
                opacity: n === 0 && k !== "all" ? 0.45 : 1,
                color: on ? "var(--accent)" : "var(--fg-dim)",
                borderColor: on ? "#1f6feb66" : "var(--border)",
                background: on ? "#1f6feb15" : "transparent",
              }}
            >
              {KIND_FILTER_LABELS[k]} {n}
            </button>
          );
        })}
      </div>

      {/*
        相关性判定的结果。**标记，不下架** —— 默认全都看得见，
        这一行只是把「其中几条可能不是你要的」说出来，并给一个**默认关**的
        本地筛选。判据（为什么标它）在每条结果的悬浮里。

        措辞刻意是「疑似」：判定回答的是「切不切你的题」，判错的代价由用户
        自己一眼就能核实（点开看看），所以这里不做任何断言式的措辞。
      */}
      {unlikely > 0 && (
        <p className="dim" style={{ fontSize: 11, margin: "0 0 10px" }}>
          已判定 {judged} 条的切题度，其中{" "}
          <span style={{ color: "var(--warn, #d29922)" }}>
            {unlikely} 条疑似与主题不相关
          </span>
          （依据见每条结果的悬浮说明）。
          <button
            className="badge"
            onClick={() => setHideIrrelevant((v) => !v)}
            title={
              hideIrrelevant
                ? "恢复显示全部结果。隐藏只是视图上的 —— 报告与下载包里一条都没少。"
                : "只在列表里隐藏这些条目。报告与下载包仍然是全量的。"
            }
            style={{
              marginLeft: 6,
              cursor: "pointer",
              color: hideIrrelevant ? "var(--accent)" : "var(--fg-dim)",
              borderColor: hideIrrelevant ? "#1f6feb66" : "var(--border)",
              background: hideIrrelevant ? "#1f6feb15" : "transparent",
            }}
          >
            {hideIrrelevant ? "恢复显示" : `暂时隐藏这 ${unlikely} 条`}
          </button>
        </p>
      )}

      {/*
        价值预判的提示条，与相关性同一个位置：两种「不替你抓」的原因分开说 —
        用户看到的是同一个「抓取跳过了几条」的现象，但一个是「不切题」、
        一个是「切题但摘要看着就没内容」，混成一句就分不清是谁判的。
      */}
      {lowValueCount > 0 && (
        <p className="dim" style={{ fontSize: 11, margin: "0 0 10px" }}>
          另有{" "}
          <span style={{ color: "var(--warn, #d29922)" }}>
            {lowValueCount} 条预判参考价值较低
          </span>
          （抓取默认跳过，依据见条目悬浮）。
          <button
            className="badge"
            onClick={() => setHideLowValueResults((v) => !v)}
            title={
              hideLowValueResults
                ? "恢复显示全部结果。隐藏只是视图上的 —— 数据一条没少。"
                : "只在列表里隐藏这些条目。抓取名单也不变 —— 真要抓请在抓取时勾选。"
            }
            style={{
              marginLeft: 6,
              cursor: "pointer",
              color: hideLowValueResults ? "var(--accent)" : "var(--fg-dim)",
              borderColor: hideLowValueResults ? "#1f6feb66" : "var(--border)",
              background: hideLowValueResults ? "#1f6feb15" : "transparent",
            }}
          >
            {hideLowValueResults
              ? "恢复显示"
              : `暂时隐藏这 ${lowValueCount} 条`}
          </button>
        </p>
      )}

      {/* 行业过滤提示 */}
      {unmatchedIndustryCount > 0 && (
        <p className="dim" style={{ fontSize: 11, margin: "0 0 10px" }}>
          有{" "}
          <span style={{ color: "var(--fg-dim)" }}>
            {unmatchedIndustryCount} 条未命中所选行业
          </span>
          （保留在列表中供核查）。
          <button
            className="badge"
            onClick={() => setHideUnmatchedIndustry((v) => !v)}
            title={
              hideUnmatchedIndustry
                ? "恢复显示全部结果。"
                : "暂时隐藏未命中所选行业的结果。"
            }
            style={{
              marginLeft: 6,
              cursor: "pointer",
              color: hideUnmatchedIndustry ? "var(--accent)" : "var(--fg-dim)",
              borderColor: hideUnmatchedIndustry ? "#1f6feb66" : "var(--border)",
              background: hideUnmatchedIndustry ? "#1f6feb15" : "transparent",
            }}
          >
            {hideUnmatchedIndustry
              ? "恢复显示"
              : `暂时隐藏这 ${unmatchedIndustryCount} 条`}
          </button>
        </p>
      )}

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
              {groupBy === "site"
                ? siteShortLabel(key)
                : groupBy === "provider"
                  ? providerLabel(key)
                  : (DOC_KIND_LABELS[key as keyof typeof DOC_KIND_LABELS] ?? key)}{" "}
              · {items.length}
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
                    onClick={(event) => {
                      if (!doc) return;
                      // 已抓到正文的条目先看本地预览；原文链接仍保留在预览面板里。
                      event.preventDefault();
                      onPreviewDocument(doc);
                    }}
                    title={doc ? "点击预览已抓取内容；原文链接在预览面板中" : "打开原文"}
                    style={{
                      display: "block",
                      padding: "8px 10px",
                      background: "var(--bg)",
                      border: "1px solid var(--border-subtle)",
                      borderRadius: 6,
                      color: "var(--fg)",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        gap: 8,
                        alignItems: "flex-start",
                        justifyContent: "space-between",
                      }}
                    >
                      <div style={{ fontSize: 13, lineHeight: 1.4, minWidth: 0 }}>
                        {r.title || r.url}
                      </div>
                      {doc && (
                        <span
                          className="badge"
                          style={{ flexShrink: 0, color: "var(--accent)" }}
                        >
                          预览
                        </span>
                      )}
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
                      {r.relevance?.score !== undefined && (
                        <span
                          title={`与用户意图的关联度：${r.relevance.reason}`}
                          style={{ color: "var(--accent)" }}
                        >
                          · 关联 {Math.round(r.relevance.score * 100)}%
                        </span>
                      )}
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
                      {/*
                        疑似不相关。**只标记，链接照样能点、照样进报告和下载包。**
                        判定依据放在悬浮里 —— 用户必须能自己核实这一判，
                        否则一个说不清理由的「不相关」标签只能让人困惑。
                      */}
                      {r.relevance?.verdict === "unlikely" && (
                        <span
                          style={{ color: "var(--warn, #d29922)" }}
                          title={
                            `为什么标它：${r.relevance.reason}\n` +
                            `（判定来源：${r.relevance.source === "llm" ? "模型" : "本地规则"}）\n\n` +
                            "这只是「可能不是你要找的东西」，不是「内容有问题」——\n" +
                            "内容对不对，这个工具不判断。资料仍然保留在报告与下载包里。"
                          }
                        >
                          · 疑似不相关
                        </span>
                      )}
                      {/*
                        价值预判徽章：与「疑似不相关」并列但语义不同 ——
                        一个说「切不切题」，一个说「摘要看着有没有货」。
                        high 标出来是提示「这条值得先抓」，low 是「摘要阶段就不像有货」。
                      */}
                      {r.value?.verdict === "high" && (
                        <span
                          style={{ color: "var(--ok)" }}
                          title={`${r.value.category}：${r.value.reason}\n\n搜索阶段预判（只看标题与摘要）；抓取后还有一轮基于正文的复核。`}
                        >
                          · 高价值{r.value.category && r.value.category !== "未分类" ? ` · ${r.value.category}` : ""}
                        </span>
                      )}
                      {r.value?.verdict === "low" && (
                        <span
                          style={{ color: "var(--warn, #d29922)" }}
                          title={`为什么标它：${r.value.reason}\n（预判分类：${r.value.category}）\n\n只凭标题与摘要的第一印象；抓取时会默认跳过，但结果仍在列表与报告里。`}
                        >
                          · 预判低价值
                        </span>
                      )}
                      {r.industryMatch && r.industryMatch.matched.length > 0 && (
                        <span
                          style={{ color: "var(--accent)" }}
                          title={`命中所选行业：${r.industryMatch.matched.join("、")}`}
                        >
                          · 行业：{r.industryMatch.matched.join("/")}
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
