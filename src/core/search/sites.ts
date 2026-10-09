/**
 * 站点注册表。
 *
 * 关于检索方式的一个重要修正：**不要把 site: 操作符当作跨站检索的支柱**。
 *
 * 计划阶段的设计是「用 site:zhihu.com 这类定向语法让搜索引擎替我们完成跨站
 * 检索」。实际在本机的 SearXNG + bing 链路上实测，bing **完全忽略 site:**
 * （`site:taobao.com 露营装备` 会返回淘宝+知乎+搜狐等一堆域名；
 * `site:docs.python.org 北京天气` 返回的是百度百科和北京政府网）。
 * 早先看起来「生效」的 `site:docs.python.org asyncio`，只是因为 asyncio 文档
 * 本来就排在最前面，是巧合而非过滤。
 *
 * 因此改为两步走：
 *   1. 查询里加上平台关键词做「注意力偏置」（聊胜于无，bing 对额外词条也不敏感）
 *   2. **拿到结果后在本地按域名过滤**，只保留真正属于该平台的结果
 *
 * 过滤这一步是关键：它保证「小红书」这一栏里不会混进知乎的结果 ——
 * 宁可显示空，也不要给出错误归属的资料。
 *
 * 覆盖度的现实：bing 基本不收录小红书和 X（两家都拦爬虫），所以这两栏
 * 大概率是空的。要补齐只能上商业 API 或平台原生接口，不是本层能解决的。
 */

import type { DocKind, SiteKey } from "@/core/types";

export interface SiteTarget {
  key: SiteKey;
  /** 正式名。报告正文、下载的 frontmatter、日志里用这个。 */
  label: string;
  /**
   * 空间受限处的展示名（界面芯片、结果分组标题）。缺省即 label。
   *
   * 「哔哩哔哩 → B 站」「X / Twitter → X」不是重复定义，是两种用途：
   * 芯片只有一格宽度，正式名在那儿会把整行撑开。
   */
  shortLabel?: string;
  domain: string;
  /** 用于偏置搜索的关键词。空串表示不加。 */
  keyword: string;
  kind: DocKind;
  /** 该站点通常拿不到正文，UI 需要提前说明，避免用户以为是 bug。 */
  contentLimited?: boolean;
  /**
   * 只由自己的 provider 检索，**不参与搜索引擎链**。
   *
   * GitHub / arXiv / HN 都有「一个接口覆盖全站」的公开 API，走 API 拿到的
   * 字段（star 数、引用日期、评论数）比搜索引擎摘要强得多；而且 bing 本来
   * 就忽略 `site:`，让它们再走一遍引擎链只是多花一次请求、多一份噪音。
   */
  directOnly?: boolean;
  color: string;
}

/**
 * 站点注册表 —— **站点的唯一事实来源**。
 *
 * 加一个站点只需要动两处：`types.ts` 的 `SiteKey` 联合类型，和这里。
 * 界面顺序、展示名、域名过滤、报告里的正式名全部从这里派生（见 `SITE_ORDER`、
 * `siteLabel` / `siteShortLabel`）。此前这几样散在 5 个文件里各写一遍，
 * 加一个站点要改 5 处，漏一处就会出现「芯片上有、报告里没有」这类不一致。
 *
 * **声明顺序就是界面顺序**（`SITE_ORDER` 由 `Object.keys` 派生），
 * 所以别随手把它排序。
 */
