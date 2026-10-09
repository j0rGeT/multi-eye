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
  ResultSignal,
  SearchProvider,
  SearchResult,
  SiteKey,
  SortMode,
  TimeRange,
} from "@/core/types";
import { config, hasSerper, hasYtdlp } from "@/core/env";
import { SearxngProvider } from "./searxng";
import { SerperProvider } from "./serper";
import { YtDlpProvider } from "./ytdlp";
import { BilibiliProvider } from "./bilibili";
import { limiter, withRetry } from "@/core/limit";
import { normalizeUrl } from "./normalize";
import { filterByTime } from "./filter";
import { signalMagnitude } from "@/core/signals";

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
  /** 时效窗口。既转给上游，也在本地兜底过滤（上游常常忽略它）。 */
  timeRange?: TimeRange;
  /** 融合排序方式。默认 `relevant`（多源印证优先）。 */
  sortMode?: SortMode;
  /** 每个站点一有结果就回调，用于 SSE 增量推送。 */
  onSiteDone?: (site: SiteKey, results: SearchResult[], log: ProviderLogEntry) => void;
}

export interface OrchestrateResult {
  results: SearchResult[];
  log: ProviderLogEntry[];
  /**
   * 时效过滤的结果统计，要展示给用户。
   *
   * `unknown` 尤其重要：它说明有多少条结果因为**没有日期**而无法被时间窗口
   * 判断、于是被保留了下来。不显示这个数，用户会以为「一周内」是严格的。
   */
  timeFilter: { dropped: number; unknown: number };
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
  const { topic, sites, signal, timeRange, sortMode, onSiteDone } = opts;
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
        existing.signals = mergeSignals(existing.signals, r.signals);
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
              provider.search(
                { text: topic, site, limit: PER_SITE_LIMIT, timeRange, sortMode },
                signal,
              ),
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
                  { text: topic, site, limit: sp.limit, timeRange, sortMode },
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

  const ranked = rankResults([...merged.values()], sortMode ?? "relevant");
  const { kept, dropped, unknown } = filterByTime(ranked, timeRange);

  return { results: kept, log: allLogs, timeFilter: { dropped, unknown } };
}

/**
 * 融合排序。抽成纯函数是为了能单独验证 —— 排序规则一改，全站结果顺序都变，
 * 而它藏在 `searchAll` 的末尾时根本没法单测。
 *
 * 三种模式的取舍：
 *
 * - `relevant`（默认）多源印证优先，其次上游排名。这是这套系统一直以来的
 *   行为，也是它的核心主张：多个来源都提到了它，才更可能是这个主题的关键资料。
 * - `recent` 纯按发布日期降序，**没有日期的一律排最后**。不是排到中间也不是
 *   排最前 —— 我们不知道它有多新，把它插在已知时间的资料之间就是在编造秩序。
 * - `mixed` 印证与时效各占一半权重，见下面的衰减函数。
 * - `quality` 按来源自带的客观指标（star / 播放 / 评论）排，**没有任何指标的
 *   一律排最后**。
 *
 * `quality` 这一档要说清楚它**不是**什么：它排的是「公开声量」，不是「内容正确」。
 * 一个 20k star 的仓库仍然可能是个有坑的轮子，一条 100 万播放的视频仍然可能
 * 是错的。它能回答的只是「很多人在看这个」。之所以还是提供了这个模式，是因为
 * 在 GitHub / HN / 视频站这类有真实社区信号的源上，「很多人在看」确实是筛掉
 * 长尾噪音最有效的一把刀 —— 但它必须由用户自己选，不能当默认。
 */
