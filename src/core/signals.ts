/**
 * 客观指标的格式化与比较。
 *
 * 服务端（报告的附录表格）与客户端（结果卡片）都要用，所以这里只放纯函数，
 * 不 import 任何 node 内置模块。
 */

import type { ResultSignal } from "./types";

/**
 * 数值 → 紧凑写法。「12345」在结果卡片里占太宽，且第 4 位有效数字没有意义。
 *
 * 中文站用「万」而不是「k」：B 站播放量显示成「12.3k」很怪，
 * 而 GitHub 的 star 数显示成「1.2万」同样怪。所以按量级分档，
 * 小数目原样显示 —— 「847 star」比「0.8k star」有用。
 */
export function formatCount(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1000) return String(n);
  if (abs < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (abs < 100_000_000) return `${(n / 10_000).toFixed(1).replace(/\.0$/, "")}万`;
  return `${(n / 100_000_000).toFixed(1).replace(/\.0$/, "")}亿`;
}

/** 秒 → `m:ss` / `h:mm:ss`。 */
export function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const p = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}

export function formatSignalValue(s: ResultSignal): string {
  if (s.format === "duration") return formatDuration(s.value);
  if (s.format === "count") return formatCount(s.value);
  return String(s.value);
}

/**
 * 拼成一行 `播放 12.3万 · 评论 456`。
 *
 * 按数值量级降序取前 `max` 个：源给 6 个指标时全铺出来会把结果卡片撑爆，
 * 而量级最大的那个通常正是最有信息量的那个（播放量之于视频，star 之于仓库）。
 */
export function signalSummary(signals: ResultSignal[] | undefined, max = 3): string {
  if (!signals || signals.length === 0) return "";
  return [...signals]
    .sort((a, b) => b.value - a.value)
    .slice(0, max)
    .map((s) => `${s.label} ${formatSignalValue(s)}`)
    .join(" · ");
}

/**
 * 把一组指标压成一个可比较的标量，**仅供排序**，不对外展示。
 *
 * 取对数再相加，理由有两个：
 *  1. 不取对数的话，一个 100 万播放的视频会彻底盖掉「3 条评论 + 12 次转发」
 *     这类小站指标，而后者在冷门话题里可能更有信息量；
 *  2. 不同源给的指标数量不同，取对数后单个巨大值不会压过多个中等值。
 *
 * 拿它当「质量分」展示是错的 —— 它只回答「这条的公开声量有多大」，
 * 不回答「这条对不对」。所以它只喂给 `rankResults` 的 `quality` 模式。
 */
export function signalMagnitude(signals: ResultSignal[] | undefined): number {
  if (!signals || signals.length === 0) return 0;
  return signals.reduce((sum, s) => sum + Math.log10(1 + Math.max(0, s.value)), 0);
}

/**
 * provider 侧构造 signals 用的小工具：丢掉缺失值和非法值，全丢光就返回
 * `undefined` 而不是空数组。
 *
 * 「全丢光返回 undefined」是有意的 —— 空数组会被 `JSON.stringify` 一路带到
 * 前端并渲染成一个空的指标行，而 `undefined` 会让整行干脆不出现。
 */
export function compactSignals(
  items: { label: string; value: number | undefined | null; format?: ResultSignal["format"] }[],
): ResultSignal[] | undefined {
  const out = items
    .filter((s): s is { label: string; value: number; format?: ResultSignal["format"] } =>
      typeof s.value === "number" && Number.isFinite(s.value),
    )
    .map((s) => ({ label: s.label, value: s.value, format: s.format }));
  return out.length > 0 ? out : undefined;
}
