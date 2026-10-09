/**
 * 已知的站点级限制 —— 「这个抓不到，不是坏了」。
 *
 * ── 为什么要有这个文件 ──
 *
 * 全部会话统计下来，493 篇文档里 302 篇带 error，而其中一大半**根本不是缺陷**：
 * 知乎 109 篇全是 HTTP 403（未登录游客被拦），这是一条写死的平台策略，不是 bug。
 * 但用户在界面上看到的是和「网络超时」一模一样的一句「HTTP 403」，于是他会去
 * 查代理、重启 SearXNG、翻日志 —— 查一个不存在的问题。
 *
 * 所以这里做的事是**把错误翻译成结论**：命中时给出一句说明「为什么」和
 * 「这是不是故障」的话，把它写进 `doc.error`。于是同一份数据在界面上读起来是
 * 「已知限制」而不是「故障」。
 *
 * ── 这个文件是叶子模块 ──
 *
 * 零值导入（只有 `import type`，会被类型擦除）。理由和 `kind.ts` / `relevance.ts`
 * 一样：`examples/e2e.mjs` 要直接引它做回归。这类「翻译规则」是最容易在重构里
 * 被改坏、又最难靠肉眼发现的东西。
 *
 * ── 名单短是刻意的 ──
 *
 * 每一条都必须有实测依据（见下）。**不要凭「这个站大概会反爬」往里加** ——
 * 每编一条，就可能把一个真实故障解释成「已知限制」，那比不解释更糟：
 * 用户会照着这句话放弃排查。
 */

import type { SiteKey } from "@/core/types";

/**
 * `knownLimitation` 翻译过的错误都以此开头。
 *
 * 下游（`未收录.md` 的分组）靠它把「已知限制」和「普通失败」分开 —— 判据是
 * 我们自己写下的这串前缀，而不是再去跑一遍正则：文档里的 `error` 已经是
 * 翻译后的成品，重新匹配原始特征串既绕又容易和翻译规则脱节。
 */
export const LIMITATION_PREFIX = "已知限制（不是故障）";

/** 这条错误是不是已翻译过的站点限制。用于分组，不用于判定要不要抓。 */
export function isKnownLimitation(error: string | undefined): boolean {
  return error?.startsWith(LIMITATION_PREFIX) ?? false;
}

/**
 * 各站点**平台侧**的限制说明。
 *
 * 与具体某一次失败无关，是这个站点的固有属性 —— 报告里的「站点抓取局限」
 * 一节直接用它。所以只要该站点在这次调研里出了结果，就该把对应的一行写出来，
 * 哪怕这次全抓到了：用户下次换一批链接就会撞上，先把话说在前头。
 */
export const SITE_LIMITATION_NOTES: Record<string, string> = {
  zhihu:
    "知乎对未登录的游客访问一律返回 403，正文需要 `zh-zse-ck` 之类的签名。" +
    "本项目不逆向签名、不碰登录态（合规红线），所以知乎的正文只能拿到搜索摘要。",
  xiaohongshu: "内容主要在小程序 / App 内，网页端对未登录访问长期是风控页。",
  x: "站内内容不被搜索引擎索引，且未登录读不到正文。",
  bilibili: "未登录时部分接口返回 412 风控页；公开元数据接口（视频 / 专栏 / 图文）不受影响。",
  youtube: "观看页 HTML 里没有正文，只有字幕可用；出口 IP 被判定为机器人时会拿不到字幕。",
};

/**
 * 把错误文案翻译成「已知限制」说明。
 *
 * 返回 `null` 表示**这不是已知限制**，就是一次普通的失败 —— 调用方必须保留
 * 原始错误，别把它盖掉。`extract.ts` 的 `fallbackDocument` 就是这么用的。
 *
 * 匹配用的是错误文案里的特征串（`HTTP 403`、`Sign in to confirm` 之类），
 * 因为抓取层各条路径产出的错误本来就只是一句话。判据写得很窄：**站点 + 特征**
 * 同时命中才算，避免把「B站接口 500」这种真故障也说成平台限制。
 *
 * 返回值是**完整替换**，所以每一句都能独立读通 —— 前缀带上原始错误码，
 * 用户仍然看得见到底发生了什么。
 */
export function knownLimitation(site: SiteKey | string, error: string): string | null {
  const e = error ?? "";

  // 知乎：实测 109/109 全是 403，无一例外。
  if (site === "zhihu" && /HTTP 40[13]|风控|反爬/.test(e)) {
    return `已知限制（不是故障）：HTTP 403 —— ${SITE_LIMITATION_NOTES.zhihu}`;
  }

  // 小红书 / X：风控页与 403 都是平台策略，不是抓取参数没调对。
  if ((site === "xiaohongshu" || site === "x") && /HTTP 40[13]|HTTP 412|风控/.test(e)) {
    return `已知限制（不是故障）：${SITE_LIMITATION_NOTES[site]}`;
  }

  // B站 412 是它自己的风控页（不是 403）。碰到就别重试 —— 重试只会让它更
  // 认定我们是异常流量。注意公开接口本身不需要登录，所以这只影响少数页面。
  if (site === "bilibili" && /HTTP 412|风控/.test(e)) {
    return `已知限制（不是故障）：HTTP 412 —— ${SITE_LIMITATION_NOTES.bilibili}`;
  }

  /*
    YouTube 的机器人墙。

    P13.1 已经用 `--extractor-args youtube:player_client=android` 换了个公开
    播放器端点绕过它，之后的 e2e 里这类失败归零。这条留着是因为**代理出口 IP
    被重点标记时仍会撞上** —— 那不是代码问题，说清楚比让用户去翻 yt-dlp 有用。

    这一句把原始错误（英文的 yt-dlp 输出）截一段附在后面：它的措辞比我们的
    概括更能说明问题，也方便用户拿去搜。
  */
  if (site === "youtube" && /Sign in to confirm|not a bot|confirm you're not a bot/i.test(e)) {
    return (
      "已知限制（不是故障）：YouTube 把本机出口 IP 判成了机器人。" +
      "本项目已改用公开播放器端点绕过（不带 cookie、不登录），仍失败说明这个出口 IP " +
      "被重点标记 —— 换出口比改代码有用。" +
      `（原始错误：${e.slice(0, 80)}）`
    );
  }

  return null;
}
