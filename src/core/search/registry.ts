/**
 * 「主题源」provider 的装配。
 *
 * ── 什么是主题源 ──
 *
 * 现有两类 provider 都是**按站点**工作的：`searxng`/`serper` 拿 `site:` 或
 * 域名过滤去查某个站，`ytdlp`/`bilibili` 是某两个站点的专用通道。二者都被
 * 放在「每个勾选站点跑一遍」的循环里。
 *
 * 但 HN / GitHub / arXiv 这类源不是这样工作的：它们**一个接口覆盖全站**，
 * 根本没有「按站点定向」这个概念。塞进那个循环会有两个后果：
 *
 *   1. 勾 N 个站点就发 N 次请求。GitHub 未认证只有 10 次/分钟（按 IP），
 *      勾六七个站点一轮就打光，后面全是 429
 *   2. `orchestrate.ts` 的 `ENOUGH_RESULTS` 提前跳出会让它们**根本轮不到**
 *      —— 先跑的站点已经攒够结果了
 *
 * 所以单开一条 `topic` 路径：整次搜索**只调用一次**，与站点任务并发。
 *
 * ── 为什么和 siteProviders 分开写 ──
 *
 * 形状（`{provider, limit, ok}`）刻意对齐 `siteProviders`，但入口条件不同：
 * 站点 provider 看「站点是否被勾选」，主题源看自己的 `SiteKey` 是否被勾选。
 * 把两者合并成一个数组只会让调用点去猜该用哪个条件。
 */

import type { SearchProvider, SiteKey } from "@/core/types";
import { HackerNewsProvider } from "./hackernews";
import { GitHubProvider } from "./github";
import { ArxivProvider } from "./arxiv";

export interface TopicTarget {
  /** 这个源由哪个站点开关控制。 */
  site: SiteKey;
  provider: SearchProvider;
  limit: number;
  ok: boolean;
}

/**
 * 装配主题源。
 *
 * `ok` 由调用方传入的 `available` 结果决定，而不是在这里 await ——
 * 装配函数保持同步、纯函数式，探测是调用方的事（那边才有并发探测的能力）。
 */
export function buildTopicProviders(available: Set<string>): TopicTarget[] {
  const all: { site: SiteKey; provider: SearchProvider; limit: number }[] = [
    { site: "hackernews", provider: new HackerNewsProvider(), limit: 15 },
    // GitHub 的 limit 给得小：每多要一条不会多花请求（per_page 是一次性的），
    // 但结果太多会把长尾练手仓库混进来，10 条足够覆盖一个主题的主流项目
    { site: "github", provider: new GitHubProvider(), limit: 10 },
    { site: "arxiv", provider: new ArxivProvider(), limit: 10 },
  ];

  return all.map((t) => ({ ...t, ok: available.has(t.provider.id) }));
}
