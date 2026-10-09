import type { NextRequest } from "next/server";
import type {
  Relevance,
  SearchEvent,
  SiteKey,
  SortMode,
  Session,
  TimeRange,
  Topic,
} from "@/core/types";
import { searchAll } from "@/core/search/orchestrate";
import { TIME_RANGE_MS } from "@/core/search/filter";
import { buildQuery, DEFAULT_SITES, SITE_TARGETS } from "@/core/search/sites";
import { planQueries, variantFor } from "@/core/search/plan";
import { newTopicId, saveSession } from "@/core/store";
import { sseResponse } from "@/core/sse";

// 不导出 runtime：Next 16 里 'nodejs' 已是默认值（Edge 废弃），文档要求移除该导出。
export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface SearchBody {
  query?: string;
  sites?: SiteKey[];
  domain?: string;
  timeRange?: string;
  sortMode?: string;
}

const SORT_MODES: SortMode[] = ["relevant", "recent", "mixed", "quality"];

/**
 * 校验请求里来的枚举值。
 *
 * 这两个字段会从 URL/表单直接进来，任何字符串都可能，而它们会一路影响到
 * 排序与过滤。校验过之后下游就可以当它们是可信的联合类型用；不校验则要么
 * 在每处使用点重复判断，要么让 `sortMode: "RECENT"` 这类值悄悄退化成默认
 * 行为 —— 用户以为切换了排序，其实没有。
 */
function pickTimeRange(v: string | undefined): TimeRange | undefined {
  return v && v in TIME_RANGE_MS ? (v as TimeRange) : undefined;
}

function pickSortMode(v: string | undefined): SortMode {
  return SORT_MODES.includes(v as SortMode) ? (v as SortMode) : "relevant";
}

/**
 * 执行一次主题搜索，以 SSE 增量回传结果。
 *
 * 为什么用流式：一次搜索要扇出到 4-5 个站点，每个站点又有 fallback 链。
 * 批量等待的话用户要盯着空白页十几秒；流式则能让结果「一条条冒出来」，
 * 而且某个站点失败时其他站点的结果已经到用户手里了。
 */
export async function POST(req: NextRequest) {
  let body: SearchBody;
  try {
    body = (await req.json()) as SearchBody;
  } catch {
    return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const query = body.query?.trim();
  if (!query) {
    return Response.json({ error: "缺少 query" }, { status: 400 });
  }

  const sites = (body.sites?.length ? body.sites : DEFAULT_SITES).filter(
    (s): s is SiteKey => s in SITE_TARGETS,
  );
  const timeRange = pickTimeRange(body.timeRange);
  const sortMode = pickSortMode(body.sortMode);

  const topic: Topic = {
    id: newTopicId(),
    query,
    sites,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  return sseResponse<SearchEvent>(async (emit) => {
    /*
      搜索词分析。**放在扇出之前，而且只放一次。**

      契约上它必须和随后真正发出的查询是同一份东西 —— 所以先分析、再拿分析
      结果生成预览、再把同一份 plan 交给 `searchAll`。此前预览用
      `buildQuery(query, s, body.domain)` 现算，而 `searchAll` 收不到 `domain`，
      于是只要带了 domain，界面上说的和实际跑的就是两个查询。

      分析失败/超时/没配 LLM 都会退化成「不改写」（见 plan.ts），
      此时 queries 与加这个功能之前逐字相同。
    */
    const plan = await planQueries(query, sites, { signal: req.signal });

    emit({
      type: "plan",
      topic,
      plan,
      queries: sites.map((s) => buildQuery(variantFor(plan, s), s, body.domain)),
    });

    const { results, log, timeFilter } = await searchAll({
      topic: query,
      plan,
      domain: body.domain,
      sites,
      signal: req.signal,
      timeRange,
      sortMode,
      onSiteDone: (site, siteResults, entry) => {
        emit({ type: "results", site, results: siteResults });
        emit({ type: "provider", log: entry });
      },
    });

    /*
      判定单独发一个事件，放在 `done` 之前。

      结果列表在上面 `onSiteDone` 里就一条条冒出来了，而判定要等模型几秒 ——
      与其把结果扣住等判定，不如让用户先看到列表、徽章随后补上。这也正是
      流式的本意：能先给的先给。
    */
    const verdicts: Record<string, Relevance> = {};
    for (const r of results) if (r.relevance) verdicts[r.id] = r.relevance;
    emit({ type: "relevance", verdicts });

    // 落盘完整快照。文档为空 —— 正文抓取是独立的一步，由 /api/fetch 触发，
    // 这样用户可以只搜不抓，避免为不需要的资料付出抓取成本。
    const session: Session = {
      topic: { ...topic, updatedAt: new Date().toISOString() },
      results,
      documents: [],
      providerLog: log,
      createdAt: new Date().toISOString(),
      // 把当时的口径一起存下来，否则事后没法解释「为什么这次搜出来的资料
      // 比上次少一大截」—— 可能只是当时勾了「一周内」
      searchOptions: { timeRange, sortMode },
    };
    await saveSession(session);

    emit({
      type: "done",
      total: results.length,
      sessionId: topic.id,
      // 筛选口径和它的副作用一起回传，界面才可以如实说明「筛掉了 N 条、
      // 另有 M 条因为没写日期而无法判断」
      timeFilter,
    });
  }, req.signal);
}
