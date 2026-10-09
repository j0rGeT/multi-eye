import type { NextRequest } from "next/server";
import type {
  Document,
  ExtractMethod,
  FetchEvent,
  SearchResult,
  SiteKey,
} from "@/core/types";
import { extractMany } from "@/core/fetch/extract";
import { findDuplicates, markDuplicates } from "@/core/search/dedupe";
import { loadSession, saveSession } from "@/core/store";
import { sseResponse } from "@/core/sse";

// 不导出 runtime：Next 16 里 'nodejs' 已是默认值（Edge 废弃），文档要求移除该导出。
export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface FetchBody {
  sessionId?: string;
  /** 只抓这些结果；省略则抓会话里的全部。前端用来做「勾选部分抓取」。 */
  resultIds?: string[];
  /** 只抓这些站点。与 resultIds 二选一。 */
  sites?: SiteKey[];
  concurrency?: number;
}

/**
 * 把搜索结果抓成带正文的 Document，以 SSE 逐篇回传。
 *
 * 为什么单独一个接口而不是并进 /api/search：搜索快（几秒）、抓取慢（几十秒到
 * 几分钟），而且用户经常只看搜索列表就够了 —— 不该为不需要的资料强制付抓取
 * 成本。分开之后「只搜不抓」和「补充抓取」都变成天然支持的用法。
 *
 * 落盘策略：每篇抓完立刻整体重写 session.json。文件不大，而增量写 JSON 数组
 * 需要维护偏移量、崩溃时容易留下半截记录；整体重写的代价换来「进程随时被杀死
 * 也不丢已完成的部分」，对本地工具是划算的。
 */
export async function POST(req: NextRequest) {
  let body: FetchBody;
  try {
    body = (await req.json()) as FetchBody;
  } catch {
    return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const sessionId = body.sessionId?.trim();
  if (!sessionId) {
    return Response.json({ error: "缺少 sessionId" }, { status: 400 });
  }

  const session = await loadSession(sessionId);
  if (!session) {
    return Response.json({ error: `会话不存在：${sessionId}` }, { status: 404 });
  }

  const targets = pickTargets(session.results, body);

  return sseResponse<FetchEvent>(async (emit) => {
    emit({
      type: "plan",
      total: targets.length,
      skipped: session.results.length - targets.length,
    });

    if (targets.length === 0) {
      emit({
        type: "done",
        sessionId,
        documents: session.documents.length,
        byMethod: tally(session.documents),
      });
      return;
    }

    // 按 URL 索引已有文档：重跑同一批时原地替换，而不是越抓越多
    const byUrl = new Map(session.documents.map((d) => [d.url, d]));

    const docs = await extractMany(targets, {
      signal: req.signal,
      concurrency: clampConcurrency(body.concurrency),
      onProgress: (done, total, doc) => {
        byUrl.set(doc.url, doc);
        emit({ type: "doc", doc, done, total });
      },
    });

    // extractMany 保证长度与 targets 对齐，但顺序可能因并发而不同 —— 这里
    // 以 doc.url 为准重建，顺序跟随 targets，保证落盘结果稳定可复现。
    const fresh = new Map(docs.map((d) => [d.url, d]));
    const documents = [
      ...session.results
        .map((r) => fresh.get(r.url) ?? byUrl.get(r.url))
        .filter((d): d is Document => Boolean(d)),
      // 保留不在本次抓取范围内的旧文档（比如上次只抓了几个站点）
      ...session.documents.filter((d) => !byUrl.has(d.url)),
    ];

    // 同一份内容可能被两个 URL 命中（不同站点转载），按 title+正文长度粗去重
    const deduped = dedupeDocuments(documents);

    /*
      同源转载识别。**放在抓取之后**：搜索阶段只有摘要，摘要太短、指纹不可靠
      （见 `search/dedupe.ts` 开头）。

      **只标记不删除** —— 被标了 duplicateOf 的文档照样留在结果里，只是
      统计「独立出处」时和代表算一个。静默删掉其中一篇是这套系统最忌讳的事。
    */
    const dupes = await findDuplicates(deduped);
    const marked = markDuplicates(deduped, dupes);

    await saveSession({
      ...session,
      topic: { ...session.topic, updatedAt: new Date().toISOString() },
      documents: marked,
    });

    emit({
      type: "done",
      sessionId,
      documents: marked.length,
      byMethod: tally(marked),
    });
  }, req.signal);
}

/** 决定这次抓哪些结果：显式的 resultIds 优先，其次 sites，最后全量。 */
function pickTargets(
  results: SearchResult[],
  body: FetchBody,
): SearchResult[] {
  if (body.resultIds?.length) {
    const wanted = new Set(body.resultIds);
    return results.filter((r) => wanted.has(r.id));
  }
  if (body.sites?.length) {
    const wanted = new Set(body.sites);
    return results.filter((r) => wanted.has(r.site));
  }
  return results;
}

/**
 * 并发上限钳制在 1..8。
 *
 * 上限 8 是因为抓取链里每一级都要 fopen 目标站点，并发过高会被判定为爬虫
 * （实测知乎、小红书在 5 以上就开始返回验证页），低于 1 则没有意义。
 */
function clampConcurrency(raw?: number): number {
  if (!Number.isFinite(raw)) return 4;
  return Math.min(Math.max(Math.trunc(raw as number), 1), 8);
}

function tally(docs: Document[]): Record<ExtractMethod, number> {
  const out: Record<ExtractMethod, number> = {
    readability: 0,
    playwright: 0,
    "ytdlp-subtitle": 0,
    "bilibili-api": 0,
    raw: 0,
  };
  for (const d of docs) out[d.extractMethod] += 1;
  return out;
}

/**
 * 按 URL 去重即可 —— 融合阶段已经用归一化 URL 做过一轮，这里剩下的重复
 * 来自「上次抓的旧文档」和「这次抓的新文档」路径不同但指向同一页面。
 */
function dedupeDocuments(docs: Document[]): Document[] {
  const seen = new Set<string>();
  const out: Document[] = [];
  for (const d of docs) {
    if (seen.has(d.url)) continue;
    seen.add(d.url);
    out.push(d);
  }
  return out;
}
