/**
 * 搜索调度中枢。
 *
 * 职责：把「一个主题」翻译成「一批按站点定向的查询」，并发执行，融合去重，
 * 并一路把进展回传给调用方（以便 SSE 流式展示）。
 *
 * 降级策略：每个站点按 provider 链依次尝试，拿到足够结果就停 —— 不为了「打个
 * 全量」而白白消耗 Serper 的付费配额。
 */

import type {
  ProviderLogEntry,
  SearchProvider,
  SearchResult,
  SiteKey,
} from "@/core/types";
import { config, hasSerper, hasYtdlp } from "@/core/env";
import { SearxngProvider } from "./searxng";
import { SerperProvider } from "./serper";
import { YtDlpProvider } from "./ytdlp";
import { BilibiliProvider } from "./bilibili";
import { limiter, withRetry } from "@/core/limit";
import { normalizeUrl } from "./normalize";

/**
 * 每个 provider 的并发上限。
 * yt-dlp 是重进程只能串行；B 站的公开接口有风控，一次搜索只打一发请求，
 * 这里限 1 是为了避免同站点扇出时把它打到风控。
 */
const CONCURRENCY: Record<string, number> = {
  searxng: 2,
  serper: 5,
  ytdlp: 1,
  bilibili: 1,
};

/** 一个站点拿到这么多结果就不再往链下游走。 */
const ENOUGH_RESULTS = 4;

/** 每站点的抓取条数。 */
const PER_SITE_LIMIT = 10;

export interface OrchestrateOptions {
  topic: string;
  sites: SiteKey[];
  signal?: AbortSignal;
  /** 每个站点一有结果就回调，用于 SSE 增量推送。 */
  onSiteDone?: (site: SiteKey, results: SearchResult[], log: ProviderLogEntry) => void;
}

export interface OrchestrateResult {
  results: SearchResult[];
  log: ProviderLogEntry[];
}

/** 构建 provider 链：商业 API 优先，SearXNG 兜底。 */
async function buildChain(): Promise<SearchProvider[]> {
  const chain: SearchProvider[] = [];
  if (hasSerper()) chain.push(new SerperProvider());
  chain.push(new SearxngProvider());
  return chain;
}

export async function searchAll(
  opts: OrchestrateOptions,
): Promise<OrchestrateResult> {
  const { topic, sites, signal, onSiteDone } = opts;
  const chain = await buildChain();
  const ytdlp = new YtDlpProvider();
  const bilibili = new BilibiliProvider();
  const [ytdlpOk, bilibiliOk] = await Promise.all([
    hasYtdlp(),
    bilibili.available(),
  ]);

  /**
   * 站点专用 provider —— 与通用搜索引擎链是**互补**关系，不是备选关系。
   *
   * 通用链给的是标题+摘要；这些 provider 直连平台接口，能拿到播放量、时长、
   * UP 主这类搜索引擎摘要里根本没有的元数据。所以对同一站点是「合并」而非
   * 「前者失败才用后者」。
   */
  const siteProviders: {
    site: SiteKey;
    provider: SearchProvider;
    limit: number;
    ok: boolean;
  }[] = [
    { site: "youtube", provider: ytdlp, limit: 15, ok: ytdlpOk },
    { site: "bilibili", provider: bilibili, limit: 20, ok: bilibiliOk },
  ];

  const allLogs: ProviderLogEntry[] = [];
  const merged = new Map<string, SearchResult>();

  /** 把新结果并入总表：同一 URL 被多个来源命中时累加 hitCount。 */
  const absorb = (results: SearchResult[]) => {
    for (const r of results) {
      const key = normalizeUrl(r.url);
      const existing = merged.get(key);
      if (existing) {
        existing.hitCount += 1;
        // 保留排名更靠前的那份元数据，但补齐对方有的字段
        if (r.rank < existing.rank) {
          existing.title = existing.title || r.title;
          existing.publishedAt ??= r.publishedAt;
          existing.thumbnail ??= r.thumbnail;
          existing.author ??= r.author;
        } else {
          existing.publishedAt ??= r.publishedAt;
          existing.thumbnail ??= r.thumbnail;
          existing.author ??= r.author;
          existing.durationSec ??= r.durationSec;
          existing.snippet = existing.snippet || r.snippet;
        }
      } else {
        merged.set(key, { ...r });
      }
    }
  };

  // 站点之间并发，互不阻塞
  const siteTasks = sites.map((site) =>
    limiter(`site:${site}`, 2)(async () => {
      const collected: SearchResult[] = [];
      let lastError: string | undefined;

      for (const provider of chain) {
        if (!provider.capabilities.supportsSiteSyntax && site !== "web") continue;

        const t0 = Date.now();
        try {
          const results = await limiter(
            provider.id,
            CONCURRENCY[provider.id] ?? 3,
          )(() =>
            withRetry(() =>
              provider.search({ text: topic, site, limit: PER_SITE_LIMIT }, signal),
            ),
          );
          const ms = Date.now() - t0;
          const log: ProviderLogEntry = {
            provider: provider.id,
            site,
            ok: true,
            count: results.length,
            ms,
          };
          allLogs.push(log);
          collected.push(...results);

          if (results.length >= ENOUGH_RESULTS) break;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          lastError = msg;
          allLogs.push({
            provider: provider.id,
            site,
            ok: false,
            count: 0,
            ms: Date.now() - t0,
            error: msg,
          });
          // 继续尝试链上的下一个 provider
        }
      }

      // 站点专用 provider：与上面通用链的结果合并
      for (const sp of siteProviders) {
        if (sp.site !== site || !sp.ok) continue;
        const t0 = Date.now();
        try {
          const extra = await limiter(sp.provider.id, CONCURRENCY[sp.provider.id] ?? 1)(
            () =>
              withRetry(() =>
                sp.provider.search(
                  { text: topic, site, limit: sp.limit },
                  signal,
                ),
              ),
          );
          allLogs.push({
            provider: sp.provider.id,
            site,
            ok: true,
            count: extra.length,
            ms: Date.now() - t0,
          });
          collected.push(...extra);
        } catch (err) {
          allLogs.push({
            provider: sp.provider.id,
            site,
            ok: false,
            count: 0,
            ms: Date.now() - t0,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const unique = dedupeWithin(collected);
      absorb(unique);

      onSiteDone?.(
        site,
        unique,
        allLogs.at(-1) ?? {
          provider: "searxng",
          site,
          ok: false,
          count: 0,
          ms: 0,
          error: lastError ?? "无结果",
        },
      );
    }),
  );

  await Promise.allSettled(siteTasks);

  // 排序：多源印证优先，其次按排名
  const results = [...merged.values()].sort((a, b) => {
    if (b.hitCount !== a.hitCount) return b.hitCount - a.hitCount;
    return a.rank - b.rank;
  });

  return { results, log: allLogs };
}

/** 同一批次内的去重（跨 provider 的同 URL 只留一条）。 */
function dedupeWithin(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const r of results) {
    const key = normalizeUrl(r.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
