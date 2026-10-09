/**
 * Serper 搜索提供方（可选）。
 *
 * 仅在配置了 SERPER_API_KEY 时注册。相比自建 SearXNG，它稳定、有 SLA、
 * 返回结构化的摘要和日期，代价是按次计费。失败时整条链路会自动降级回 SearXNG。
 */

import type {
  ProviderCapabilities,
  SearchProvider,
  SearchQuery,
  SearchResult,
} from "@/core/types";
import { config, hasSerper } from "@/core/env";
import { normalizeToIso } from "@/core/dates";
import { buildQuery, resolveSite } from "./sites";
import { displayDomain, resultId } from "./normalize";

interface SerperOrganic {
  title?: string;
  link?: string;
  snippet?: string;
  date?: string;
  position?: number;
  imageUrl?: string;
}

interface SerperResponse {
  organic?: SerperOrganic[];
}

export class SerperProvider implements SearchProvider {
  readonly id = "serper" as const;

  readonly capabilities: ProviderCapabilities = {
    supportsSiteSyntax: true,
    supportsVideo: false,
    needsApiKey: true,
  };

  async available(): Promise<boolean> {
    return hasSerper();
  }

  async search(q: SearchQuery, signal?: AbortSignal): Promise<SearchResult[]> {
    if (!hasSerper()) throw new Error("未配置 SERPER_API_KEY");

    const queryText = buildQuery(q.text, q.site ?? "web", q.domain);
    const site = q.site ?? "web";

    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      signal: signal ?? AbortSignal.timeout(config.fetchTimeoutMs),
      headers: {
        "X-API-KEY": config.serperApiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        q: queryText,
        num: q.limit ?? 10,
        gl: "cn",
        hl: q.language ?? "zh-cn",
      }),
    });

    if (res.status === 401 || res.status === 403) {
      throw new Error("Serper 鉴权失败：SERPER_API_KEY 无效");
    }
    if (res.status === 429) {
      throw new Error("Serper 配额已用尽");
    }
    if (!res.ok) {
      throw new Error(`Serper HTTP ${res.status}`);
    }

    const data = (await res.json()) as SerperResponse;
    const organic = data.organic ?? [];

    return organic
      .filter((r): r is SerperOrganic & { link: string } => Boolean(r.link))
      .map((r, i) => ({
        id: resultId(r.link),
        title: (r.title ?? "").trim() || r.link,
        url: r.link,
        snippet: (r.snippet ?? "").trim(),
        domain: displayDomain(r.link),
        site: resolveSite(r.link) || site,
        provider: this.id,
        rank: r.position ?? i + 1,
        hitCount: 1,
        // Serper 的 date 是自然语言（「3 天前」），归一化只在能解析出结果时才带上
        publishedAt: normalizeToIso(r.date),
        thumbnail: r.imageUrl,
      }));
  }
}

