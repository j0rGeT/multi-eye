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

import { useCallback, useRef, useState } from "react";
import type {
  Document,
  FetchEvent,
  GraphModel,
  GraphNode,
  ProviderLogEntry,
  SearchEvent,
  SearchResult,
  SiteKey,
} from "@/core/types";
import { postSse } from "@/components/postSse";
import SearchPanel from "@/components/SearchPanel";
import GraphView from "@/components/GraphView";
import NodeDetail from "@/components/NodeDetail";

export default function Home() {
  const [query, setQuery] = useState("");
  const [sites, setSites] = useState<SiteKey[]>([
    "zhihu", "bilibili", "youtube", "web",
  ]);

  const [searching, setSearching] = useState(false);
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

  const abortRef = useRef<AbortController | null>(null);

  const toggleSite = useCallback((s: SiteKey) => {
    setSites((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s],
    );
  }, []);

  // ── 搜索 ──
  const runSearch = useCallback(async () => {
    if (!query.trim() || searching) return;

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setSearching(true);
    setSearchError(null);
    // 新一轮搜索要清掉上一轮的所有产物，否则旧文档会混进新会话的图里
    setResults([]);
    setLogs([]);
    setDocuments([]);
    setGraph(null);
    setSelected(null);
    setSessionId(null);

    try {
      await postSse<SearchEvent>(
        "/api/search",
        { query: query.trim(), sites },
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
              break;
            case "error":
              setSearchError(e.message);
              break;
            case "plan":
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
  }, [query, sites, searching]);

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
              {graph.stats.generatedBy === "llm" ? "Claude 语义" : "本地启发式"}
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

      <main className="main">
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(280px, 340px) minmax(0, 1fr) minmax(260px, 320px)",
            gap: 16,
            alignItems: "start",
          }}
        >
          {/* ── 左栏 ── */}
          <SearchPanel
            query={query}
            onQueryChange={setQuery}
            sites={sites}
            onToggleSite={toggleSite}
            onSearch={runSearch}
            searching={searching}
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

          {/* ── 中栏：拓扑图 ── */}
          <div
            className="panel"
            style={{ padding: 0, overflow: "hidden", minHeight: 560 }}
          >
            {graph ? (
              <GraphView
                graph={graph}
                selectedId={selected?.id}
                onSelect={setSelected}
                showDocuments={showDocuments}
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
        </div>

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
