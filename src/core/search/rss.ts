/**
 * RSS / Atom 订阅源。
 *
 * ── 必须说清楚的局限 ──
 *
 * **订阅型 RSS 不能按任意主题搜。** 它只能把订阅表里**恰好命中关键词**的
 * 条目捞出来。所以这一栏的空与满，取决于用户订阅了哪些站，而不是这个源
 * 好不好用。界面上必须写明这一点，否则用户会把它当成又一个搜索引擎，
 * 搜不到就以为坏了。
 *
 * 这是它和 HN/GitHub/arXiv 的根本差别：那三个有搜索接口，RSS 没有 ——
 * RSS 的契约就是「订阅什么，给你什么」。
 *
 * ── 为什么值得接 ──
 *
 * 它补的是搜索引擎补不了的那块：**刚发布、还没来得及被索引**的内容。
 * 一个站的文章从发布到进 bing 索引常常要几小时到几天，而 RSS 是发布即推送。
 * 用户问的「怎么保证最新」，这条源是唯一能真正给出「今天刚发」的通道。
 *
 * ── 解析 ──
 *
 * 用 `fast-xml-parser`，同时吃 RSS 2.0（`<item>`）和 Atom（`<entry>`）——
 * 实测的默认订阅里两种格式都有（V2EX/博客园是 Atom，少数派/InfoQ 是 RSS 2.0）。
 * 归一化到同一个形状，上层不必关心它原来是哪种。
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
import { displayDomain, resultId } from "./normalize";
import { resolveSite } from "./sites";
import { loadFeeds, type Feed } from "./feedstore";

/**
 * 一次抓几个订阅。
 *
 * 4 而不是全部并发：默认订阅就有 6 条，用户可能加到几十条。全铺开会同时
 * 打开几十个连接 —— 对家里的宽带和那些小站的服务器都不礼貌，而且没意义：
 * 这些 feed 的响应都在几百毫秒内，4 路足够在 1~2 秒内走完。
 */
const FEED_CONCURRENCY = 4;

/** 单个 feed 的超时。小站的 RSS 偶尔会慢，但不能拖垮整组。 */
const FEED_TIMEOUT_MS = 8_000;

/** 一个 feed 最多取几条。RSS 通常只给最近 10~50 条，这里再截一道。 */
const PER_FEED_LIMIT = 20;

interface FeedEntry {
  title: string;
  link: string;
  publishedAt?: string;
  author?: string;
  summary: string;
}

/*
  `isArray` 是这里的关键配置。

  fast-xml-parser 默认「只有一个子节点就不给数组」，于是订阅里只有一条
  文章时 `channel.item` 是个对象、有两条时是数组 —— 上层就得写
  `Array.isArray(x) ? x : [x]` 这种到处漏的补丁。指定成数组让形状恒定。
*/
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // 正文里带 HTML 是常态，不要试图理解它，当字符串拿回来自己洗
  trimValues: true,
  isArray: (name) => ["item", "entry", "link", "author", "category"].includes(name),
});

/** 取节点文本。fast-xml-parser 对带属性的节点会返回对象，这里统一取值。 */
function text(node: unknown): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (typeof node === "object") {
    const o = node as Record<string, unknown>;
    // Atom 的 <title type="text">3</title> 会变成 { "#text": "3" }
    if ("#text" in o) return text(o["#text"]);
  }
  return "";
}

/** 洗掉 HTML 标签与实体，压平空白。RSS 的 description 里几乎总是带标签。 */
function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 从 Atom 的 `link` 数组里挑出文章链接。
 *
 * Atom 的 link 是一组带 rel 的链接：`rel="alternate"` 是文章本身，
 * `rel="self"` 是这个 feed 自己，`rel="hub"` 是推送端点。**必须挑
 * alternate** —— 挑错了会给用户一个指向 feed 自身的链接，点进去是一坨 XML。
 * 没有 rel 的（RSS 2.0 的 <link> 或简写的 Atom）也接受。
 */
