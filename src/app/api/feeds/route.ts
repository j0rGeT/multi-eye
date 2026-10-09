import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { loadFeeds, saveFeeds, feedsPath, DEFAULT_FEEDS } from "@/core/search/feedstore";
import { fetchFeed } from "@/core/search/rss";

// 不导出 runtime：Next 16 里 'nodejs' 已是默认值（Edge 废弃）。
export const dynamic = "force-dynamic";

/**
 * 订阅表的读写。
 *
 *   GET  /api/feeds            返回当前订阅 + 内置默认 + 配置文件路径
 *   GET  /api/feeds?probe=<url> 试抓一条订阅，回答「它到底能不能解析」
 *   PUT  /api/feeds            整体覆盖订阅表
 *
 * ── 为什么要有个 probe ──
 *
 * RSS 有个很坑的失败模式：站点停了 feed 却留着路由，请求**照样返回 200**，
 * 内容却是一整页 HTML 外壳（`36kr.com/feed` 就是这样，实测 0 条目）。
 * 用户贴进去一个 URL、看到保存成功，然后在某次搜索里发现这个站永远没内容，
 * 根本无从判断是站没更新还是订阅是坏的。
 *
 * 所以加一个「加之前先试一下」的口。它复用搜索路径上**同一个**
 * `fetchFeed()`，所以这里说能解析，搜索时就能解析 —— 不存在「测试通过但
 * 实际不行」的偏差。
 */
export async function GET(req: NextRequest) {
  const probe = req.nextUrl.searchParams.get("probe");
  if (probe) {
    if (!/^https?:\/\//i.test(probe)) {
      return NextResponse.json(
        { ok: false, error: "只支持 http(s) 地址" },
        { status: 400 },
      );
    }
    try {
      const entries = await fetchFeed({ title: probe, url: probe, enabled: true });
      return NextResponse.json({
        ok: true,
        count: entries.length,
        latest: entries[0]?.publishedAt,
        sample: entries.slice(0, 3).map((e) => e.title),
      });
    } catch (err) {
      return NextResponse.json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const { feeds, fromFile, error } = await loadFeeds();
  return NextResponse.json({
    feeds,
    defaults: DEFAULT_FEEDS,
    fromFile,
    error,
    path: feedsPath(),
  });
}

export async function PUT(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const raw = (body as { feeds?: unknown })?.feeds;
  if (!Array.isArray(raw)) {
    return NextResponse.json(
      { ok: false, error: "缺少 feeds 数组" },
      { status: 400 },
    );
  }

  // 校验（含 http(s) 协议白名单）在 saveFeeds 里做，和读取路径共用同一份规则
  const feeds = raw.map((f) => ({
    title: typeof (f as { title?: unknown })?.title === "string"
      ? String((f as { title: string }).title)
      : "",
    url: typeof (f as { url?: unknown })?.url === "string"
      ? String((f as { url: string }).url)
      : "",
    enabled: (f as { enabled?: unknown })?.enabled !== false,
  }));

  const res = await saveFeeds(feeds);
  if (!res.ok) return NextResponse.json(res, { status: 400 });
  return NextResponse.json({ ok: true, count: feeds.length });
}
