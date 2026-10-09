/**
 * SearXNG 搜索提供方（默认，免 API key）。
 *
 * SearXNG 是个元搜索引擎：它把查询扇出给 Google/Bing/Baidu 等上游，再聚合结果。
 * 这正是我们要的 —— 用它一处接入，就同时获得了多家搜索引擎的覆盖。
 *
 * 前提：实例的 settings.yml 里 search.formats 必须包含 json，否则一律 403。
 */

import type {
  ProviderCapabilities,
  SearchProvider,
  SearchQuery,
  SearchResult,
} from "@/core/types";
import { config, checkSearxng } from "@/core/env";
import { normalizeToIso } from "@/core/dates";
import { belongsToDomain, buildQuery, resolveSite, siteDomain } from "./sites";
import { displayDomain, resultId } from "./normalize";

interface SearxngResult {
  url?: string;
  title?: string;
  content?: string;
  publishedDate?: string | null;
  thumbnail?: string | null;
  engine?: string;
  length?: number;
}

interface SearxngResponse {
  results?: SearxngResult[];
  number_of_results?: number;
}

export class SearxngProvider implements SearchProvider {
  readonly id = "searxng" as const;

  readonly capabilities: ProviderCapabilities = {
    supportsSiteSyntax: true,
    supportsVideo: false,
    needsApiKey: false,
  };

  async available(): Promise<boolean> {
    return (await checkSearxng()).ok;
  }

  async search(q: SearchQuery, signal?: AbortSignal): Promise<SearchResult[]> {
    const queryText = buildQuery(q.text, q.site ?? "web", q.domain);
    const url = new URL(`${config.searxngUrl.replace(/\/$/, "")}/search`);
    url.searchParams.set("q", queryText);
    url.searchParams.set("format", "json");
    url.searchParams.set("language", q.language ?? "zh-CN");
    url.searchParams.set("categories", "general");
    url.searchParams.set("safesearch", "0");
    /*
      SearXNG 的 time_range 取值恰好就是 day/week/month/year，与 TimeRange 同形。

      这里传了不等于过滤一定发生 —— 它只是被转译给上游引擎，而各引擎的支持度
      差别很大（bing 这类会直接忽略）。所以调用方拿回结果后**必须**再走一遍
      `filterByTime` 兜底，不能因为「参数已经发出去了」就当筛过了。
    */
    url.searchParams.set("time_range", q.timeRange ?? "");

    const res = await fetch(url, {
      signal: signal ?? AbortSignal.timeout(config.fetchTimeoutMs),
      headers: {
        Accept: "application/json",
        "Accept-Language": q.language ?? "zh-CN",
      },
    });

    if (res.status === 403) {
      throw new Error(
        "SearXNG 返回 403：settings.yml 的 search.formats 里未启用 json",
      );
    }
    if (!res.ok) {
      throw new Error(`SearXNG HTTP ${res.status}`);
    }

    const data = (await res.json()) as SearxngResponse;
    const raw = data.results ?? [];
    const limit = q.limit ?? 10;
    const site = q.site ?? "web";

    // 域名过滤。上游 bing 忽略 site: 操作符，所以「按站点定向」实际靠这一步兜底：
    // 指定了平台就只保留真正属于该平台的结果，否则宁可返回空 ——
    // 让小红书那一栏空着，也比塞满知乎的结果、给出错误的归属要好。
    const domain = q.domain ?? siteDomain(site);
    const scoped = domain
      ? raw.filter((r) => r.url && belongsToDomain(r.url, domain))
      : raw;

    return scoped
      .filter((r): r is SearxngResult & { url: string } => Boolean(r.url))
      .slice(0, limit)
      .map((r, i) => ({
        id: resultId(r.url),
        title: (r.title ?? "").trim() || r.url,
        url: r.url,
        snippet: (r.content ?? "").trim(),
        domain: displayDomain(r.url),
        // 用 URL 反查的真实站点归属，而不是请求时指定的 site ——
        // site: 限定并非严格，偶尔会漏进别的域，以实际为准更诚实
        site: resolveSite(r.url) || site,
        provider: this.id,
        rank: i + 1,
        hitCount: 1,
        // 各上游引擎给的日期格式不统一（ISO / `Aug 12, 2026` / 时间戳都见过），
        // 归一化到 ISO 之后下游才敢用它排序和展示
        publishedAt: normalizeToIso(r.publishedDate),
        thumbnail: r.thumbnail ?? undefined,
      }));
  }
}
