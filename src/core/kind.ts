/**
 * 「这篇资料是视频还是图文」的**唯一判据**。
 *
 * 叶子模块：只引 `@/core/types` 且是 `import type`（会被完全擦除），所以
 * `node script.mjs` 能直接引它做回归 —— 与 `search/relevance.ts` 同一套路。
 *
 * ── 为什么要有这个文件 ──
 *
 * 原先这个判断长在 `fetch/extract.ts` 的 `buildDoc` 里，写的是
 * `r.site === "youtube" || r.site === "bilibili" ? "video" : "article"` ——
 * **按站点判，不按内容判**。于是 B 站的专栏（`/read/`）和图文（`/opus/`）
 * 一律被标成 video，而我们自己实测过 `/opus/` 抓到的是**真正文**。
 *
 * 这个错标不是显示问题，它会往下游传：
 *
 *   - `download/kinds.ts` 给 `kind === "video"` 排「字幕」任务 → 给一篇
 *     没有字幕的专栏文章排一个永远失败的下载任务
 *   - 同一个地方给 `kind === "video"` 排「媒体」任务 → 去下一篇文章的「视频」
 *   - `export/zip.ts` 把它放进 `字幕/` 目录
 *
 * 三处都是「因为一个字段错了，去做一件根本不存在的事」。所以在**源头**
 * 按 URL 的路径判，而不是按站点判。
 *
 * ── 为什么不落库 ──
 *
 * 它是 site + url 的纯函数，没有 I/O、没有配置、不会随时间变化。落库只会
 * 制造一份可能过期的副本：判据一改，老会话里存的还是旧结论。需要处现算
 * 即可，成本是一次正则。
 */

import type { DocKind, SiteKey } from "@/core/types";

/**
 * B 站 URL 路径 → 内容类型。
 *
 * 全部实测过（抓取链对这几类路径有不同处理）：
 *
 *   /video/BV…        视频页（有播放器、有字幕或至少简介）
 *   /bangumi/play/…   番剧，也是视频
 *   /read/…           专栏，**真正文**
 *   /opus/…           图文动态，**真正文**（实测抓到完整正文）
 *   /article/…        旧版专栏路径，仍在用
 *
 * 拿不准的一律 `unknown`，**不猜**：
 *
 *   space.bilibili.com   个人空间，抓到的是列表不是正文
 *   live.bilibili.com    直播间，没有可归档的正文
 *   /list/…              播放列表，同空间
 *
 * `unknown` 的下游按「非视频」处理（不发字幕/媒体任务），但界面会照实
 * 显示「未知」而不是硬塞进「文章」里 —— 显示成文章会让用户以为抓错了。
 */
function bilibiliKind(url: string): DocKind {
  let path: string;
  let host: string;
  try {
    const u = new URL(url);
    path = u.pathname;
    host = u.hostname;
  } catch {
    // 相对 URL 或畸形 URL：拿不准就 unknown
    return "unknown";
  }

  if (host.startsWith("space.") || host.startsWith("live.")) return "unknown";
  // /list/ 与 /medialist/play/ 都是播放列表，一页里没有「这一篇内容」
  if (/\/list\//.test(path) || /\/medialist\//.test(path)) return "unknown";

  if (/\/(video|bangumi\/play)\//.test(path)) return "video";
  if (/\/(read|opus|article)\//.test(path)) return "article";

  // 主页、搜索页、活动页… 都不是「一篇内容」
  return "unknown";
}

/**
 * 判定一篇资料是视频还是图文。
 *
 * `site` 用 `SearchResult.site` / `Document.site`（已经是**按 URL 反查**过的
 * 真实站点归属，不是请求时指定的那个），所以这里不必再解析域名。
 *
 * 默认落到 `article` 而不是 `unknown`：绝大多数站点抓到的就是网页正文，
 * 把它们一律标成「未知」等于让这个字段失去信息量。
 */
export function contentKind(site: SiteKey | string, url: string): DocKind {
  switch (site) {
    case "youtube":
      // YouTube 只有视频。频道页/播放列表也当视频处理 —— 抓到的是它的简介
      return "video";
    case "bilibili":
      return bilibiliKind(url);
    case "zhihu":
    case "xiaohongshu":
    case "x":
      /*
        社交平台上的长文（知乎回答、小红书笔记）性质上是图文，但**来源**
        是社交平台，这个区别对用户有用：同一个话题下，知乎回答和一篇博客
        的证据强度不同。所以单独一档，而不是并进 article。

        它在下游按非视频处理，不会招来字幕/媒体任务。
      */
      return "social";
    default:
      return "article";
  }
}

/**
 * 给一篇已落库的资料判类型 —— **从 site + url 现算，不读它存下来的 `kind`**。
 *
 * ── 为什么不用存下来的那个字段 ──
 *
 * `Document.kind` 是抓取那一刻写进 session.json 的快照。判据一改（就像这次：
 * 从「按站点」改成「按 URL 路径」），磁盘上所有老会话里的值就都是错的，
 * 而且**不会自己变对**。读它等于把「判据修正」这件事只对今后的数据生效。
 *
 * 具体到这次：B 站 `/read/` 专栏在旧会话里存的是 `video`，如果读取端还认
 * 那个字段，这些老会话照样会去给一篇没有播放器的文章排字幕下载任务、
 * 并把它放进包里的 `视频/` 目录 —— 改了等于没改。
 *
 * 现算的成本是一次正则，而它的正确性不依赖任何历史状态。存下来的 `kind`
 * 字段仍然保留：它是**显示用的快照**，也让没被迁移的旧客户端读起来有个值。
 * 但凡是要**据此做决定**的地方，都走这个函数。
 */
export function docKind(doc: { site: string; url: string }): DocKind {
  return contentKind(doc.site, doc.url);
}

/**
 * 各类型的中文名。界面、报告、包内清单共用一份，避免三处各写各的。
 */
export const DOC_KIND_LABELS: Record<DocKind, string> = {
  article: "图文",
  video: "视频",
  social: "社交长文",
  unknown: "未知",
};

/**
 * 这个类型在下载包里放哪个目录。
 *
 * 用户明确要求的是「视频站和文章站分开」，所以只有两个目录；`social` 与
 * `unknown` 都归到文章侧 —— 它们的正文是文本，进 `视频/` 才是错的。
 * 目录名与类型名分开写，是因为目录一旦改名就是**破坏性变更**（用户可能
 * 已经有脚本在读它），而类型名只是我们内部的标签。
 */
export function packageDirFor(kind: DocKind): "文章" | "视频" {
  return kind === "video" ? "视频" : "文章";
}