export const SITE_TARGETS: Record<SiteKey, SiteTarget> = {
  zhihu: {
    key: "zhihu",
    label: "知乎",
    domain: "zhihu.com",
    keyword: "知乎",
    kind: "social",
    contentLimited: true,
    color: "#0084ff",
  },
  bilibili: {
    key: "bilibili",
    label: "哔哩哔哩",
    shortLabel: "B 站",
    domain: "bilibili.com",
    keyword: "哔哩哔哩",
    kind: "video",
    color: "#fb7299",
  },
  youtube: {
    key: "youtube",
    label: "YouTube",
    domain: "youtube.com",
    keyword: "YouTube",
    kind: "video",
    color: "#ff0000",
  },
  xiaohongshu: {
    key: "xiaohongshu",
    label: "小红书",
    domain: "xiaohongshu.com",
    keyword: "小红书",
    kind: "social",
    contentLimited: true,
    color: "#ff2442",
  },
  x: {
    key: "x",
    label: "X / Twitter",
    shortLabel: "X",
    domain: "x.com",
    keyword: "Twitter",
    kind: "social",
    contentLimited: true,
    color: "#1d9bf0",
  },
  /*
    掘金。走的是**普通站点**那条路（引擎链 + 域名过滤），不是主题源。

    它有真实域名、文章正文在公开页面上，`resolveSite()` 判得中，抓取层也拿得到
    正文 —— 与知乎同构。**没有为它写直连 provider**：掘金的站内搜索接口要
    `X-Legal-Signature` 之类的签名头，属于用户明令不碰的那一类
    （见 AGENTS 里的红线），所以这里只借搜索引擎的索引。

    代价要说清楚：能否搜到完全取决于 bing 是否收录了相关文章。
    那一栏空着是上游事实，不是 bug。
  */
  juejin: {
    key: "juejin",
    label: "掘金",
    domain: "juejin.cn",
    keyword: "掘金",
    kind: "article",
    color: "#1e80ff",
  },
  /*
    下面三个是「主题源」：各有自己的公开接口，一个主题查一次，不走引擎链。

    ── HN 的 domain 为什么是空串 ──

    `README` 里那条规则是「SiteKey 表示内容住在哪」，`resolveSite()` 按域名
    反查。GitHub / arXiv 有真实域名，且它们的 API 返回的就是该域名下的内容，
    所以填域名。

    HN 不一样：它的条目是**指向别处**的链接 —— 一条 HN story 的内容可能住在
    github.com、可能住在某个人的博客。把 hackernews 也填上 news.ycombinator.com，
    那条 GitHub 链接就会被 `resolveSite` 标成「来自 Hacker News」，而它明明
    是一篇 GitHub 仓库 —— 归属错了，且这种错比「空着」难发现得多。

    所以这三个里只有 HN 留空 domain：**它只作为「要不要查这个源」的开关，
    以及 UI 上的一个芯片**，不参与归属判定。HN 结果的出处由 `provider` 字段
    承载（界面上的「按来源分组」视图看的就是它）。
  */
  hackernews: {
    key: "hackernews",
    label: "Hacker News",
    shortLabel: "HN",
    domain: "",
    keyword: "",
    kind: "unknown",
    directOnly: true,
    color: "#ff6600",
  },
  github: {
    key: "github",
    label: "GitHub",
    domain: "github.com",
    keyword: "",
    kind: "article",
    directOnly: true,
    color: "#8b949e",
  },
  arxiv: {
    key: "arxiv",
    label: "arXiv",
    domain: "arxiv.org",
    keyword: "",
    kind: "article",
    directOnly: true,
    color: "#b31b1b",
  },
  /*
    RSS 订阅。和 HN 一样，domain 留空 —— 条目指向的是少数派、V2EX、
    博客园这些站，填个 rss 的域名只会让 `resolveSite` 把它们全标错。

    它与其他主题源有个本质差别：**不能按任意主题搜**，只能捞订阅表里
    恰好命中关键词的条目。这一点必须在界面上讲清楚。
  */
  rss: {
    key: "rss",
    label: "RSS 订阅",
    shortLabel: "RSS",
    domain: "",
    keyword: "",
    kind: "article",
    directOnly: true,
    color: "#f26522",
  },
  web: {
    key: "web",
    label: "全网",
    domain: "",
    keyword: "",
    kind: "unknown",
    color: "#8b8b8b",
  },
};

/** 界面上站点芯片的排列顺序。取自注册表的声明顺序。 */
export const SITE_ORDER = Object.keys(SITE_TARGETS) as SiteKey[];

/**
 * 默认勾选的站点。'web' 始终兜底。
 *
 * 三个主题源默认打开：它们是**补充**，不是替代 —— arXiv 与 HN 完全可靠，
 * GitHub 未认证时有 10 次/分的配额（超了会返回空结果并在检索日志里写明
 * 原因，不会让整次搜索失败）。
 */
export const DEFAULT_SITES: SiteKey[] = [
  "zhihu",
  "juejin",
  "bilibili",
  "youtube",
  "hackernews",
  "github",
  "arxiv",
  "rss",
  "web",
];

/** 该站点是否只由自己的 provider 检索（即不参与搜索引擎链）。 */
export function isDirectOnly(site: SiteKey): boolean {
  return SITE_TARGETS[site]?.directOnly === true;
}