function pickLink(node: unknown): string {
  const arr = Array.isArray(node) ? node : [node];
  let fallback = "";
  for (const l of arr) {
    if (typeof l === "string") {
      if (l.trim()) fallback ||= l.trim();
      continue;
    }
    if (!l || typeof l !== "object") continue;
    const o = l as Record<string, unknown>;
    const rel = typeof o["@_rel"] === "string" ? o["@_rel"] : "";
    const href = typeof o["@_href"] === "string" ? o["@_href"].trim() : "";
    if (rel === "alternate" && href) return href;
    if (!rel && href) fallback ||= href;
    if (!href) {
      const t = text(l);
      if (t) fallback ||= t;
    }
  }
  return fallback;
}

/** 把一条 RSS `<item>` 或 Atom `<entry>` 归一化成 FeedEntry。 */
function toEntry(node: unknown): FeedEntry | null {
  if (!node || typeof node !== "object") return null;
  const o = node as Record<string, unknown>;

  const title = stripHtml(text(o.title));
  const link = pickLink(o.link) || text(o.guid);
  if (!title || !link || !/^https?:\/\//i.test(link)) return null;

  // RSS: pubDate / dc:date；Atom: published（首次发布）/ updated（最后修改）
  const rawDate =
    o.pubDate ?? o.published ?? o["dc:date"] ?? o.updated ?? o.date ?? "";

  // RSS: author 常是 { email, name }；Atom: author 是数组
  const authorNode = Array.isArray(o.author) ? o.author[0] : o.author;
  const author =
    stripHtml(text(authorNode)) ||
    stripHtml(text(o["dc:creator"])) ||
    undefined;

  const summary = stripHtml(
    text(o.description ?? o.summary ?? o["content:encoded"] ?? o.content),
  ).slice(0, 300);

  return {
    title,
    link,
    publishedAt: normalizeToIso(text(rawDate)),
    author,
    summary,
  };
}

/** 拉一个 feed 并解析。失败抛错，由调用方记进日志。 */
export async function fetchFeed(feed: Feed): Promise<FeedEntry[]> {
  const res = await httpFetch(feed.url, {
    signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
    headers: {
      Accept:
        "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
      // 有些站对没有 UA 的请求直接返回 SPA 外壳（见 feedstore.ts 的实测记录）
      "User-Agent": "Mozilla/5.0 (compatible; muti-eye/0.1)",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const xml = await res.text();

  /*
    「返回 200 但不是 feed」必须当成失败。

    这是 RSS 最坑的失败模式：站点停了 feed 却留着路由，或者前端换成了 SPA，
    请求 200，内容是一整页 HTML。直接喂给解析器会得到 0 条，而 0 条看起来
    和「这个站最近没更新」一模一样 —— 用户永远查不出原因。
    所以这里显式判一下根节点，把「不是 feed」和「feed 是空的」区分开。
  */
  if (!/^\s*(<\?xml|<rss|<feed)/i.test(xml.replace(/^﻿/, ""))) {
    throw new Error("返回的不是 RSS/Atom（可能是 SPA 外壳）");
  }

  const doc = parser.parse(xml) as Record<string, unknown>;

  // RSS 2.0: rss.channel.item[]；Atom: feed.entry[]
  const rss = doc.rss as Record<string, unknown> | undefined;
  const channel = rss?.channel as Record<string, unknown> | undefined;
  const atom = doc.feed as Record<string, unknown> | undefined;
  const raw = channel?.item ?? atom?.entry;
  if (!raw) return [];

  const arr = Array.isArray(raw) ? raw : [raw];
  return arr
    .map(toEntry)
    .filter((e): e is FeedEntry => e !== null)
    .slice(0, PER_FEED_LIMIT);
}

/**
 * 单个检索词是否命中。
 *
 * ── 为什么纯 ASCII 的词必须做词边界匹配 ──
 *
 * 一开始这里是朴素的 `hay.includes(term)`，结果搜「AI 编程」把
 * 「iPhone 电池出国更耐用是玄学吗」也捞了进来 —— 因为 `ai` 是 `email`、
 * `detail`、`Safari`、`maintain` 的子串。低信噪比就是这么来的：
 * 命中判据太松，捞回来的东西把真正相关的挤下去，而用户看到的是
 * 「这个源不准」。
 *
 * 中文没有词边界这个概念，`includes` 就是对的（「编程」出现在
 * 「想学编程」里正是我们想要的）。所以按字符集分两种走法。
 */
function matchTerm(hay: string, term: string): boolean {
  // 纯 ASCII（含空格、标点）的词用词边界；非 ASCII（含中文）的用子串
  if (!/^[\x20-\x7e]+$/.test(term)) return hay.includes(term);
  const esc = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, "i").test(hay);
}

/**
 * 条目是否命中主题。
 *
 * 标题命中权重最高，但只看标题会漏掉太多 —— 中文技术文章的标题常常是
 * 比喻式的（「我是怎么把构建时间砍掉一半的」），关键词只出现在正文里。
 * 所以摘要也一起看。
 *
 * 分词这里刻意用**朴素切分**而不是 jieba：jieba 是 4MB 的 wasm，为一次
 * 关键词命中把它加载起来不划算，而这里的判据本来就宽（命中即收，
 * 排序交给 `rankResults`），不需要精确分词。
 */
function matches(entry: FeedEntry, terms: string[]): boolean {
  const hay = `${entry.title}\n${entry.summary}`.toLowerCase();
  return terms.some((t) => matchTerm(hay, t));
}

/** 主题拆成检索词。中文不切词，整串 + 英文单词分别尝试。 */
function termsOf(text0: string): string[] {
  const whole = text0.trim().toLowerCase();
  if (!whole) return [];
  const out = new Set<string>([whole]);
  // 英文/数字按单词切，中文整串留着（朴素切分对中文没有更好的办法）
  for (const w of whole.split(/[^\p{L}\p{N}+#.]+/u)) {
    if (w.length >= 2) out.add(w);
  }
  return [...out];
}

export class RssProvider implements SearchProvider {
  readonly id = "rss" as const;

  readonly capabilities: ProviderCapabilities = {
    // 订阅表是全站的，没有 site: 这个概念
    supportsSiteSyntax: false,
    supportsVideo: false,
    needsApiKey: false,
    scope: "topic",
  };

  async available(): Promise<boolean> {
    const { feeds } = await loadFeeds();
    return feeds.some((f) => f.enabled);
  }

  async search(q: SearchQuery, signal?: AbortSignal): Promise<SearchResult[]> {
    const { feeds } = await loadFeeds();
    const enabled = feeds.filter((f) => f.enabled);
    if (enabled.length === 0) return [];

    const terms = termsOf(q.text);
    if (terms.length === 0) return [];

    /*
      并发抓取，但**不因为一个 feed 挂了就丢整组**。

      把每条订阅的失败隔离在自己的 catch 里：`Promise.allSettled` 会给出
      每个的结果，坏掉的那几条只影响自己。一个源失败就整栏空白，是最让人
      摸不着头脑的失败方式。
    */
    const results: SearchResult[] = [];
    const queue = [...enabled];

    const worker = async () => {
      for (;;) {
        const feed = queue.shift();
        if (!feed || signal?.aborted) return;
        try {
          const entries = await fetchFeed(feed);
          for (const e of entries) {
            if (!matches(e, terms)) continue;
            results.push({
              id: resultId(e.link),
              title: e.title,
              url: e.link,
              snippet: e.summary,
              // domain 是内容真正所在的站（比如少数派的文章在 sspai.com），
              // 不是「RSS」—— 订阅只是一个通道，不是一个内容来源
              domain: displayDomain(e.link),
              site: resolveSite(e.link),
              provider: this.id,
              rank: results.length + 1,
              hitCount: 1,
              publishedAt: e.publishedAt,
              author: e.author,
            });
          }
        } catch {
          // 单条订阅失败不抛：这个源的整体成败由调用方按「拿到几条」判断，
          // 逐条的原因记在 providerLog 的 count 里（见 orchestrate.ts）
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(FEED_CONCURRENCY, enabled.length) }, worker),
    );

    // 已按发布时间降序是 RSS 的天然顺序，但不同 feed 拼在一起就乱了，
    // 这里统一按时间重排一遍；没日期的沉底（与 rankResults 的约定一致）
    results.sort((a, b) => {
      const ta = a.publishedAt ? Date.parse(a.publishedAt) : NaN;
      const tb = b.publishedAt ? Date.parse(b.publishedAt) : NaN;
      if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
      if (Number.isNaN(ta)) return 1;
      if (Number.isNaN(tb)) return -1;
      return tb - ta;
    });

    return results.slice(0, q.limit ?? 20).map((r, i) => ({ ...r, rank: i + 1 }));
  }
}
