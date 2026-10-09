/**
 * arXiv 检索（官方 Atom 接口，免 key、免登录）。
 *
 * ── 官方要求的礼节 ──
 *
 * arXiv 的 API 使用条款明确要求**请求之间至少间隔 3 秒**，且不要在短时间内
 * 突发请求。所以这个 provider 是 `scope: "topic"`（一个主题只查一次），
 * 并且调用方必须在限流层给它串行配额（见 `orchestrate.ts` 的 CONCURRENCY）。
 * 违反这条的后果是 IP 被封，而且**封的是整台机器**，不只是一个 key。
 *
 * ── 这个源没有声量信号，不要硬凑 ──
 *
 * arXiv 不提供引用数（那要另一套接口），所以这条线**没有 signals**。
 * 不填 0 也不填任何代理指标 —— arXiv 是预印本，有没有被引用、有没有经过
 * 同行评议，从这个接口里都看不出来。它的价值在于「一手研究」，
 * 不在于「很多人看过」。
 *
 * ── 版本号必须保留 ──
 *
 * 同一篇论文的 v1 / v2 / v3 是不同 URL、内容不同（v2 常带重大修订），
 * 因此 `normalize.ts` 的 KEEP_PARAMS 为 arxiv 保留了 `v` 参数，
 * 否则三个版本会被归一化成同一条、只留下先到的那个。
 */

import { XMLParser } from "fast-xml-parser";
import type {
  ProviderCapabilities,
  SearchProvider,
  SearchQuery,
  SearchResult,
} from "@/core/types";
import { httpFetch } from "@/core/fetch/agent";
import { normalizeToIso } from "@/core/dates";
import { resultId } from "./normalize";

const ENDPOINT = "https://export.arxiv.org/api/query";

interface AtomLink {
  "@_href"?: string;
  "@_rel"?: string;
  "@_title"?: string;
}

interface AtomEntry {
  id?: string;
  title?: string;
  summary?: string;
  published?: string;
  updated?: string;
  author?: { name?: string } | { name?: string }[];
  link?: AtomLink | AtomLink[];
  category?: { "@_term"?: string } | { "@_term"?: string }[];
}

export class ArxivProvider implements SearchProvider {
  readonly id = "arxiv" as const;

  readonly capabilities: ProviderCapabilities = {
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
    /*
      用 `all:` 而不是 `ti:`（只在标题里找）。

      中文主题词在 arXiv 上几乎命不中 —— 它的语料是英文论文。这时标题搜索
      返回空，而 `all:` 至少还能靠摘要里的英文术语捞到相关研究。
      代价是会混进一些弱相关的，但它们的摘要质量远高于搜索引擎给的，
      留在结果里让用户自己判断，比直接空着好。
    */
    url.searchParams.set("search_query", `all:${q.text}`);
    url.searchParams.set("sortBy", q.sortMode === "recent" ? "submittedDate" : "relevance");
    url.searchParams.set("sortOrder", "descending");
    url.searchParams.set("max_results", String(Math.min(q.limit ?? 10, 30)));

    const res = await httpFetch(url.toString(), {
      signal: signal ?? AbortSignal.timeout(15_000),
      headers: { Accept: "application/atom+xml" },
    });
    if (!res.ok) throw new Error(`arXiv HTTP ${res.status}`);

    const xml = await res.text();
    const entries = parseEntries(xml);

    return entries
      .map((e) => toResult(e))
      .filter((r): r is SearchResult => r !== null)
      .map((r, i) => ({ ...r, rank: i + 1 }));
  }
}

/**
 * 解析 Atom。
 *
 * `ignoreAttributes: false` 是必须的：arXiv 的论文链接是
 * `<link href="..." rel="alternate">`，属性里才有关键信息，默认配置会把
 * 属性整个丢掉，于是每条都拿不到 URL。
 *
 * `isArray` 把单复数统一成数组：Atom 里 `author` / `link` / `category`
 * 只有一个元素时是对象、多个时才是数组，不统一就得在每处访问点写
 * `Array.isArray` 判断 —— 那种判断漏一处就是一个只在「恰好只有一个作者」
 * 时触发的 bug。
 */
function parseEntries(xml: string): AtomEntry[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    isArray: (name) => ["entry", "author", "link", "category"].includes(name),
  });

  const doc = parser.parse(xml) as { feed?: { entry?: AtomEntry[] } };
  return doc.feed?.entry ?? [];
}

function toResult(e: AtomEntry): SearchResult | null {
  const url = pickAbsUrl(e);
  if (!url) return null;

  const author = Array.isArray(e.author)
    ? e.author.map((a) => a.name).filter(Boolean).join(", ")
    : e.author?.name;

  const cats = (Array.isArray(e.category) ? e.category : e.category ? [e.category] : [])
    .map((c) => c["@_term"])
    .filter(Boolean) as string[];

  const title = collapse(e.title ?? "");
  const summary = collapse(e.summary ?? "");

  return {
    id: resultId(url),
    title: title || url,
    url,
    snippet: summary.slice(0, 300),
    domain: "arxiv.org",
    site: "arxiv" as const,
    provider: "arxiv" as const,
    rank: 0, // 由调用方按最终顺序覆写
    hitCount: 1,
    /*
      用 `published`（首次提交）而不是 `updated`（最近一次修订）。
      「这篇研究什么时候做的」比「上次改摘要是什么时候」更接近用户判断
      时效性时要问的问题 —— 一篇 2019 年的论文这个月改了摘要，
      它仍然是一篇 2019 年的论文。
    */
    publishedAt: normalizeToIso(e.published),
    author: author || undefined,
    // 分类放进 snippet 的行尾：cs.CV / cs.LG 这类标签是判断论文领域最直接的依据
    ...(cats.length > 0 ? { snippet: `${summary.slice(0, 280)}${summary.length > 280 ? "…" : ""} [${cats.slice(0, 3).join(", ")}]` } : {}),
    // 刻意没有 signals：见文件头「这个源没有声量信号」
  };
}

/** 取 `rel="alternate"` 的那个链接（HTML 摘要页），没有就退回 id。 */
function pickAbsUrl(e: AtomEntry): string | undefined {
  const links = Array.isArray(e.link) ? e.link : e.link ? [e.link] : [];
  const alt = links.find((l) => l["@_rel"] === "alternate" && l["@_href"]);
  if (alt?.["@_href"]) return alt["@_href"];

  // id 形如 http://arxiv.org/abs/2610.12448v1 —— 换成 https 即可用
  const id = e.id?.trim();
  return id ? id.replace(/^http:/, "https:") : undefined;
}

/** Atom 里换行和缩进是为了人读 XML，进结果前压平。 */
function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
