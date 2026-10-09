"use client";

/**
 * 主界面编排。
 *
 * 整个流程是一条线性状态机：搜索 → 抓取 → 构图。每一步的产物都留在页面上，
 * 不做「清空重来」—— 用户经常需要回头比对上一次的结果。
 *
 * 关于「只搜不抓」：抓取和构图是分离的两步，因为抓取是这条链里最慢的一环
 * （几十篇、每篇数秒）。分开之后用户可以只看搜索结果就走，不必为不需要的
 * 资料付抓取成本。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Document,
  FetchEvent,
  GraphModel,
  GraphNode,
  ProviderLogEntry,
  SearchEvent,
  SearchPlan,
  SearchResult,
  Session,
  SessionViewState,
  SiteKey,
  SortMode,
  TimeRange,
} from "@/core/types";
import { formatDate, relativeTime } from "@/core/time";
import { DEFAULT_SITES } from "@/core/search/sites";
import { postSse } from "@/components/postSse";
import SearchPanel from "@/components/SearchPanel";
import GraphView from "@/components/graph/GraphView";
import NodeDetail from "@/components/NodeDetail";
import DownloadPanel from "@/components/DownloadPanel";

export default function Home() {
  const [query, setQuery] = useState("");
  const [sites, setSites] = useState<SiteKey[]>(DEFAULT_SITES);
  const [timeRange, setTimeRange] = useState<TimeRange | "">("");
  const [sortMode, setSortMode] = useState<SortMode>("relevant");
  const [timeFilter, setTimeFilter] = useState<{
    dropped: number;
    unknown: number;
  } | null>(null);
  /** 当前会话是什么时候搜的。用来判断要不要提示「这批资料可能过时了」。 */
  const [searchedAt, setSearchedAt] = useState<string | null>(null);

  const [searching, setSearching] = useState(false);
  /** 这一轮的搜索词分析。搜完就留着，让用户随时能回看「当时是怎么理解的」。 */
  const [plan, setPlan] = useState<SearchPlan | null>(null);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [logs, setLogs] = useState<ProviderLogEntry[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [fetching, setFetching] = useState(false);
  const [fetchProgress, setFetchProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [documents, setDocuments] = useState<Document[]>([]);

  const [building, setBuilding] = useState(false);
  const [graph, setGraph] = useState<GraphModel | null>(null);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [showDocuments, setShowDocuments] = useState(true);

  /**
   * 上次离开这张图时的位置与锁定。只在挂载时交给 GraphView 读一次，
   * 之后由 GraphView 自己维护，保存回来的走 onViewChange。
   */
  const [viewState, setViewState] = useState<SessionViewState | undefined>();

  /** 左右两栏的展开状态。收起之后图立刻拿到整行宽度。 */
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);

  const abortRef = useRef<AbortController | null>(null);
  /** 本轮是否已经开始过搜索。用来防止「恢复上次会话」覆盖用户刚发起的新一轮。 */
  const startedRef = useRef(false);

  /**
   * 挂载时把上一次的会话读回来。
   *
   * 会话 id 存在浏览器本地，而不是加到 URL 上：这是个人工具，地址栏保持干净
   * 比可分享更重要。删掉这条记录就等于「下次从空白开始」。
   *
   * 恢复的价值主要在下载这一层 —— 任务在服务端自己跑，与这个标签页无关，
   * 但页面状态只活在内存里，刷新一次就找不回那个任务的入口了。
   */
  useEffect(() => {
    const last = localStorage.getItem(LAST_SESSION_KEY);
    if (!last) return;
    let cancelled = false;

    void (async () => {
      try {
        const res = await fetch(`/api/session?id=${encodeURIComponent(last)}`);
        if (!res.ok) {
          localStorage.removeItem(LAST_SESSION_KEY);
          return;
        }
        const { session } = (await res.json()) as { session: Session };
        // 用户可能已经在这段时间里开始了新的一轮搜索，别把它盖掉
        if (cancelled || startedRef.current) return;

        setQuery(session.topic.query);
        setSites(session.topic.sites);
        // 还原当时的检索口径。旧会话没有这两个字段（那时还没这功能），
        // 回退到「不限 / 印证优先」，也就是它的结果本来就是按这个口径出的
        setTimeRange(session.searchOptions?.timeRange ?? "");
        setSortMode(session.searchOptions?.sortMode ?? "relevant");
        setSearchedAt(session.createdAt ?? session.topic.createdAt ?? null);
        setResults(session.results);
        setDocuments(session.documents);
        setLogs(session.providerLog);
        setGraph(session.graph ?? null);
        setSessionId(session.topic.id);
        setViewState(session.viewState);
        // 「显示资料节点」也是会话状态的一部分，一并复原
        if (session.viewState?.showDocuments !== undefined) {
          setShowDocuments(session.viewState.showDocuments);
        }
      } catch {
        // 读不回来就当没这回事，页面照常空白启动
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const toggleSite = useCallback((s: SiteKey) => {
    setSites((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s],
    );
  }, []);

  /**
   * 保存图上的界面状态。GraphView 已经 debounce 过（800ms），这里直接发。
   *
   * 静默失败是刻意的：位置保存只是锦上添花，为了它弹一个错误框打断用户摆图
   * 是得不偿失。真的没存上，表现只是「下次打开回到上一次的布局」。
   */
  const handleViewChange = useCallback(
    (view: SessionViewState) => {
      if (!sessionId) return;
      void fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, viewState: view }),
      }).catch(() => {});
    },
    [sessionId],
  );

  // ── 搜索 ──
  const runSearch = useCallback(async () => {
    if (!query.trim() || searching) return;

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    startedRef.current = true;

    setSearching(true);
    setSearchError(null);
    // 新一轮搜索要清掉上一轮的所有产物，否则旧文档会混进新会话的图里
    setResults([]);
    setLogs([]);
    setDocuments([]);
    setGraph(null);
    setSelected(null);
    setSessionId(null);
    setTimeFilter(null);
    setSearchedAt(null);
    setPlan(null);
    // 位置是跟着**那张图**走的，换一轮主题就必须丢掉，
    // 否则新图会沿用上一个主题的坐标（同 id 的节点会被钉在毫不相干的位置）
    setViewState(undefined);

    try {
      await postSse<SearchEvent>(
        "/api/search",
        {
          query: query.trim(),
          sites,
          // 空串表示不限，服务端不认这个值，这里先归一成 undefined
          timeRange: timeRange || undefined,
          sortMode,
        },
        (e) => {
          switch (e.type) {
            case "results":
              setResults((prev) => mergeResults(prev, e.results));
              break;
            case "provider":
              setLogs((prev) => [...prev, e.log]);
              break;
            case "done":
              setSessionId(e.sessionId);
              setTimeFilter(e.timeFilter);
              setSearchedAt(new Date().toISOString());
              // 记住这一轮，刷新或重开页面时能接着用
              localStorage.setItem(LAST_SESSION_KEY, e.sessionId);
              break;
            case "error":
              setSearchError(e.message);
              break;
            case "plan":
              setPlan(e.plan);
              break;
          }
        },
        ac.signal,
      );
    } catch (err) {
      if (!ac.signal.aborted) setSearchError(errText(err));
    } finally {
      setSearching(false);
    }
  }, [query, sites, searching, timeRange, sortMode]);

  // ── 抓取 ──
  const runFetch = useCallback(async () => {
    if (!sessionId || fetching) return;

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setFetching(true);
    setFetchProgress(null);

    try {
      await postSse<FetchEvent>(
        "/api/fetch",
        { sessionId },
        (e) => {
          switch (e.type) {
            case "plan":
              setFetchProgress({ done: 0, total: e.total });
              break;
            case "doc":
              setFetchProgress({ done: e.done, total: e.total });
              setDocuments((prev) => [
                ...prev.filter((d) => d.url !== e.doc.url),
                e.doc,
              ]);
              break;
            case "done":
              break;
            case "error":
              setSearchError(e.message);
              break;
          }
        },
        ac.signal,
      );
    } catch (err) {
      if (!ac.signal.aborted) setSearchError(errText(err));
    } finally {
      setFetching(false);
      setFetchProgress(null);
    }
  }, [sessionId, fetching]);

  // ── 构图 ──
  const runBuildGraph = useCallback(async () => {
    if (!sessionId || building) return;
    setBuilding(true);
    setGraphError(null);
    setSelected(null);

    try {
      const res = await fetch("/api/graph", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });

      const data = (await res.json()) as {
        graph?: GraphModel;
        error?: string;
        usedDocuments?: number;
        ignoredDocuments?: number;
        tokenizer?: string;
      };

      if (!res.ok || !data.graph) {
        // 路由用 409 表达「正文不够，无法构图」，这不算错误而是一种状态，
        // 用户看到原因就够了
        setGraphError(data.error ?? `HTTP ${res.status}`);
        return;
      }

      setGraph(data.graph);
      setShowDocuments(true);
      // 重构图产出的是一张新的图（节点集合可能完全不同），旧坐标不该沿用
      setViewState(undefined);
    } catch (err) {
      setGraphError(errText(err));
    } finally {
      setBuilding(false);
    }
  }, [sessionId, building]);

  const siteCounts = new Map<SiteKey, number>();
  for (const r of results) {
    siteCounts.set(r.site, (siteCounts.get(r.site) ?? 0) + 1);
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          muti-eye
          <span>主题资源拓扑</span>
        </div>

        {graph && (
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span className="badge">
              {graph.stats.nodeCount} 节点
            </span>
            <span className="badge">{graph.stats.edgeCount} 边</span>
            <span className="badge">{graph.stats.clusterCount} 簇</span>
            <span className="badge">
              {graph.stats.generatedBy === "llm" ? "LLM 语义" : "本地启发式"}
            </span>
            {/* LLM 路径失败时会降级到启发式，原因必须可见 —— 否则用户会以为
                模型没生效是「效果就这样」 */}
            {graph.stats.llmFallbackReason && (
              <span className="badge badge-warn" title={graph.stats.llmFallbackReason}>
                已降级
              </span>
            )}
          </div>
        )}

        <div style={{ flex: 1 }} />

        {/*
          折叠开关放在顶栏而不是各栏自己的标题旁：收起之后那一栏就没了，
          按钮跟着消失的话，用户就再也找不回来。放顶栏则两个状态都在原位。
        */}
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <button
            type="button"
            className={`toggle-btn${leftOpen ? " on" : ""}`}
            onClick={() => setLeftOpen((v) => !v)}
            title={leftOpen ? "收起左栏，把宽度让给图" : "展开左栏"}
          >
            左栏
          </button>
          <button
            type="button"
            className={`toggle-btn${rightOpen ? " on" : ""}`}
            onClick={() => setRightOpen((v) => !v)}
            title={rightOpen ? "收起右栏，把宽度让给图" : "展开右栏"}
          >
            右栏
          </button>
        </div>

        {/*
          导出用普通链接而不是 fetch + Blob：路由已经带了
          Content-Disposition，浏览器认这个头就会走下载，不需要前端再把
          几十 KB 的文本绕一圈内存。也顺带保住了「在新标签页打开」的退路。
        */}
        {sessionId && results.length > 0 && (
          <a
            className="btn"
            href={`/api/export?sessionId=${encodeURIComponent(sessionId)}`}
            style={{ textDecoration: "none", fontSize: 13 }}
            title="导出为 Markdown 报告，同时落盘到 data/sessions/<id>/report.md"
          >
            导出报告
          </a>
        )}

        {graph && (
          <label
            className="badge"
            style={{ cursor: "pointer", gap: 6 }}
            title="文档节点多的时候图会很挤，可以只显示概念"
          >
            <input
              type="checkbox"
              checked={showDocuments}
              onChange={(e) => setShowDocuments(e.target.checked)}
              style={{ margin: 0 }}
            />
            显示资料节点
          </label>
        )}
      </header>

      <StaleBanner
        searchedAt={searchedAt}
        hasResults={results.length > 0}
        searching={searching}
        onResearch={runSearch}
        onRefetch={runFetch}
        fetching={fetching}
      />

      <main className="main">
        {/*
          三栏工作区。列宽算成 --cols 交给 CSS，因为要支持左右栏折叠 ——
          收起某一栏时直接从模板里去掉那条轨道，而不是把它压成 0 宽：
          0 宽的轨道仍然占着一个 gap，两栏都收起来就白扔 32px。
        */}
        <div
          className="workspace"
          style={
            {
              "--cols": [
                leftOpen ? "minmax(280px, 340px)" : null,
                "minmax(0, 1fr)",
                rightOpen ? "minmax(260px, 320px)" : null,
              ]
                .filter(Boolean)
                .join(" "),
            } as React.CSSProperties
          }
        >
          {/* ── 左栏 ── */}
          {leftOpen && (
            <SearchPanel
              query={query}
              onQueryChange={setQuery}
              sites={sites}
              timeRange={timeRange}
              onTimeRangeChange={setTimeRange}
              sortMode={sortMode}
              onSortModeChange={setSortMode}
              timeFilter={timeFilter}
              onToggleSite={toggleSite}
              onSearch={runSearch}
              searching={searching}
              plan={plan}
              results={results}
              logs={logs}
              siteCounts={siteCounts}
              documents={documents}
              onFetch={runFetch}
              fetching={fetching}
              fetchProgress={fetchProgress}
              onBuildGraph={runBuildGraph}
              building={building}
              graphError={graphError}
              hasGraph={graph !== null}
            />
          )}

          {/* ── 中栏：拓扑图 ── */}
          <div className="panel graph-panel">
            {graph ? (
              /*
                key 绑到会话 id：换一轮主题时不复用这个实例。Cytoscape 实例、
                位置表、锁定集合都是「一张图」的东西，跨会话复用会把上一个
                主题的坐标带进来。
              */
              <GraphView
                key={sessionId ?? "pending"}
                graph={graph}
                selectedId={selected?.id}
                onSelect={setSelected}
                showDocuments={showDocuments}
                initialView={viewState}
                onViewChange={handleViewChange}
              />
            ) : (
              <div className="empty">
                {building ? (
                  "正在构建拓扑…"
                ) : documents.length > 0 ? (
                  <>
                    已抓取 {documents.length} 篇正文
                    <br />
                    <span style={{ fontSize: 13 }}>
                      点击左侧「构建知识拓扑」
                    </span>
                  </>
                ) : (
                  <>
                    知识拓扑将在这里呈现
                    <br />
                    <span style={{ fontSize: 13 }}>
                      输入主题 → 搜索 → 抓取正文 → 构建拓扑
                    </span>
                  </>
                )}
              </div>
            )}
          </div>

          {/* ── 右栏：节点详情 ── */}
          {rightOpen && (
            <div className="panel" style={{ padding: 14 }}>
              <h2>节点详情</h2>
              {graph ? (
                <NodeDetail
                  node={selected}
                  graph={graph}
                  documents={documents}
                  onOpenDocument={(doc) =>
                    window.open(doc.url, "_blank", "noreferrer")
                  }
                />
              ) : (
                <p className="dim" style={{ fontSize: 12 }}>
                  构建拓扑后，点击任意节点查看它关联的原始资料。
                </p>
              )}
            </div>
          )}
        </div>

        {/*
          下载单独占一行而不是塞进某一栏：选项 + 按钮 + 逐条进度挤在 300px
          的窄栏里读不了。它本来也是流程里独立的一步 —— 前面几步的产物都
          已经留在页面上，用户可以只看不留。
        */}
        {sessionId && documents.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <DownloadPanel sessionId={sessionId} documents={documents} />
          </div>
        )}

        {searchError && (
          <div
            className="panel"
            style={{ marginTop: 16, borderColor: "var(--err)" }}
          >
            <strong style={{ color: "var(--err)", fontSize: 13 }}>
              出错了
            </strong>
            <p className="muted" style={{ margin: "6px 0 0", fontSize: 13 }}>
              {searchError}
            </p>
          </div>
        )}
      </main>
    </div>
  );
}

