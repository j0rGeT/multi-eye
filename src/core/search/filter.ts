/**
 * 本地时效过滤。
 *
 * ── 为什么上游的 time_range 不够 ──
 *
 * SearXNG 支持 `time_range` 参数，但它是**按引擎转译**的，而各引擎的支持度
 * 天差地别：有的支持 `qdr:d/w/m/y`，有的支持 `df=` 时间戳，bing 这类直接忽略。
 * 这和 `site:` 操作符是同一个坑（见 sites.ts 开头那段实测记录）——
 * 参数发出去了、也返回 200，但过滤根本没发生。
 *
 * 只依赖上游的结果是：用户勾了「一周内」，界面上却混着三年前的资料，
 * 而且**没有任何提示告诉他筛选没生效**。所以这里必须再本地过滤一遍。
 * 上游认，是省事；上游不认，这里兜住。
 *
 * ── 缺日期的不丢 ──
 *
 * 没有 `publishedAt` 的条目**一律保留**，只统计条数。理由和整个项目一致：
 * 静默丢弃是这里最忌讳的事。一条日期未知的结果，可能是今天刚发的、也可能是
 * 五年前的，我们没有证据把它判出局 —— 但用户有权知道「这一批里有 N 条
 * 无从判断」，所以 `unknown` 要回传给调用方并显示出来。
 */

import type { SortMode, TimeRange } from "@/core/types";

export const TIME_RANGE_MS: Record<TimeRange, number> = {
  day: 86_400_000,
  week: 604_800_000,
  month: 2_592_000_000,
  year: 31_536_000_000,
};

/** 界面上的下拉项。顺序即展示顺序，从紧到松。 */
export const TIME_RANGE_LABELS: Record<TimeRange, string> = {
  day: "一天内",
  week: "一周内",
  month: "一月内",
  year: "一年内",
};

export const TIME_RANGE_ORDER: TimeRange[] = ["day", "week", "month", "year"];

/**
 * 排序模式的中文名。
 *
 * 放在 core 而不是组件里，是因为报告（服务端）也要印这几个词 ——
 * 两份文案分开写迟早会漂移，而「报告里写的排序方式不是界面上选的那个」
 * 是那种没人会发现、发现了也说不清的错误。
 */
export const SORT_LABELS: Record<SortMode, string> = {
  relevant: "印证优先",
  recent: "最新优先",
  mixed: "印证 + 时效",
  quality: "声量优先",
};

export interface TimeFilterResult<T> {
  kept: T[];
  /** 因为超出窗口被剔除的条数。 */
  dropped: number;
  /** 没有发布日期、无从判断、因此保留的条数。 */
  unknown: number;
}

/**
 * 按时间窗口过滤。
 *
 * `range` 为空表示不筛，原样返回（但 `unknown` 照样统计 —— 界面在任何时候
 * 都该能告诉用户有多少条结果没有日期）。
 */
export function filterByTime<T extends { publishedAt?: string }>(
  items: readonly T[],
  range: TimeRange | undefined,
  now: number = Date.now(),
): TimeFilterResult<T> {
  if (!range) {
    return {
      kept: [...items],
      dropped: 0,
      unknown: items.filter((it) => !it.publishedAt).length,
    };
  }

  const cutoff = now - TIME_RANGE_MS[range];
  const kept: T[] = [];
  let dropped = 0;
  let unknown = 0;

  for (const it of items) {
    if (!it.publishedAt) {
      unknown += 1;
      kept.push(it);
      continue;
    }
    const t = Date.parse(it.publishedAt);
    if (Number.isNaN(t)) {
      // 理论上不会走到这里（normalizeToIso 只产出合法 ISO），
      // 但磁盘上的旧数据可能是归一化之前写的。按「未知」处理。
      unknown += 1;
      kept.push(it);
      continue;
    }
    if (t >= cutoff) kept.push(it);
    else dropped += 1;
  }

  return { kept, dropped, unknown };
}

/**
 * 「全部 / 仅视频 / 仅图文」这组界面筛选项。
 *
 * `null` 表示不筛。刻意**不**把 social 与 unknown 单独列出来：用户想做的
 * 区分是「视频还是文章」，多两档只会让他每次都要多点一次。它们都归到
 * 「图文」侧，与打包目录的归属（`packageDirFor`）保持同一口径 ——
 * 界面上看到的分类和包里看到的目录必须是同一件事。
 */
export type KindFilter = "all" | "video" | "article";

export const KIND_FILTER_LABELS: Record<KindFilter, string> = {
  all: "全部",
  video: "仅视频",
  article: "仅图文",
};

export const KIND_FILTER_ORDER: KindFilter[] = ["all", "video", "article"];

/**
 * 按内容类型筛。
 *
 * 拿的是 `contentKind` 的结果而不是原始的 `DocKind`：`social`/`unknown`
 * 都被并进「图文」，所以这里判的是「是不是视频」而不是精确相等。
 *
 * `items` 同时接受 `SearchResult` 和 `Document` —— 前者没有 `kind` 字段
 * （搜索结果还没抓正文，类型是按 URL 现算的），所以由调用方给 `kindOf`。
 * 这样同一个函数能服务结果列表和文档列表，不必写两份。
 */
export function filterByKind<T>(
  items: readonly T[],
  filter: KindFilter,
  kindOf: (item: T) => string,
): T[] {
  if (filter === "all") return [...items];
  const wantVideo = filter === "video";
  return items.filter((it) => (kindOf(it) === "video") === wantVideo);
}
