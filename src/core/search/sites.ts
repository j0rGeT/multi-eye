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
  label: string;
  domain: string;
  /** 用于偏置搜索的关键词。空串表示不加。 */
  keyword: string;
  kind: DocKind;
  /** 该站点通常拿不到正文，UI 需要提前说明，避免用户以为是 bug。 */
  contentLimited?: boolean;
  color: string;
}

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
  xiaohongshu: {
    key: "xiaohongshu",
    label: "小红书",
    domain: "xiaohongshu.com",
    keyword: "小红书",
    kind: "social",
    contentLimited: true,
    color: "#ff2442",
  },
  youtube: {
    key: "youtube",
    label: "YouTube",
    domain: "youtube.com",
    keyword: "YouTube",
    kind: "video",
    color: "#ff0000",
  },
  x: {
    key: "x",
    label: "X / Twitter",
    domain: "x.com",
    keyword: "Twitter",
    kind: "social",
    contentLimited: true,
    color: "#1d9bf0",
  },
  bilibili: {
    key: "bilibili",
    label: "哔哩哔哩",
    domain: "bilibili.com",
    keyword: "哔哩哔哩",
    kind: "video",
    color: "#fb7299",
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

/** 默认勾选的站点。'web' 始终兜底。 */
export const DEFAULT_SITES: SiteKey[] = [
  "zhihu",
  "bilibili",
  "youtube",
  "web",
];

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

/** 从 URL 反查站点归属。用于把搜索结果归类。 */
export function resolveSite(url: string): SiteKey {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "web";
  }
  for (const target of Object.values(SITE_TARGETS)) {
    if (target.domain && host.endsWith(target.domain)) return target.key;
  }
  // 常见的 X 域名变体
  if (host.endsWith("twitter.com")) return "x";
  return "web";
}