/**
 * 增量合并搜索结果。
 *
 * 按 url 去重：同一个页面被多个站点桶命中时（比如一篇知乎专栏既出现在
 * zhihu 桶又出现在 web 桶），只保留先到的那条，避免列表里出现重复项。
 */
function mergeResults(
  prev: SearchResult[],
  incoming: SearchResult[],
): SearchResult[] {
  const seen = new Set(prev.map((r) => r.url));
  const merged = [...prev];
  for (const r of incoming) {
    if (seen.has(r.url)) continue;
    seen.add(r.url);
    merged.push(r);
  }
  return merged;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 会话放多久算「可能过时」。7 天：再久，搜索结果里的链接和内容都会开始失效。 */
const STALE_AFTER_MS = 7 * 86_400_000;

/**
 * 陈旧会话提示。
 *
 * ── 为什么必须有这个 ──
 *
 * 这个应用会自动接回上一次的会话（刷新页面、第二天重开浏览器都是），
 * 而会话里存的是**当时**的搜索结果和正文。用户看到的界面和刚搜完一模一样，
 * 完全没有迹象表明这批资料可能已经过时 —— 他会以为自己看到的是最新的。
 *
 * ── 为什么给两个按钮 ──
 *
 * 「重新搜索」和「重新抓取」是两件不同的事：前者重跑搜索层（可能发现新资料，
 * 但也可能因为上游波动而变少），后者只是把已有链接的正文重抓一遍（内容可能
 * 被更新或删除）。合成一个按钮等于替用户决定要哪种，而这两种代价和结果都不同。
 */
function StaleBanner({
  searchedAt,
  hasResults,
  searching,
  onResearch,
  onRefetch,
  fetching,
}: {
  searchedAt: string | null;
  hasResults: boolean;
  searching: boolean;
  onResearch: () => void;
  onRefetch: () => void;
  fetching: boolean;
}) {
  if (!searchedAt || !hasResults) return null;

  const t = Date.parse(searchedAt);
  if (Number.isNaN(t) || Date.now() - t < STALE_AFTER_MS) return null;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        flexWrap: "wrap",
        padding: "8px 16px",
        background: "#3d2c0a",
        borderBottom: "1px solid #6b4e12",
        fontSize: 12,
      }}
    >
      <span style={{ color: "#e3b341" }}>
        本次会话搜索于 {relativeTime(searchedAt)}（{formatDate(searchedAt)}），
        资料可能已经过时。
      </span>
      <button className="btn" onClick={onResearch} disabled={searching || fetching}>
        重新搜索
      </button>
      <button className="btn" onClick={onRefetch} disabled={searching || fetching}>
        重新抓取正文
      </button>
    </div>
  );
}

/** 上次用的会话 id。见挂载时那段恢复逻辑。 */
const LAST_SESSION_KEY = "mutieye:lastSession";
