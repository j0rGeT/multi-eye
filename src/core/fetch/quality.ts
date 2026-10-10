/**
 * 抓取前的质量闸门。
 *
 * 搜索结果里天然混着导航页、登录页、验证码页、空标题和只有几个字的摘要。
 * 这些链接一旦进入抓取链，会白白消耗超时与浏览器配额，最后又只会得到一条
 * `snippet`。闸门只处理**可以客观判定的无用候选**，不给内容打可信度分。
 *
 * 过滤后仍保留一条退路：如果高质量候选太少，按质量顺序补回低质候选，
 * 保证一批抓取不会因为过滤规则过严而变成空跑。
 */

import type { SearchResult } from "@/core/types";
import { contentKind } from "@/core/kind";

export type FetchQualityTier = "high" | "usable" | "low" | "reject";

export interface FetchQualityDecision {
  tier: FetchQualityTier;
  reasons: string[];
}

export interface FetchQualityFilterResult {
  targets: SearchResult[];
  /** 因质量闸门被排除的条数。 */
  skippedLowQuality: number;
  /** 为避免全量过滤而补回的低质候选数。 */
  retainedLowQuality: number;
  decisions: Map<string, FetchQualityDecision>;
}

const NON_CONTENT_PATH =
  /\/(?:search|signin|signup|login|register|captcha|verify|tag|tags|topic|category|archive|404)(?:\/|$)/i;

const JUNK_TITLE =
  /^(?:首页|登录|注册|验证码|安全验证|访问异常|页面不存在|404|更多|下载|广告|推广)$/;

const JUNK_SNIPPET =
  /(?:请开启\s*javascript|验证码|安全验证|访问异常|访问被拒绝|登录后查看|页面不存在|not found)/i;

/**
 * 给一条搜索结果做抓取前分级。
 *
 * `reject` 只包含“打开也没有正文”的硬证据；`low` 代表信息量偏少但可能
 * 仍是一篇短文，交给补回逻辑决定要不要抓，不直接判死。
 */
export function assessSearchCandidate(result: SearchResult): FetchQualityDecision {
  const reasons: string[] = [];
  const title = result.title.trim();
  const snippet = result.snippet.trim();

  let parsed: URL | null = null;
  try {
    parsed = new URL(result.url);
  } catch {
    return { tier: "reject", reasons: ["URL 无法解析"] };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { tier: "reject", reasons: ["只允许抓取 http/https 页面"] };
  }
  if (NON_CONTENT_PATH.test(parsed.pathname)) {
    return { tier: "reject", reasons: ["页面路径是站内导航/登录/标签页"] };
  }
  if (!title && !snippet) {
    return { tier: "reject", reasons: ["标题与摘要都为空"] };
  }
  if (JUNK_TITLE.test(title) || JUNK_SNIPPET.test(snippet)) {
    return { tier: "reject", reasons: ["命中验证码、登录或空页面提示"] };
  }

  // 社交平台的短贴是合法内容，不能按文章长度一刀切。
  const kind = contentKind(result.site, result.url);
  const isShortForm = kind === "social" || kind === "video";
  if (!isShortForm && title.length < 4 && snippet.length < 30) {
    reasons.push("标题与摘要都过短");
  }
  if (snippet.length < 60) reasons.push("搜索摘要信息量偏少");
  if (/^(?:点击|看这里|震惊|速看|干货合集|全网最全)/.test(title)) {
    reasons.push("标题疑似引流内容");
  }

  if (reasons.length > 0) return { tier: "low", reasons };
  if (title.length >= 8 && snippet.length >= 80) {
    return { tier: "high", reasons: [] };
  }
  return { tier: "usable", reasons: [] };
}

/**
 * 从一批候选里挑出本轮真正要抓的链接。
 *
 * 默认先只抓 `high`/`usable`，再按原始排名补回 `low`，直到达到
 * `minTargets`。显式勾选的结果由调用方绕过本函数，用户的意图优先。
 */
export function filterFetchCandidates(
  results: readonly SearchResult[],
  opts: { minTargets?: number } = {},
): FetchQualityFilterResult {
  const minTargets = Math.max(0, opts.minTargets ?? 8);
  const decisions = new Map<string, FetchQualityDecision>();
  const accepted: SearchResult[] = [];
  const low: SearchResult[] = [];
  const rejected: SearchResult[] = [];

  for (const result of results) {
    const decision = assessSearchCandidate(result);
    decisions.set(result.id, decision);
    if (decision.tier === "reject") rejected.push(result);
    else if (decision.tier === "low") low.push(result);
    else accepted.push(result);
  }

  let retainedLowQuality = Math.max(0, minTargets - accepted.length);
  let targets = [
    ...accepted,
    ...low.slice(0, Math.min(retainedLowQuality, low.length)),
  ];
  // 规则过严导致“一条都不剩”时，按原排名补回一小批候选。
  // 这不是把垃圾当优质，而是给用户一个可观察的失败样本，避免整轮静默空跑。
  if (targets.length === 0 && results.length > 0) {
    targets = results.slice(0, Math.min(minTargets || 1, results.length));
    retainedLowQuality = targets.length;
  }
  const skippedLowQuality = results.length - targets.length;

  return { targets, skippedLowQuality, retainedLowQuality, decisions };
}

/**
 * 抓完之后的正文可用性判断。
 *
 * 这里只复用 `quality.ts` 已有的正文分级，不另造一个“内容质量分”：
 * 质量闸门负责挡住明显无用的链接，正文分级负责判断我们到底拿到了多少证据。
 */
export function isUsefulDocument(doc: {
  error?: string;
  extractMethod: string;
  wordCount: number;
}): boolean {
  return !doc.error && doc.extractMethod !== "raw" && doc.wordCount >= 30;
}
