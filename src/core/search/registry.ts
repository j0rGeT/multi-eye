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
import { RssProvider } from "./rss";

export interface TopicTarget {
  /** 这个源由哪个站点开关控制。 */
  site: SiteKey;
  provider: SearchProvider;
  limit: number;
  ok: boolean;
}

/** 主题源清单。顺序即装配顺序。 */
function allTopicTargets(): { site: SiteKey; provider: SearchProvider; limit: number }[] {
  return [
    { site: "hackernews", provider: new HackerNewsProvider(), limit: 15 },
    // GitHub 的 limit 给得小：每多要一条不会多花请求（per_page 是一次性的），
    // 但结果太多会把长尾练手仓库混进来，10 条足够覆盖一个主题的主流项目
    { site: "github", provider: new GitHubProvider(), limit: 10 },
    { site: "arxiv", provider: new ArxivProvider(), limit: 10 },
    /*
      RSS 给的条数比别的高：它的「命中」本来就是用户自己订阅的内容，
      信噪比比搜索引擎高得多，多给几条不至于把噪音带进来。
    */
    { site: "rss", provider: new RssProvider(), limit: 20 },
  ];
}

/**
 * 装配主题源，`ok` 由调用方给的一份「可用 id 集合」决定。
 *
 * 适合调用方已经知道结果、或想手动控制开关的场景（测试、健康检查）。
 * 正常搜索路径请用 `probeTopicProviders()`。
 */
export function buildTopicProviders(available: Set<string>): TopicTarget[] {
  return allTopicTargets().map((t) => ({
    ...t,
    ok: available.has(t.provider.id),
  }));
}

/**
 * 逐个探测主题源的可用性。
 *
 * ── 为什么不直接用 `buildTopicProviders(写死的集合)` ──
 *
 * 之前这里是 `new Set(["hackernews", "github", "arxiv"])` 这样的常量。
 * 那三个源的 `available()` 恰好恒为 true，所以看着没问题 —— 但 RSS 不是：
 * 它的可用性取决于 `config/feeds.json` 里有没有启用的订阅，是一个**会变的
 * 外部事实**。写死等于假设「订阅表永远非空」，用户把订阅全停用之后，
 * 这个源还会被拉起来空跑一轮。
 *
 * 探测本身很便宜：四个实现里没有一个发网络请求（RSS 只是读一个本地文件），
 * 所以并发探一遍的代价可以忽略。
 */
export async function probeTopicProviders(): Promise<TopicTarget[]> {
  const all = allTopicTargets();
  const oks = await Promise.all(
    all.map(async (t) => {
      try {
        return await t.provider.available();
      } catch {
        // 探测自己抛错不能让整次搜索挂掉 —— 视作不可用即可
        return false;
      }
    }),
  );
  return all.map((t, i) => ({ ...t, ok: oks[i] }));
}
