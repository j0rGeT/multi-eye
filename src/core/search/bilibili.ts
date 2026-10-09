/**
 * 哔哩哔哩搜索提供方。
 *
 * 为什么单独为 B 站写一个 provider，而不是交给搜索引擎：
 * 实测 bing 在「露营装备 哔哩哔哩」这种带平台关键词的查询下，返回的
 * bilibili.com 结果数是 0 —— 而这里直连官方搜索接口能稳定拿到 20 条，
 * 还附带播放量、时长、UP 主、发布日期这些搜索引擎摘要给不了的元数据。
 *
 * 这是公开的 Web 搜索接口（无需登录、无需签名），走的是浏览器里打开
 * bilibili.com 搜索页时同样的请求，没有触碰任何鉴权或反爬机制。
 *
 * **不走代理**：这是国内的接口，走境外 VPN 只会更慢甚至被拒。
 * 所以这里用全局 fetch（Node 的 fetch 默认直连，不读代理环境变量），
 * 而不是 agent.ts 里那个带代理的 httpFetch。这一点和其他抓取路径相反，
 * 是刻意的。
 */

import type {
  ProviderCapabilities,
  SearchProvider,
  SearchQuery,
  SearchResult,
  SortMode,
} from "@/core/types";
import { displayDomain, resultId } from "./normalize";
import { normalizeToIso } from "@/core/dates";
import { compactSignals } from "@/core/signals";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

interface BilibiliItem {
  title?: string;
  author?: string;
  arcurl?: string;
  bvid?: string;
  pic?: string;
  description?: string;
  pubdate?: number;
  duration?: string;
  play?: number;
  danmaku?: number;
  like?: number;
}

interface BilibiliResponse {
  code?: number;
  message?: string;
  data?: { result?: BilibiliItem[] | null };
}

export class BilibiliProvider implements SearchProvider {
  readonly id = "bilibili" as const;

  readonly capabilities: ProviderCapabilities = {
    // 官方接口不支持 site: 之类的检索语法，本 provider 本身就只覆盖 B 站
    supportsSiteSyntax: false,
    supportsVideo: true,
    needsApiKey: false,
  };

  /** 只对 bilibili 这个站点有意义；其他站点直接跳过，省一次网络往返。 */
  async available(): Promise<boolean> {
    return true;
  }

  async search(q: SearchQuery, signal?: AbortSignal): Promise<SearchResult[]> {
    if (q.site !== "bilibili") return [];

    const url = new URL(
      "https://api.bilibili.com/x/web-interface/wbi/search/type",
    );
    url.searchParams.set("search_type", "video");
    url.searchParams.set("keyword", q.text);
    url.searchParams.set("page", "1");
    url.searchParams.set("order", bilibiliOrder(q.sortMode));

    const res = await fetch(url, {
      signal: signal ?? AbortSignal.timeout(15_000),
      headers: {
        "User-Agent": UA,
        // 这个接口会校验 Referer，缺了直接返回风控错误
        Referer: "https://www.bilibili.com",
        Accept: "application/json",
      },
    });

    if (!res.ok) throw new Error(`Bilibili HTTP ${res.status}`);

    const data = (await res.json()) as BilibiliResponse;
    if (data.code !== 0) {
      // -412 是风控拦截，通常是短时间请求过多
      throw new Error(
        `Bilibili 接口返回 code=${data.code}${data.message ? ` (${data.message})` : ""}`,
      );
    }

    const items = data.data?.result ?? [];
    const limit = q.limit ?? 20;

    return items
      .filter((it) => Boolean(it.arcurl || it.bvid))
      .slice(0, limit)
      .map((it, i) => {
        const link = it.arcurl
          ? it.arcurl.replace(/^http:\/\//, "https://")
          : `https://www.bilibili.com/video/${it.bvid}`;
        return {
          id: resultId(link),
          title: stripHtml(it.title ?? "") || link,
          url: link,
          snippet: stripHtml(it.description ?? ""),
          domain: displayDomain(link),
          site: "bilibili" as const,
          provider: this.id,
          rank: i + 1,
          hitCount: 1,
          publishedAt: normalizeToIso(it.pubdate),
          author: it.author,
          // pic 是协议相对的（//i1.hdslb.com/...），不补协议浏览器不认
          thumbnail: it.pic ? (it.pic.startsWith("//") ? `https:${it.pic}` : it.pic) : undefined,
          durationSec: parseDuration(it.duration),
          /*
            B 站接口同时给了播放/弹幕/点赞 —— 这是这套系统里唯一不花额外
            请求就能拿到的社区声量信号（搜索接口一次性返回）。丢掉它们
            等于白白放弃一个筛选长尾的维度。
            注意弹幕和点赞不是一回事：点赞是「看完觉得好」，弹幕是「看的时候
            有话要说」，所以两个都留着，不合成。
          */
          signals: compactSignals([
            { label: "播放", value: it.play, format: "count" },
            { label: "弹幕", value: it.danmaku, format: "count" },
            { label: "点赞", value: it.like, format: "count" },
          ]),
        };
      });
  }
}

/**
 * B 站检索的排序参数。
 *
 * ── 为什么默认不是 totalrank（综合排序）──
 *
 * 接口的默认值是 `totalrank`，也是网页版看到的「综合排序」。但对**未签名**
 * 的请求（我们没有 WBI 签名，见文件头对合规边界的说明），它返回的是一批
 * 几乎没人看过的新投稿 —— 实测三个关键词各取前 20 条：
 *
 *   | 关键词   | 默认/totalrank 播放中位 | order=click 播放中位 |
 *   |---|---|---|
 *   | 露营装备 |                     6 |       1,988,286 |
 *   | React 教程 |                6,929 |         378,497 |
 *   | 咖啡     |               16,792 |       7,708,346 |
 *
 * 差 50~500 倍。也就是说默认排序下，B 站这条线贡献的基本是长尾噪音，
 * 而它的数量（每轮 20 条）足以把整个结果集的质量拉低。
 *
 * `click` 是按播放量排，实测结果仍然切题（「露营装备」返回的是露营引火物
 * 这类高播放的相关视频），所以拿它当默认。
 *
 * 用户选了「最新优先」时改用 `pubdate`：那时他要的就是最新，让上游直接
 * 按时间检索，比先取一批热门再在本地筛掉更可靠。
 */
function bilibiliOrder(mode?: SortMode): string {
  return mode === "recent" ? "pubdate" : "click";
}

/**
 * 去掉高亮标签与实体。
 *
 * 接口会在标题里插入 `<em class="keyword">露营装备</em>` 做关键词高亮，
 * 直接展示会漏出标签；`&amp;` 这类实体也要还原。
 */
function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

/** `"0:40"` / `"12:34"` / `"1:02:03"` → 秒。解析失败返回 undefined。 */
function parseDuration(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const parts = s.split(":").map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n))) return undefined;
  return parts.reduce((total, n) => total * 60 + n, 0);
}