/**
 * provider 的展示名。
 *
 * **为什么不放在 `registry.ts`**：那里 import 了三个 provider 模块，而它们
 * 又 import `@/core/fetch/agent` 和 `normalize`（`node:crypto`）。这个表要被
 * `"use client"` 的 `SearchPanel` 用，从那边引会把 node 模块拖进浏览器包。
 * 放这里是因为 `sites.ts` 只依赖 `@/core/types`，是现成的「命名注册表」。
 *
 * 键用 `string` 而不是 `ProviderId`：日志是从 session.json 读回来的，
 * 可能是旧版本写下的 provider 名。认不出来原样返回，显示 `foo` 好过 `undefined`。
 */
const PROVIDER_LABELS: Record<string, string> = {
  serper: "Serper",
  searxng: "SearXNG",
  ytdlp: "yt-dlp",
  bilibili: "B 站接口",
  hackernews: "Hacker News",
  github: "GitHub API",
  arxiv: "arXiv",
  rss: "RSS 订阅",
};

/** provider 展示名。认不出来则原样返回。 */
export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

/**
 * 构造查询串。
 *
 * 显式传入 domain 时仍用 site: 语法 —— 部分 SearXNG 上游引擎（尤其非 bing 的）
 * 是支持它的，能用就用；但**不能依赖它**，所以调用方必须再做一次域名过滤。
 */
export function buildQuery(
  topic: string,
  site: SiteKey,
  domain?: string,
): string {
  if (domain) return `${topic} site:${domain}`;
  const target = SITE_TARGETS[site];
  if (!target.keyword) return topic;
  return `${topic} ${target.keyword}`;
}

/** 该站点对应的归属域名。web 返回空串，表示不做域名过滤。 */
export function siteDomain(site: SiteKey): string {
  return SITE_TARGETS[site].domain;
}

/*
  下面两个取值函数刻意收 `string` 而不是 `SiteKey`。

  调用点有两类：一类手里确实是 SiteKey，另一类是刚从 session.json 读回来的
  `site` 字段 —— 那是磁盘上的数据，可能是旧版本写下的、现在已经不存在的站点名。
  收窄成 SiteKey 会逼着每个读取点先做一次「这真的合法吗」的断言，而这里本来就
  有完整的回退路径，没有必要。认不出来就把原值原样返回，界面上显示 `foo`
  总好过显示 `undefined`。
*/
function targetOf(site: string): SiteTarget | undefined {
  return (SITE_TARGETS as Record<string, SiteTarget | undefined>)[site];
}

/** 正式名。报告、frontmatter、日志用这个。认不出来则原样返回。 */
export function siteLabel(site: string): string {
  return targetOf(site)?.label ?? site;
}

/** 界面展示名（芯片、分组标题）。认不出来则原样返回。 */
export function siteShortLabel(site: string): string {
  const t = targetOf(site);
  return t?.shortLabel ?? t?.label ?? site;
}

/**
 * URL 是否属于该域名（含子域）。
 *
 * 用 host 后缀匹配而非 `host.includes(domain)`：后者会让
 * `evil.com/zhihu.com` 或 `zhihu.com.evil.com` 蒙混过关。
 */
export function belongsToDomain(url: string, domain: string): boolean {
  if (!domain) return true;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === domain || host.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

/**
 * 从 URL 反查站点归属。用于把搜索结果归类。
 *
 * 走 `belongsToDomain` 而不是自己写 `host.endsWith(domain)`：裸后缀匹配会让
 * `notzhihu.com` / `eviljuejin.cn` 这类域名被判成对应站点 —— 它们只是**以**
 * 那个域名结尾，跟它没有任何关系。`belongsToDomain` 要求恰好相等或多一级子域。
 *
 * `target.domain` 为空的（HN / 全网）必须跳过：空的 domain 在
 * `belongsToDomain` 里表示「不做过滤」，直接传进去会命中一切。
 */
export function resolveSite(url: string): SiteKey {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "web";
  }
  for (const target of Object.values(SITE_TARGETS)) {
    if (target.domain && belongsToDomain(url, target.domain)) return target.key;
  }
  // 常见的 X 域名变体
  if (host === "twitter.com" || host.endsWith(".twitter.com")) return "x";
  return "web";
}