export function rankResults(
  results: SearchResult[],
  mode: SortMode = "relevant",
): SearchResult[] {
  /**
   * 末位按归一化 URL 兜底，让整个排序**完全确定**。
   *
   * 不兜这一下会掉进一个很隐蔽的坑：`hitCount` 绝大多数时候是 1，而
   * `rank` 是**各 provider 内部**的序号，跨来源大量撞号（每条结果都可能是
   * 自己那个源里的第 1 名）。于是一大批条目在各个比较维度上全部相等，
   * 排序结果就退化成「谁先进 `merged` 谁在前」—— 而进场顺序取决于哪个
   * 站点的网络先返回。表现是**同样的查询两次跑出不同的列表顺序**，
   * 用户会以为结果变了，测试也会时绿时红。
   */
  const byEvidence = (a: SearchResult, b: SearchResult) =>
    b.hitCount - a.hitCount ||
    a.rank - b.rank ||
    normalizeUrl(a.url).localeCompare(normalizeUrl(b.url));

  const arr = [...results];
  if (mode === "relevant") return arr.sort(byEvidence);

  if (mode === "quality") {
    return arr.sort((a, b) => {
      const ma = signalMagnitude(a.signals);
      const mb = signalMagnitude(b.signals);
      // 有指标的和没指标的之间划一道硬边界：`log10(1+0)=0` 会让「0 播放」
      // 和「压根没有播放量这个字段」拿到同一个分数，而这两件事完全不同 ——
      // 前者是「大家都知道它没人看」，后者是「这个源不给这个数」。
      const hasA = ma > 0 ? 1 : 0;
      const hasB = mb > 0 ? 1 : 0;
      if (hasA !== hasB) return hasB - hasA;
      return mb - ma || byEvidence(a, b);
    });
  }

  const timeOf = (r: SearchResult) => {
    const t = r.publishedAt ? Date.parse(r.publishedAt) : NaN;
    return Number.isNaN(t) ? undefined : t;
  };

  if (mode === "recent") {
    return arr.sort((a, b) => {
      const ta = timeOf(a);
      const tb = timeOf(b);
      if (ta === undefined && tb === undefined) return byEvidence(a, b);
      if (ta === undefined) return 1;
      if (tb === undefined) return -1;
      return tb - ta || byEvidence(a, b);
    });
  }

  /*
    mixed：证据分 + 新鲜度分。

    新鲜度按 30 天半衰期指数衰减（`0.5 ** (天数/30)`）—— 一个月前的资料
    拿 0.5 分，三个月前 0.125 分，一年前约等于 0。选 30 天是因为这套系统
    面向的是「主题调研」，一个月往往是用户心里「还算新」的边界。

    没有日期的取 0.25：既不奖励也不惩罚到把有日期的资料全挤下去。这是一个
    **显式写出来的折中**，不是「不知道就随便给个中间值」—— 给 0 会让所有
    无日期资料沉底（等于静默用它缺失的字段惩罚它），给 0.5 又会让它冒充
    一个月新的资料。

    系数 2 与 3 让「一条很新的一手资料」压过「两条半年前的二手转载」，
    同时三条以上互相印证的资料仍然靠前。
  */
  const now = Date.now();
  const HALF_LIFE_DAYS = 30;
  const score = (r: SearchResult) => {
    const t = timeOf(r);
    const freshness =
      t === undefined
        ? 0.25
        : Math.pow(0.5, (now - t) / (HALF_LIFE_DAYS * 86_400_000));
    return 2 * r.hitCount + 3 * freshness;
  };

  return arr.sort((a, b) => score(b) - score(a) || byEvidence(a, b));
}

/**
 * 合并两个来源给的客观指标。
 *
 * 同名标签取**较大值**而不是相加：同一个 YouTube 视频被 ytdlp 和搜索引擎
 * 各报一次播放量，两个数都是「这个视频的播放量」这个事实的不同读数，
 * 加起来会变成 2 倍播放量 —— 凭空造出一个不存在的数字。取大值相当于
 * 「谁看到的更全就用谁的」，虽然粗糙，但至少还是真实观测到的数。
 */
export function mergeSignals(
  a: ResultSignal[] | undefined,
  b: ResultSignal[] | undefined,
): ResultSignal[] | undefined {
  if (!a?.length) return b;
  if (!b?.length) return a;

  const byLabel = new Map(a.map((s) => [s.label, { ...s }]));
  for (const s of b) {
    const prev = byLabel.get(s.label);
    if (!prev || s.value > prev.value) byLabel.set(s.label, { ...s });
  }
  return [...byLabel.values()];
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
