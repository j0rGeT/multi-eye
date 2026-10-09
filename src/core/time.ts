/**
 * 时效展示的纯函数。
 *
 * 服务端（报告、健康检查）和客户端（搜索结果、节点详情）共用同一份 ——
 * 两边各写一套「3 天前」的算法，迟早会出现报告里写「3 天前」而界面写
 * 「2 天前」这种对不上的情况，而那种不一致根本没法排查。
 *
 * 全部是纯函数、零依赖，所以可以直接在 client component 里 import。
 *
 * ── 一条贯穿全项目的硬规则 ──
 *
 * **`publishedAt` 缺失时，任何地方都不显示时间。**
 *
 * 尤其不能拿 `fetchedAt` 冒充「发布时间」：抓取时间是「我们什么时候去看的」，
 * 发布时间是「这篇文章什么时候写的」，两者是完全不同的事实。把前者当后者
 * 显示，用户会以为一篇 2019 年的文章是今天发布的 —— 这是这套系统里最容易
 * 犯、后果也最严重的一种错误陈述。`fetchedAt` 有自己的展示位（标「抓取于」），
 * 但绝不出现在发布时间的语义位置上。
 */

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * 相对时间：把 ISO 串说成「3 天前」。
 *
 * 只应在 `publishedAt` 存在时调用 —— 传 undefined 会返回空串，这是刻意的：
 * 与其让调用方拿到「刚刚」然后误以为有日期，不如拿到空串什么都显示不出来。
 */
export function relativeTime(
  iso: string | undefined,
  now: number = Date.now(),
): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";

  const diff = now - t;
  // 未来时间不该出现在这里（normalizeToIso 已挡掉远期），但时钟偏差可能
  // 留下几分钟的余量。按「刚刚」处理比显示「-3 天前」体面。
  if (diff < MINUTE) return "刚刚";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`;
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)} 天前`;
  if (diff < 365 * DAY) return `${Math.floor(diff / (30 * DAY))} 个月前`;
  return `${Math.floor(diff / (365 * DAY))} 年前`;
}

/** 绝对日期：`2026-08-12`。按本机时区取年月日 —— 用户看到的应该是自己日历上的那天。 */
export function formatDate(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** `2026-08-12 14:30`。用在报告与下载的元信息里，精度到分钟。 */
export function formatDateTime(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}`
  );
}

export interface DateCoverage {
  /** 有发布日期的条数。 */
  known: number;
  total: number;
  /** known / total，total 为 0 时是 0 而不是 NaN。 */
  ratio: number;
}

/**
 * 统计一批条目的日期覆盖率。
 *
 * 这个数字是要**展示给用户看的**，不是内部指标。上游搜索引擎不给日期是
 * 常态（实测纯 SearXNG 会话的覆盖率是 0%），而用户没法从界面上看出来
 * 「为什么这些资料都没写时间」。把比例摊开，用户才知道该不该信任
 * 「最新资料」这个说法。
 */
export function dateCoverage(
  items: readonly { publishedAt?: string }[],
): DateCoverage {
  const total = items.length;
  let known = 0;
  for (const it of items) if (it.publishedAt) known += 1;
  return { known, total, ratio: total === 0 ? 0 : known / total };
}

export interface DateSpan {
  oldest?: string;
  newest?: string;
}

/** 一批日期里的最早与最晚。忽略无法解析的值。 */
export function dateSpan(isoList: readonly (string | undefined)[]): DateSpan {
  let oldestMs = Infinity;
  let newestMs = -Infinity;
  let oldest: string | undefined;
  let newest: string | undefined;

  for (const iso of isoList) {
    if (!iso) continue;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) continue;
    if (t < oldestMs) {
      oldestMs = t;
      oldest = iso;
    }
    if (t > newestMs) {
      newestMs = t;
      newest = iso;
    }
  }

  return { oldest, newest };
}

/** `2024-01 ~ 2026-08`；只有一个端点时退化成单值；一个都没有则空串。 */
export function formatSpan(span: DateSpan): string {
  const a = formatDate(span.oldest).slice(0, 7);
  const b = formatDate(span.newest).slice(0, 7);
  if (!a && !b) return "";
  if (a === b) return a;
  return `${a} ~ ${b}`;
}
