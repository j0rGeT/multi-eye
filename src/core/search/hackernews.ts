/**
 * Hacker News 检索（Algolia 公开接口，免 key、免登录）。
 *
 * 为什么值得单独接一条：HN 的条目已经被社区筛过一遍 —— 能上首页的东西
 * 至少被一群人看过并点了赞。`points` 和 `num_comments` 是这套系统里
 * **最接近「优质数据」的客观信号**，而搜索引擎给不了这个东西。
 *
 * ── 几个实测出来的坑 ──
 *
 * 1. **必须带 `tags=story`。** 不带的默认搜索会把评论一起匹配进来，而评论
 *    命中返回的对象里 `title` / `url` / `points` 全是 null —— 只填了
 *    `story_text` 和 `created_at`。实测搜「露营」返回的第一条正是这种东西。
 *    放进结果列表里就是一行没有标题、没有链接、没有任何数字的空行。
 *
 * 2. **`url` 可能为 null。** 自帖（Ask HN / Show HN）的正文就在 HN 自己
 *    页面上，没有外链。这时回退到 `news.ycombinator.com/item?id=<id>`。
 *
 * 3. 走代理：HN 是境外站点，由 `fetch/agent.ts` 的域名分流自动决定，
 *    这里不手动指定。**唯一的例外是 B 站**（见 `bilibili.ts`，它必须直连），
 *    新 provider 不要模仿那个写法。
 */

import type {
  ProviderCapabilities,
  SearchProvider,
  SearchQuery,
  SearchResult,
} from "@/core/types";
import { httpFetch } from "@/core/fetch/agent";
import { compactSignals } from "@/core/signals";
import { normalizeToIso } from "@/core/dates";
import { displayDomain, resultId } from "./normalize";
import { resolveSite } from "./sites";
import { TIME_RANGE_MS } from "./filter";

const ENDPOINT = "https://hn.algolia.com/api/v1/search";

interface HnHit {
  objectID?: string;
  title?: string | null;
  url?: string | null;
  story_text?: string | null;
  author?: string | null;
  points?: number | null;
  num_comments?: number | null;
  created_at?: string | null;
}

interface HnResponse {
  hits?: HnHit[];
}

export class HackerNewsProvider implements SearchProvider {
  readonly id = "hackernews" as const;

  readonly capabilities: ProviderCapabilities = {
    // 一个接口覆盖全站，不认 site: 语法
    supportsSiteSyntax: false,
    supportsVideo: false,
    needsApiKey: false,
    scope: "topic",
  };

  async available(): Promise<boolean> {
    return true;
  }

  async search(q: SearchQuery, signal?: AbortSignal): Promise<SearchResult[]> {
    const url = new URL(ENDPOINT);
    url.searchParams.set("query", q.text);
    // 见文件头：不限定 tags 会混进评论，那些命中没有标题也没有链接
    url.searchParams.set("tags", "story");
    url.searchParams.set("hitsPerPage", String(Math.min(q.limit ?? 15, 50)));
    // 时间窗口交给上游做，比拿回来再本地筛更省事；本地兜底照样还会跑一遍
    if (q.timeRange) {
      const cutoff = Date.now() - TIME_RANGE_MS[q.timeRange];
      url.searchParams.set(
        "numericFilters",
        `created_at_i>${Math.floor(cutoff / 1000)}`,
      );
    }

    const res = await httpFetch(url.toString(), {
      signal: signal ?? AbortSignal.timeout(8_000),
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Hacker News HTTP ${res.status}`);

    const data = (await res.json()) as HnResponse;
    const hits = data.hits ?? [];

    return hits
      .filter((h): h is HnHit & { title: string } => Boolean(h.title))
      .map((h, i) => {
        const link = h.url || `https://news.ycombinator.com/item?id=${h.objectID}`;
        return {
          id: resultId(link),
          title: h.title,
          url: link,
          snippet: stripHtml(h.story_text ?? "").slice(0, 300),
          // domain 是**内容所在**的域名，不是 HN。同一条 story 可能指向
          // github.com / 个人博客 / 论文，DOMAIN 列显示的必须是那个
          domain: displayDomain(link),
          // 内容住在哪就归到哪 —— 一条指向 GitHub 的 story 归 GitHub，
          // 而不是归给 HN。HN 这个出处由下面的 provider 字段承载
          site: resolveSite(link),
          provider: this.id,
          rank: i + 1,
          hitCount: 1,
          publishedAt: normalizeToIso(h.created_at),
          author: h.author ?? undefined,
          signals: compactSignals([
            { label: "赞", value: h.points, format: "count" },
            { label: "评论", value: h.num_comments, format: "count" },
          ]),
        };
      });
  }
}

/** HN 自帖的正文可能带 HTML 片段。 */
function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}
