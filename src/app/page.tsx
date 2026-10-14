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
  RefinementRecord,
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
import {
  DEFAULT_GRAPH_STYLE,
  resolveGraphStyle,
  type GraphStyleKey,
} from "@/core/graph/palette";
import { postSse } from "@/components/postSse";
import SearchPanel from "@/components/SearchPanel";
import GraphView from "@/components/graph/GraphView";
import GraphView3D from "@/components/graph/GraphView3D";
import NodeDetail from "@/components/NodeDetail";
import DownloadPanel from "@/components/DownloadPanel";
import DocumentPreview from "@/components/DocumentPreview";

export default function Home() {
  const [query, setQuery] = useState("");
  const [intent, setIntent] = useState("");
  const [industries, setIndustries] = useState<string[]>([]);
  const [depth, setDepth] = useState<number>(3);
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
  /**
   * 抓取前的告知。目前只有一件事要说：默认跳过了几条疑似不相关的。
   *
   * 跳过的文档不占进度条的任何一格，不说的话用户只知道「勾了 35 条、
   * 只跑了 28 条」，会当成抓取漏了。
   */
  const [fetchNotice, setFetchNotice] = useState<string | null>(null);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [refining, setRefining] = useState(false);
  const [refineNotice, setRefineNotice] = useState<string | null>(null);
  /**
   * 每轮「整理 + 补搜」的完整记录（summary/categories/missingAngles/…）。
   *
   * 不只是一个计数器：用户得看见 LLM 每轮都「看出了什么、补了什么词」，
   * 否则补搜只是界面上一次黑盒抖动。记录从 session.refinements 恢复，
   * 与磁盘一致。
   */
  const [refinements, setRefinements] = useState<RefinementRecord[]>([]);
  const refineIteration = refinements.length;
  /** 自动流水线（整理 → 补搜 → 抓取 → 再整理）是否在跑。 */
  const [pipelining, setPipelining] = useState(false);
  /** 流水线当前阶段，进度条之外的一句话。 */
  const [pipelineStage, setPipelineStage] = useState<string | null>(null);

  const [building, setBuilding] = useState(false);
  const [graph, setGraph] = useState<GraphModel | null>(null);
  const [graphError, setGraphError] = useState<string | null>(null);
  /** 构图成功、但有几篇没进图时的说明（与 graphError 互斥）。 */
  const [graphNotice, setGraphNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  /** 节点详情上的动作（删除 / 深入搜索 / 拓展节点）是否在进行中。 */
  const [nodeAction, setNodeAction] = useState<"remove" | "search" | "expand" | null>(null);
  /** 当前打开的资料预览。文章走 Markdown，视频走平台播放器。 */
  const [previewDocument, setPreviewDocument] = useState<Document | null>(null);
  const [showDocuments, setShowDocuments] = useState(true);
  const [graphStyle, setGraphStyle] = useState<GraphStyleKey>(DEFAULT_GRAPH_STYLE);
  const [graphDimension, setGraphDimension] = useState<"2d" | "3d">("2d");

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
    const savedStyle = localStorage.getItem(GRAPH_STYLE_KEY);
    if (savedStyle) {
      setGraphStyle(resolveGraphStyle(savedStyle));
    }
    const savedDimension = localStorage.getItem(GRAPH_DIMENSION_KEY);
    if (savedDimension === "3d" || savedDimension === "2d") {
      setGraphDimension(savedDimension);
    }

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
        setIntent(session.topic.intent ?? session.searchOptions?.intent ?? "");
        setIndustries(session.searchOptions?.industries ?? []);
        setDepth(session.searchOptions?.depth ?? 3);
        setSites(session.topic.sites);
        // 还原当时的检索口径。旧会话没有这两个字段（那时还没这功能），
        // 回退到「不限 / 印证优先」，也就是它的结果本来就是按这个口径出的
        setTimeRange(session.searchOptions?.timeRange ?? "");
        setSortMode(session.searchOptions?.sortMode ?? "relevant");
        setSearchedAt(session.createdAt ?? session.topic.createdAt ?? null);
        setPlan(session.plan ?? null);
        setResults(session.results);
        setDocuments(session.documents);
        setLogs(session.providerLog);
        setGraph(session.graph ?? null);
        setSessionId(session.topic.id);
        setRefinements(session.refinements ?? []);
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

  const handleStyleChange = useCallback((nextStyle: GraphStyleKey) => {
    setGraphStyle(nextStyle);
    try {
      localStorage.setItem(GRAPH_STYLE_KEY, nextStyle);
    } catch {
      // 忽略存储异常
    }
  }, []);

  /** 2D 平面 ↔ 3D 星云。偏好跟着浏览器走，跟会话无关。 */
  const handleToggleDimension = useCallback(() => {
    setGraphDimension((prev) => {
      const next = prev === "2d" ? "3d" : "2d";
      try {
        localStorage.setItem(GRAPH_DIMENSION_KEY, next);
      } catch {
        // 忽略存储异常
      }
      return next;
    });
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
  /**
   * 搜索的内部实现，接受外部 AbortSignal 与完成回调。
   *
   * 从 `runSearch` 抽出来而不是在 runSearch 里嵌 useRef 存 sessionId：
   * 「一键调研」需要在同一个闭包里拿到刚搜出来的 sessionId 去调 /api/fetch，
   * 而 React state 在 setSessionId 之后要到下一次渲染才生效 —— 回调里存
   * 本地变量才是能立刻读到的真相。
   */
  const searchCore = useCallback(
    async (signal: AbortSignal): Promise<{ sessionId: string; total: number } | null> => {
      let sid: string | null = null;
      let total = 0;

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
      setRefineNotice(null);
      setRefinements([]);
      // 位置是跟着**那张图**走的，换一轮主题就必须丢掉，
      // 否则新图会沿用上一个主题的坐标（同 id 的节点会被钉在毫不相干的位置）
      setViewState(undefined);

      try {
        await postSse<SearchEvent>(
          "/api/search",
          {
            query: query.trim(),
            intent: intent.trim() || undefined,
            industries: industries.length > 0 ? industries : undefined,
            depth,
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
                sid = e.sessionId;
                total = e.total;
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
              case "relevance":
                /*
                  判定比结果晚到，所以这里是**补写**已有的那批结果，而不是追加。

                  贴在 `results` 上（与服务端同形）而不是另存一个 map：这样
                  结果列表、徽章、统计读的都是同一个 `r.relevance`/`r.value`，
                  不会出现「两处各有一份、其中一处忘了更新」。
                */
                setResults((prev) =>
                  prev.map((r) => {
                    const relevance = e.verdicts[r.id];
                    const value = e.values?.[r.id];
                    if (!relevance && !value) return r;
                    return {
                      ...r,
                      ...(relevance ? { relevance } : {}),
                      ...(value ? { value } : {}),
                    };
                  }),
                );
                break;
            }
          },
          signal,
        );
      } catch (err) {
        if (!signal.aborted) setSearchError(errText(err));
      } finally {
        setSearching(false);
      }

      return sid ? { sessionId: sid, total } : null;
    },
    [query, intent, industries, depth, sites, timeRange, sortMode],
  );

  const runSearch = useCallback(async () => {
    if (!query.trim() || searching) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    startedRef.current = true;
    await searchCore(ac.signal);
  }, [query, searching, searchCore]);

  // ── 抓取 ──
  /**
   * 抓取的内部实现。
   *
   * @param sid 目标会话 —— 显式传入而不是读 state：「一键调研」里搜索刚返回、
   *   `sessionId` state 还没落地时就要抓，传参是同一闭包里唯一可靠的值。
   * @param resultIds 只抓这几条搜索结果。省略则按默认规则抓（排除疑似不相关
   *   与预判低价值）。显式给出时服务端**原样尊重**，不再做筛选 —— 这正是
   *   「只重抓失败和低质的」和「手动勾选几条重抓」共用的恢复路径。
   * @param signal 外部 AbortSignal，一键编排全程共用同一个。
   *
   * @returns 本次抓取后文档总数（含旧文档），0 表示没抓到可用正文。
   */
  const fetchCore = useCallback(
    async (
      sid: string,
      resultIds: string[] | undefined,
      signal: AbortSignal,
    ): Promise<number> => {
      setFetching(true);
      setFetchProgress(null);
      setFetchNotice(null);

      // plan 事件给「跳过了几条」，done 事件才有「渲染了几篇」——
      // 两条提示要能同时出现，所以这里把前一半先记下来，到 done 时一起合成
      let skippedIrrelevant = 0;
      let skippedLowValue = 0;
      let skippedLowQuality = 0;
      let docCount = 0;

      try {
        await postSse<FetchEvent>(
          "/api/fetch",
          resultIds && resultIds.length > 0
            ? { sessionId: sid, resultIds }
            : { sessionId: sid },
          (e) => {
            switch (e.type) {
              case "plan":
                setFetchProgress({ done: 0, total: e.total });
                skippedIrrelevant = e.skippedIrrelevant;
                skippedLowValue = e.skippedLowValue ?? 0;
                skippedLowQuality = e.skippedLowQuality ?? 0;
                setFetchNotice(
                  fetchNoticeText(
                    skippedIrrelevant,
                    skippedLowValue,
                    skippedLowQuality,
                    0,
                  ),
                );
                break;
              case "doc":
                setFetchProgress({ done: e.done, total: e.total });
                setDocuments((prev) => [
                  ...prev.filter((d) => d.url !== e.doc.url),
                  e.doc,
                ]);
                break;
              case "done":
                docCount = e.documents;
                setFetchNotice(
                  fetchNoticeText(
                    skippedIrrelevant,
                    skippedLowValue,
                    skippedLowQuality,
                    e.byMethod.playwright,
                    e.lowValue,
                  ),
                );
                /*
                  价值分类是在**全部抓完之后**才跑的（那时才有完整正文），
                  所以上面逐条推来的 `doc` 事件里没有 category / lowValue。
                  这里整份重读一次会话，把分类结果补进列表 —— 不重读的话，
                  界面上永远看不到「已按类别分组」和「低价值」标记。
                */
                void (async () => {
                  try {
                    const res = await fetch(
                      `/api/session?id=${encodeURIComponent(e.sessionId)}`,
                      { cache: "no-store" },
                    );
                    if (!res.ok) return;
                    const data = (await res.json()) as { session?: Session };
                    if (data.session?.documents) {
                      setDocuments(data.session.documents);
                      docCount = data.session.documents.length;
                    }
                  } catch {
                    // 刷新失败只影响分类显示，资料本身已经落盘，不值得弹错
                  }
                })();
                break;
              case "error":
                setSearchError(e.message);
                break;
            }
          },
          signal,
        );
      } catch (err) {
        if (!signal.aborted) setSearchError(errText(err));
      } finally {
        setFetching(false);
        setFetchProgress(null);
      }

      return docCount;
    },
    [],
  );

  /**
   * @param resultIds 只抓这几条搜索结果。省略则按默认规则抓（排除疑似不相关）。
   *   显式给出时服务端**原样尊重**，不再做相关性筛选 —— 这正是「只重抓失败
   *   和低质的」和「手动勾选几条不相关的重抓」共用的恢复路径。
   *
   *   注意这个参数**不能**直接挂到 `onClick` 上：React 会把事件对象当第一个
   *   实参传进来。调用方要么包一层 `() => runFetch()`，要么显式传数组。
   */
  const runFetch = useCallback(
    async (resultIds?: string[]) => {
      if (!sessionId || fetching) return;
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      await fetchCore(sessionId, resultIds, ac.signal);
    },
    [sessionId, fetching, fetchCore],
  );

  // ── 整理 + 受控补搜 ──
  /**
   * /api/refine 响应的类型。`record` 与 `Session.refinements` 的元素同形 —
   * 服务端把整份 RefinementRecord 原样回传，前端直接收进数组就能展示。
   */
  type RefineResponse = {
    error?: string;
    done?: boolean;
    message?: string;
    record?: RefinementRecord;
    results?: SearchResult[];
    plan?: SearchPlan;
    maxIterations?: number;
  };

  /**
   * 发起一轮「整理 + 补搜」。
   *
   * @returns `{record, added}`：record 为 null 表示已达上限或出错（此时
   *   `done`/`message` 里有原因）；added 是本轮补搜出的新结果（已经过
   *   相关性 + 价值预判标记）。
   */
  const refineCore = useCallback(
    async (
      sid: string,
      signal?: AbortSignal,
    ): Promise<{ record: RefinementRecord | null; added: SearchResult[]; done?: boolean; message?: string }> => {
      const res = await fetch("/api/refine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: sid }),
        signal,
      });
      const data = (await res.json()) as RefineResponse;

      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      if (data.done || !data.record) {
        return {
          record: null,
          added: [],
          done: true,
          message: data.message ?? "已达到补搜轮次上限",
        };
      }

      const record = data.record;
      setRefinements((prev) => [
        ...prev.filter((r) => r.iteration !== record.iteration),
        record,
      ]);
      setPlan(data.plan ?? null);
      const added = data.results ?? [];
      if (added.length) setResults((prev) => mergeResults(prev, added));

      return { record, added };
    },
    [],
  );

  const runRefine = useCallback(async () => {
    if (!sessionId || refining || fetching || searching) return;
    setRefining(true);
    setRefineNotice(null);
    setSearchError(null);

    try {
      const { record, done, message } = await refineCore(sessionId);
      if (!record) {
        setRefineNotice(message ?? (done ? "已达到补搜轮次上限" : "整理失败"));
        return;
      }
      setRefineNotice(
        `第 ${record.iteration} 轮整理：${record.summary} ` +
          `新增 ${record.added} 条候选` +
          (record.missingAngles.length
            ? `；补搜角度：${record.missingAngles.slice(0, 3).join("、")}`
            : ""),
      );
    } catch (err) {
      setSearchError(errText(err));
    } finally {
      setRefining(false);
    }
  }, [sessionId, refining, fetching, searching, refineCore]);

  /**
   * 自动流水线：整理 → 补搜 → 抓取新增 → 再整理，最多 REFINE_MAX 轮。
   *
   * 每一轮四段各自独立：
   *   1. 整理 —— LLM 看已抓正文，产出分类、缺口与补搜词（/api/refine）
   *   2. 补搜 —— 沿用站点、相关性/价值判定与去重，只报新增结果
   *   3. 过滤 —— 判死（unlikely / 预判 low）的新结果不花抓取成本，但计数说出来
   *   4. 抓取 —— 只抓这一轮新增且没被过滤的，老资料一个字节都不重下
   *
   * 轮数上限与手动按钮共用 REFINE_MAX：两条路径各算各的话，用户先点手动
   * 再点自动，实际迭代次数会翻倍。任何一段失败都停下并保留已完成的轮次。
   *
   * @param sid 显式会话 —— 「一键调研」搜索刚返回时 `sessionId` state 还没落地。
   * @param signal 外部 AbortSignal；不传则自建并挂到 abortRef（独立按钮场景）。
   */
  const pipelineCore = useCallback(
    async (
      sid: string,
      signal: AbortSignal,
      stagePrefix: string,
    ): Promise<{ rounds: number; addedTotal: number; fetchedTotal: number }> => {
      let rounds = 0;
      let addedTotal = 0;
      let fetchedTotal = 0;

      const maxDepth = depth || 3;
      for (let round = 1; round <= maxDepth; round++) {
        setPipelineStage(`${stagePrefix}整理已抓正文…`);
        const { record, added, done, message } = await refineCore(sid, signal);
        if (!record) {
          if (done) setRefineNotice(message ?? "已达到整理补搜轮次上限");
          break;
        }

        rounds = record.iteration;
        addedTotal += added.length;

        /*
          过滤。判定是服务端在 searchAll 里做完才回来的，这里只按 verdict
          分拣：判死（不相关/预判低价值）的不抓；uncertain 与未预判的照抓 ——
          本地规则拿不准时宁可多抓一条，也不能因为拿不准就丢掉一份可能有用的资料。
        */
        const fetchable = added.filter(
          (r) =>
            r.relevance?.verdict !== "unlikely" && r.value?.verdict !== "low",
        );
        const skipped = added.length - fetchable.length;

        setRefineNotice(
          `第 ${record.iteration} 轮：${record.summary} ` +
            `新增 ${added.length} 条` +
            (skipped > 0 ? `，其中 ${skipped} 条判为不相关或低价值、跳过抓取` : ""),
        );

        if (fetchable.length === 0) break;

        setPipelineStage(
          `${stagePrefix}抓取新增的 ${fetchable.length} 篇正文…`,
        );
        await fetchCore(
          sid,
          fetchable.map((r) => r.id),
          signal,
        );
        fetchedTotal += fetchable.length;

        // 补搜一条都没带回来 —— 再跑一轮只会重复同样的查询
        if (added.length === 0) break;
      }

      return { rounds, addedTotal, fetchedTotal };
    },
    [fetchCore, refineCore, depth],
  );

  const runPipeline = useCallback(async () => {
    if (!sessionId || pipelining || searching || fetching || refining) return;
    setPipelining(true);
    setSearchError(null);
    setRefineNotice(null);

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const { rounds, addedTotal, fetchedTotal } = await pipelineCore(
        sessionId,
        ac.signal,
        "",
      );
      if (rounds > 0) {
        setRefineNotice(
          `流水线完成：${rounds}/${depth} 轮，新增 ${addedTotal} 条结果、` +
            `抓取 ${fetchedTotal} 篇正文。可以继续「构建知识拓扑」，或下载与预览。`,
        );
      }
    } catch (err) {
      if (!ac.signal.aborted) setSearchError(errText(err));
    } finally {
      setPipelining(false);
      setPipelineStage(null);
    }
  }, [sessionId, pipelining, searching, fetching, refining, pipelineCore, depth]);

  // ── 构图 ──
  /**
   * 构图的内部实现，显式收会话 id —— 与 fetchCore/refineCore 同一理由：
   * 「一键调研」的同一闭包里 `sessionId` state 还没落地。
   */
  const buildGraphCore = useCallback(
    async (sid: string): Promise<boolean> => {
      setBuilding(true);
      setGraphError(null);
      setGraphNotice(null);
      setSelected(null);

      try {
        const res = await fetch("/api/graph", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: sid }),
        });

        const data = (await res.json()) as {
          graph?: GraphModel;
          error?: string;
          usedDocuments?: number;
          ignoredDocuments?: number;
          ignoredIrrelevant?: number;
          ignoredLowValue?: number;
          tokenizer?: string;
        };

        if (!res.ok || !data.graph) {
          // 路由用 409 表达「正文不够，无法构图」，这不算错误而是一种状态，
          // 用户看到原因就够了
          setGraphError(data.error ?? `HTTP ${res.status}`);
          setGraphNotice(null);
          return false;
        }

        setGraph(data.graph);
        /*
          把「有几篇没进图」说出来。

          图是这批资料的一张结构图，读者看不见图里少了什么 —— 不说的话，
          一篇跑题资料被排除这件事在界面上就是**静默发生**的，正好违反这套
          系统「绝不静默丢东西」的主张。所以这里照实报数，并说清它们在哪。
        */
        const ignoredIrrelevant = data.ignoredIrrelevant ?? 0;
        const ignoredLowValue = data.ignoredLowValue ?? 0;
        const reasons: string[] = [];
        if (ignoredIrrelevant > 0) {
          reasons.push(`${ignoredIrrelevant} 篇疑似与主题不相关`);
        }
        if (ignoredLowValue > 0) {
          reasons.push(`${ignoredLowValue} 篇被整理判为低价值`);
        }
        setGraphNotice(
          reasons.length > 0
            ? `有 ${reasons.join("、")} 的资料没有进图（它们仍在列表里，也逐条记在报告的「未收录」一节）`
            : null,
        );
        setShowDocuments(true);
        // 重构图产出的是一张新的图（节点集合可能完全不同），旧坐标不该沿用
        setViewState(undefined);
        return true;
      } catch (err) {
        setGraphError(errText(err));
        return false;
      } finally {
        setBuilding(false);
      }
    },
    [],
  );

  const runBuildGraph = useCallback(async () => {
    if (!sessionId || building) return;
    await buildGraphCore(sessionId);
  }, [sessionId, building, buildGraphCore]);

  /**
   * 一键调研：搜索 → 抓取 → 整理补搜循环 → 构图，一条命令跑完。
   *
   * ── 为什么要抽 core 函数而不是串四个 runXxx ──
   *
   * runSearch 完成后 `setSessionId` 要等下一次渲染才生效，紧接着调
   * runFetch 读到的还是 null —— 同一个闭包里 React state 不会「立刻变」。
   * 所以每个阶段都有 core 版本，显式收 `sid` 参数；runXxx 只是薄壳。
   *
   * 全程共用同一个 AbortController（与「一键流水线」同一份 `pipelining`
   * 状态）：用户在任意阶段按 Esc/关页面，整条链都在下一步之前停住，
   * 已完成的产物（搜索结果/正文/整理记录）都留在界面上。
   */
  const runResearch = useCallback(async () => {
    if (!query.trim() || pipelining || searching || fetching || refining || building) {
      return;
    }

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    startedRef.current = true;

    setPipelining(true);
    setSearchError(null);
    setRefineNotice(null);

    try {
      // 1. 搜索 + 价值预判（预判与相关性判定在服务端并发跑，不占额外时间）
      setPipelineStage("1/4 · 搜索与价值预判…");
      const searched = await searchCore(ac.signal);
      if (!searched || searched.total === 0) {
        setPipelineStage(null);
        setSearchError(
          searched ? "搜索没有返回结果，调研终止" : "搜索未完成，调研终止",
        );
        return;
      }
      const sid = searched.sessionId;

      // 2. 抓取首批正文（走完整 pickTargets：不相关 + 预判低价值 + 质量闸门）
      setPipelineStage("2/4 · 抓取首批正文…");
      const docCount = await fetchCore(sid, undefined, ac.signal);
      if (ac.signal.aborted) return;
      if (docCount === 0) {
        setPipelineStage(null);
        setRefineNotice(
          "没有抓到可用正文（全被过滤或抓取失败）。可以在列表里勾选条目单独重试，或直接构图。",
        );
        return;
      }

      // 3. 整理 → 补搜 → 抓取新增的循环（与「一键流水线」同一套逻辑）
      const { rounds } = await pipelineCore(
        sid,
        ac.signal,
        "3/4 · ",
      );
      if (ac.signal.aborted) return;

      // 4. 自动构图
      setPipelineStage("4/4 · 构建知识拓扑…");
      await buildGraphCore(sid);

      if (rounds > 0) {
        setRefineNotice(
          `调研完成：搜索 → 抓取 → ${rounds}/${depth} 轮整理补搜 → 拓扑已就绪。`,
        );
      } else {
        setRefineNotice("调研完成：拓扑已就绪。可以预览资料、下载，或继续补搜。");
      }
    } catch (err) {
      if (!ac.signal.aborted) setSearchError(errText(err));
    } finally {
      setPipelining(false);
      setPipelineStage(null);
    }
  }, [
    query,
    pipelining,
    searching,
    fetching,
    refining,
    building,
    searchCore,
    fetchCore,
    pipelineCore,
    buildGraphCore,
  ]);

  const siteCounts = new Map<SiteKey, number>();
  for (const r of results) {
    siteCounts.set(r.site, (siteCounts.get(r.site) ?? 0) + 1);
  }

  // ── 节点动作：删除 / 深入搜索 / 拓展节点 ──
  const runNodeAction = useCallback(
    async (
      action: "remove" | "search" | "expand",
      node: GraphNode,
      extraTerms?: string[],
    ) => {
      if (!sessionId || nodeAction) return;
      setNodeAction(action);
      setSearchError(null);
      try {
        const res = await fetch("/api/graph/node", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, nodeId: node.id, action, extraTerms }),
        });
        const data = (await res.json()) as {
          error?: string;
          graph?: GraphModel;
          removed?: { nodes: string[]; documents: string[] };
          added?: SearchResult[];
          addedDocs?: Document[];
          expanded?: GraphNode[];
          edges?: unknown[];
        };
        if (!res.ok) {
          setSearchError(data.error ?? `HTTP ${res.status}`);
          return;
        }
        if (action === "remove") {
          setGraph(data.graph ?? null);
          setSelected(null);
          if (data.removed) {
            const n = data.removed.documents.length;
            setGraphNotice(
              n > 0
                ? `已删除节点及其 ${n} 篇独占资料；被其它节点引用的资料保留`
                : "已从图中移除该节点；关联资料仍被其它节点引用，已保留",
            );
          }
          if (data.removed?.documents.length) {
            const gone = new Set(data.removed.documents);
            setDocuments((prev) => prev.filter((d) => !gone.has(d.id)));
            setResults((prev) => prev.filter((r) => !gone.has(r.id)));
          }
        } else if (action === "expand") {
          if (data.graph) setGraph(data.graph);
          if (data.added?.length) setResults((prev) => mergeResults(prev, data.added ?? []));
          if (data.addedDocs?.length) {
            setDocuments((prev) => {
              const existingIds = new Set(prev.map((d) => d.id));
              const fresh = (data.addedDocs ?? []).filter((d) => !existingIds.has(d.id));
              return [...prev, ...fresh];
            });
          }
          const expCount = data.expanded?.length ?? 0;
          const docCount = data.addedDocs?.length ?? 0;
          setGraphNotice(
            `已为「${node.label}」在拓扑中补充 ${expCount} 个关联技术节点，补充 ${docCount} 篇支撑资料。`,
          );
        } else {
          // search: 深入搜索
          if (data.graph) setGraph(data.graph);
          if (data.added?.length) setResults((prev) => mergeResults(prev, data.added ?? []));
          if (data.addedDocs?.length) {
            setDocuments((prev) => {
              const existingIds = new Set(prev.map((d) => d.id));
              const fresh = (data.addedDocs ?? []).filter((d) => !existingIds.has(d.id));
              return [...prev, ...fresh];
            });
          }
          const addedLen = data.added?.length ?? 0;
          const docsLen = data.addedDocs?.length ?? 0;
          if (addedLen > 0) {
            setGraphNotice(
              `深入搜索「${node.label}」新增 ${addedLen} 条结果${docsLen > 0 ? `，并补充了 ${docsLen} 篇正文材料` : ""}。`,
            );
          } else {
            setGraphNotice(`围绕「${node.label}」没有搜到新结果`);
          }
        }
      } catch (err) {
        setSearchError(errText(err));
      } finally {
        setNodeAction(null);
      }
    },
    [sessionId, nodeAction],
  );

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
              intent={intent}
              onIntentChange={setIntent}
              industries={industries}
              onIndustriesChange={setIndustries}
              depth={depth}
              onDepthChange={setDepth}
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
              // 包一层：SearchPanel 把这个回调直接挂在 onClick 上，
              // 不包的话 React 会把 MouseEvent 当成 resultIds 传进去
              onFetch={() => runFetch()}
              onPreviewDocument={setPreviewDocument}
              fetching={fetching}
              fetchProgress={fetchProgress}
              fetchNotice={fetchNotice}
              onBuildGraph={runBuildGraph}
              building={building}
              graphError={graphError}
              graphNotice={graphNotice}
              hasGraph={graph !== null}
              onRefine={() => void runRefine()}
              refining={refining}
              refineNotice={refineNotice}
              refinements={refinements}
              refineIteration={refineIteration}
              refineMax={depth}
              onPipeline={() => void runPipeline()}
              onResearch={() => void runResearch()}
              pipelining={pipelining}
              pipelineStage={pipelineStage}
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
              graphDimension === "3d" ? (
                <GraphView3D
                  key={sessionId ?? "pending"}
                  graph={graph}
                  selectedId={selected?.id}
                  onSelect={setSelected}
                  showDocuments={showDocuments}
                  graphStyle={graphStyle}
                  onStyleChange={handleStyleChange}
                  initialView={viewState}
                  onViewChange={handleViewChange}
                  documents={documents}
                  onOpenDocument={setPreviewDocument}
                  dimensionMode="3d"
                  onToggleDimension={handleToggleDimension}
                />
              ) : (
                <GraphView
                  key={sessionId ?? "pending"}
                  graph={graph}
                  selectedId={selected?.id}
                  onSelect={setSelected}
                  showDocuments={showDocuments}
                  graphStyle={graphStyle}
                  onStyleChange={handleStyleChange}
                  initialView={viewState}
                  onViewChange={handleViewChange}
                  documents={documents}
                  onOpenDocument={setPreviewDocument}
                  dimensionMode="2d"
                  onToggleDimension={handleToggleDimension}
                />
              )
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
                    setPreviewDocument(doc)
                  }
                  onDeleteNode={(n) => void runNodeAction("remove", n)}
                  onDeepSearch={(n) => void runNodeAction("search", n)}
                  onExpandNode={(n, terms) => void runNodeAction("expand", n, terms)}
                  nodeAction={nodeAction}
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
            <DownloadPanel
              sessionId={sessionId}
              documents={documents}
              onRefetch={(ids) => runFetch(ids)}
              refetching={fetching}
            />
          </div>
        )}

        {previewDocument && (
          <DocumentPreview
            document={previewDocument}
            sessionId={sessionId ?? undefined}
            onClose={() => setPreviewDocument(null)}
          />
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

/**
 * 抓取完成后那一行小字。
 *
 * 两个数字来自两个事件（`plan` 给 skippedIrrelevant，`done` 给 byMethod），
 * 所以抽成一个纯函数由调用方凑齐再渲染 —— 让「两句话怎么拼」只有一处真相，
 * 而不是在事件回调里各写一半。
 *
 * 「渲染」那一句只在真的发生过时才说。默认是 0，不该占一行。
 * 措辞用「本次会话」而不是「这一批」：`byMethod` 统计的是 `session.documents`，
 * 是累计值（`fetch/route.ts` 的 `tally`），说成这一批就是错的。
 */
function fetchNoticeText(
  skippedIrrelevant: number,
  skippedLowValue: number,
  skippedLowQuality: number,
  playwright: number,
  lowValue?: number,
): string | null {
  const parts: string[] = [];
  if (skippedIrrelevant > 0) {
    parts.push(
      `已跳过 ${skippedIrrelevant} 条疑似与主题不相关的结果（它们仍在列表里；` +
        `想抓的话在结果里勾选这几条，再点一次抓取）`,
    );
  }
  if (skippedLowValue > 0) {
    parts.push(
      `已跳过 ${skippedLowValue} 条预判低价值的结果（仅凭标题与摘要；` +
        `在结果里勾选可以单独补抓）`,
    );
  }
  if (playwright > 0) {
    parts.push(`本次会话已有 ${playwright} 篇靠无头浏览器渲染拿到正文`);
  }
  if (skippedLowQuality > 0) {
    parts.push(
      `质量过滤层已跳过 ${skippedLowQuality} 条明显无用/低质候选（候选不足时会自动补回低质链接）`,
    );
  }
  if (lowValue && lowValue > 0) {
    parts.push(
      `整理阶段将 ${lowValue} 篇正文判为低价值（只标记不删除：它们不进拓扑，但仍可预览与下载）`,
    );
  }
  return parts.length ? parts.join("；") : null;
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
/** 拓扑图色彩风格偏好。 */
const GRAPH_STYLE_KEY = "mutieye:graphStyle";
/** 拓扑图维度偏好（2D 平面 / 3D 星云）。 */
const GRAPH_DIMENSION_KEY = "mutieye:graphDimension";
