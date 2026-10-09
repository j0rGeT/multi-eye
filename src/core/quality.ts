/**
 * 数据质量的**可测量**维度。
 *
 * 这里刻意只做一件事：衡量「我们到底拿到了多少正文」。这是整套系统里唯一
 * 100% 可测的质量信号 —— 因为它量的是**我们自己的证据量**，不是「这篇文章好不好」。
 *
 * 不做什么，以及为什么：
 *
 * - **不做可信度评分**。一篇被广泛转载的假消息和一篇真报道，在这个系统的视野里
 *   长得一模一样 —— 它只抓公开页面，不做事实核查。任何 0~100 的「可信度」
 *   都是伪精度。
 * - **不用语言模型打「质量分」**。同一篇文章两次调用会得到不同的分数，
 *   而且分数高低取决于提示词怎么写，不取决于文章本身。
 * - **不按「网站权威性」加权**。知乎的高赞回答和知乎的营销软文域名相同，
 *   域名级加权区分不了它们，只会给前者加一层不该有的光环。
 *
 * 声量（star/播放/评论）是另一条线，放在 `signals.ts`，且同样只展示、不合成。
 */

import type { Document } from "./types";

/**
 * 正文分级。
 *
 * `snippet` 不只是「质量差」，它的性质完全不同：正文其实是**搜索摘要**，
 * 拿它进语料会让拓扑变成一张按标题匹配的假图（项目里 `heuristic.ts` 的
 * 文档权重就是按正文长度算的，摘要长度全在同一个量级，权重也就全拉平了）。
 * 所以这个分级不只是展示用的标签，也是「这批语料够不够构图」的依据。
 */
export type BodyGrade =
  /** 拿到了完整正文。 */
  | "full"
  /** 拿到了正文，但很短。可能是短视频/短贴，也可能是抓成了导航栏 —— 需要人看一眼。 */
  | "thin"
  /** 没有正文，只有搜索摘要。 */
  | "snippet";

/**
 * 正文长度的分档阈值。
 *
 * 300 字大约是「一段像样的论述」的下限；120 字以下基本不可能是文章主体。
 * 这两个数是拍的，但**方向是保守的**：宁可把一篇短内容标成 `thin`
 * 让用户自己扫一眼，也不要把一堆导航垃圾算作 `full` 悄悄进语料。
 */
export const FULL_BODY_CHARS = 300;
export const THIN_BODY_CHARS = 120;

/**
 * 给一篇文档的正文分级。
 *
 * 注意 `error` 与 `extractMethod === "raw"` 都会被判成 `snippet`：这两种情况
 * 下 `Document.text` 里装的是搜索摘要（见 `fallbackDocument`），不是正文。
 * 靠 wordCount 是判不出来的 —— 一段长摘要同样能超过 300 字。
 */
export function bodyGrade(doc: Document): BodyGrade {
  if (doc.error || doc.extractMethod === "raw") return "snippet";

  // `markdown` 为空说明只拿到了纯文本，但 text 仍是真正文，不影响分级
  const chars = doc.text.trim().length;
  if (chars >= FULL_BODY_CHARS) return "full";
  if (chars >= THIN_BODY_CHARS) return "thin";
  return "snippet";
}

export const BODY_GRADE_LABELS: Record<BodyGrade, string> = {
  full: "正文完整",
  thin: "正文很短",
  snippet: "仅摘要",
};

export interface QualitySummary {
  total: number;
  /** 各分级下的篇数。 */
  counts: Record<BodyGrade, number>;
  /** 有正文（full + thin）的比例。 */
  bodyRatio: number;
}

/** 一批文档的正文可用性概览。报告与 UI 的进度提示都用它。 */
export function qualitySummary(docs: readonly Document[]): QualitySummary {
  const counts: Record<BodyGrade, number> = { full: 0, thin: 0, snippet: 0 };
  for (const d of docs) counts[bodyGrade(d)] += 1;

  const total = docs.length;
  return {
    total,
    counts,
    bodyRatio: total === 0 ? 0 : (counts.full + counts.thin) / total,
  };
}
