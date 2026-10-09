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

/**
 * 这篇资料够不够格进下载包。
 *
 * **不另立判据，就是 `full`** —— 用户对「优质」的定义（正文 ≥300 字且无
 * 抓取错误）逐字对应 `bodyGrade` 的 `full` 分支。重写一遍条件只会让界面
 * 上的徽章和包里的内容在某个边界上悄悄对不上。
 *
 * 服务端（打包路由）与客户端（下载面板计数）都调这一个函数，所以
 * 「界面说 16 篇优质」和「包里 16 个正文文件」是**同一个判断**得出的。
 */
export function isPackageWorthy(doc: Document): boolean {
  // 相关性只在**判死**时作数。`uncertain` 与「未判定」（旧会话没有这个字段）
  // 一律放行 —— 把「没测过」读成「测出来是坏的」是最容易犯、也最难发现的一类错。
  return bodyGrade(doc) === "full" && doc.relevance?.verdict !== "unlikely";
}

/**
 * 没进包的那些，各自是因为什么。
 *
 * 打包页和包内清单都要逐条列出来 —— 用户选的是「保留并标注，但不进包」，
 * 那么包本身就得讲清楚少了什么、为什么少。这是「绝不静默丢东西」在打包
 * 这一层的落地。
 */
export function whyNotPackaged(doc: Document): string {
  if (doc.error) return doc.error;
  /*
    相关性排在「正文有问题」前面。

    顺序是有讲究的：「这篇正文很完整，只是不像你要找的东西」和「这篇只有
    摘要」是两件完全不同的事，前者是**判定结果**、后者是**抓取缺陷**。
    把判定结果排在前面，用户才不会去琢磨「是不是抓取坏了」。
  */
  if (doc.relevance?.verdict === "unlikely") {
    return `疑似与主题不相关：${doc.relevance.reason}`;
  }
  if (doc.extractMethod === "raw") return "没有抓到正文，正文是搜索摘要";
  const chars = doc.text.trim().length;
  if (chars >= THIN_BODY_CHARS) return `正文偏短（${chars} 字，需 ≥${FULL_BODY_CHARS} 字）`;
  return `正文几乎为空（${chars} 字）`;
}

export interface QualitySummary {
  total: number;
  /** 各分级下的篇数。 */
  counts: Record<BodyGrade, number>;
  /** 有正文（full + thin）的比例。 */
  bodyRatio: number;
  /**
   * 够格进下载包的篇数 —— 也就是 `isPackageWorthy` 为真的条数。
   *
   * **必须由 `isPackageWorthy` 数出来**，不能另写一遍条件。P11 立下的不变量是
   * 「`X-Package-Included` 头 == 包内正文文件数 == 界面上说的优质篇数」，
   * 而三者相等的唯一保证就是它们调同一个函数。
   */
  packable: number;
  /**
   * 正文够格、但**因为疑似不相关**被挡在包外的篇数。
   *
   * 单独计是为了让界面能说清「有几篇是好文章，只是不像你要找的」——
   * 只说「N 篇没进包」会让用户去怀疑抓取，而这几篇的正文其实好好的。
   */
  excludedIrrelevant: number;
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
    packable: docs.filter(isPackageWorthy).length,
    excludedIrrelevant: docs.filter(
      (d) => bodyGrade(d) === "full" && d.relevance?.verdict === "unlikely",
    ).length,
  };
}
