import type { NextRequest } from "next/server";
import type { SearchEvent, SiteKey, Session, Topic } from "@/core/types";
import { searchAll } from "@/core/search/orchestrate";
import { buildQuery, DEFAULT_SITES, SITE_TARGETS } from "@/core/search/sites";
import { newTopicId, saveSession } from "@/core/store";
import { sseResponse } from "@/core/sse";

// 不导出 runtime：Next 16 里 'nodejs' 已是默认值（Edge 废弃），文档要求移除该导出。
export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface SearchBody {
  query?: string;
  sites?: SiteKey[];
  domain?: string;
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

  const topic: Topic = {
    id: newTopicId(),
    query,
    sites,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  return sseResponse<SearchEvent>(async (emit) => {
    emit({
      type: "plan",
      topic,
      queries: sites.map((s) => buildQuery(query, s, body.domain)),
    });

    const { results, log } = await searchAll({
      topic: query,
      sites,
      signal: req.signal,
      onSiteDone: (site, siteResults, entry) => {
        emit({ type: "results", site, results: siteResults });
        emit({ type: "provider", log: entry });
      },
    });

    // 落盘完整快照。文档为空 —— 正文抓取是独立的一步，由 /api/fetch 触发，
    // 这样用户可以只搜不抓，避免为不需要的资料付出抓取成本。
    const session: Session = {
      topic: { ...topic, updatedAt: new Date().toISOString() },
      results,
      documents: [],
      providerLog: log,
    };
    await saveSession(session);

    emit({ type: "done", total: results.length, sessionId: topic.id });
  }, req.signal);
}
