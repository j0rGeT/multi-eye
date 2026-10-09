/**
 * 抓取降级链编排。
 *
 * ── 第一步就是分派：先看这是视频还是图文（`core/kind.ts`）──
 *
 *   视频（contentKind === "video"）：
 *     1. YouTube URL       → yt-dlp 字幕（视频的「正文」就是字幕）
 *     2. B站视频 URL       → 公开接口取标题/标签/简介/字幕（**不走页面**）
 *     3. 上面都不中或失败   → 落到下面的图文链，但视频页多半只能拿到简介
 *
 *   图文（article / social / unknown）：
 *     4. B站专栏/图文 URL  → 同样走公开接口（`/read/`、`/opus/` 是正文，
 *                            不是视频；按站点判会漏掉这一条）
 *     5. HTTP + Readability → 覆盖大部分博客/新闻/专栏
 *     6. JS 空壳判定命中    → 无头浏览器重试
 *
 *   共同兜底：
 *     7. 全部失败           → 退化为搜索摘要（extractMethod: 'raw'）
 *
 * 「视频还是图文」这个分派**必须按 URL 路径判**（见 `core/kind.ts` 里的
 * 实测记录）：B 站的 `/read/` 与 `/opus/` 是长文，按站点判会当成视频，
 * 于是去给一篇没有播放器的文章找字幕。
 *
 * 核心原则：**单篇失败不抛异常，而是产出带 error 的 Document**。
 * 一个主题下有几十篇资料，其中几篇抓不到是常态（知乎不登录、站点下线、
 * 反爬拦截），不该让整批失败。
 */

import type { Document, ExtractMethod, SearchResult } from "@/core/types";
import { config } from "@/core/env";
import { fetchHtml } from "./http";
import { extractWithReadability, looksLikeCode, looksLikeSpa } from "./readability";
import { boilerplateReason } from "./boilerplate";
import { knownLimitation } from "./limitations";
import { contentKind } from "@/core/kind";
import { fetchWithBrowser, isPlaywrightAvailable } from "./playwright";
import { fetchTranscript, isYoutubeUrl } from "./youtube";
import {
  fetchBilibiliVideo,
  isBilibiliNonContentUrl,
  isBilibiliVideoUrl,
} from "./bilibili";
import { limiter } from "@/core/limit";

export interface ExtractOptions {
  signal?: AbortSignal;
  /** 并发上限。默认 4：再高容易触发目标站点的反爬。 */
  concurrency?: number;
  onProgress?: (done: number, total: number, doc: Document) => void;
}

/**
 * 一轮抓取里**共享**的配额。
 *
 * 目前只有一项：无头浏览器还能开几次。放在这里而不是模块级变量，是因为
 * 「一轮」的边界就是一次 `extractMany` —— 用模块级的计数器会让配额跨请求
 * 累积，第二个用户拿到的是一份已经用掉一半的预算，而且永远说不清是谁用掉的。
 *
 * 并发任务之间不需要加锁：JS 单线程，`takePlaywrightSlot` 里从检查到扣减
 * 之间没有 `await`，不存在两篇同时抢到最后一个名额。
 */
export interface ExtractBudget {
  playwrightLeft: number;
}

export async function extractMany(
  results: SearchResult[],
  opts: ExtractOptions = {},
): Promise<Document[]> {
  const concurrency = opts.concurrency ?? 4;
  const gate = limiter("extract", concurrency);
  const budget: ExtractBudget = {
    playwrightLeft: config.playwrightMaxPagesPerRun,
  };

  let done = 0;
  const tasks = results.map((r) =>
    gate(async () => {
      const doc = await extractOne(r, opts.signal, budget);
      done += 1;
      opts.onProgress?.(done, results.length, doc);
      return doc;
    }),
  );

  // 用 allSettled 而不是 all：即使某个任务因为意外抛出，其他文档也要保住
  const settled = await Promise.allSettled(tasks);
  return settled.map((s, i) =>
    s.status === "fulfilled" ? s.value : fallbackDocument(results[i], String(s.reason)),
  );
}

/** 扣一个无头浏览器名额。扣不到返回 false —— 由调用方写进降级原因。 */
function takePlaywrightSlot(budget: ExtractBudget | undefined): boolean {
  if (!budget) return true; // 直接调 extractOne 的单篇场景不设限
  if (budget.playwrightLeft <= 0) return false;
  budget.playwrightLeft -= 1;
  return true;
}

export async function extractOne(
  result: SearchResult,
  signal?: AbortSignal,
  budget?: ExtractBudget,
): Promise<Document> {
  const t0 = Date.now();

  /*
    「这一级为什么没走」的原因。声明在函数作用域而不是四级那个 if 里面，
    是因为下面**两条**降级路径（raw 正文、五级兜底）都要用到它。

    静默地少走一级，用户看到的是「这篇抓得不全」，而真实原因是配额用完了或者
    根本没装 —— 那是两件完全不同的事。
  */
  let browserSkip: string | undefined;

  // ── 一级：YouTube 字幕 ──
  if (isYoutubeUrl(result.url)) {
    const tr = await fetchTranscript(result.url, { signal });
    if (tr.text) {
      return buildDoc(result, {
        method: "ytdlp-subtitle",
        text: tr.text,
        markdown: tr.text,
        title: result.title,
        /*
          搜索层拿不到 YouTube 的发布日期（yt-dlp 搜索用的是 `--flat-playlist`，
          那模式下 upload_date 是 null），所以这里必须把抓取层补到的日期传下去。
          `buildDoc` 自身不会去猜 —— 传 undefined 就是没有。
        */
        publishedAt: tr.publishedAt ?? result.publishedAt,
        startedAt: t0,
      });
    }

    /**
     * 字幕拿不到时**直接兜底，不进 HTTP + Readability**。
     *
     * 这是实测出来的坑：YouTube 观看页的 HTML 里没有正文，只有
     * `var ytInitialPlayerResponse = {...}` 这样的内联 JSON。Readability
     * 会把它当正文抓出来，产出 4~8 万个「字」的 JS 源码垃圾 —— 它既不是
     * 内容，又会以极高权重污染后续的 TF-IDF，比抓不到还糟。
     * 视频的唯一正文本就是字幕，没有字幕就没有正文，退回摘要才是诚实的。
     */
    // 兜底文档也带上日期：没有字幕不代表不知道这个视频什么时候发的，
    // 而「发布日期」正是判断一条资料该不该采信时效性的前提
    return fallbackDocument(result, tr.error ?? "该视频没有可用字幕", t0, {
      publishedAt: tr.publishedAt ?? result.publishedAt,
    });
  }

  // ── 二级：B站视频接口 ──
  if (isBilibiliVideoUrl(result.url)) {
    const bv = await fetchBilibiliVideo(result.url, { signal });

    /**
     * 门槛用 `substantive` 而不是 `text` 非空 —— 语料版正文里还留着 UP 主名字，
     * 空壳视频的 text 因此永远不为空。不卡这一道，「赵老师没灵魂」这七个字
     * 就会被当成一篇资料的正文收进语料。
     */
    if (bv.substantive) {
      return buildDoc(result, {
        method: "bilibili-api",
        text: bv.text,
        markdown: bv.markdown,
        title: bv.title || result.title,
        images: bv.images,
        author: bv.author ?? result.author,
        publishedAt: bv.publishedAt ?? result.publishedAt,
        startedAt: t0,
      });
    }

    /**
     * 接口拿不到就**直接兜底，不进 HTTP + Readability**。
     *
     * 和 YouTube 那条同理，但原因不同：B 站页面抓出来的是侧栏的「接下来播放」
     * 推荐列表（导航 + 别人的视频标题），一千多字里没有一个是这个视频的内容。
     * 抓不到正文时退回搜索摘要，比拿一段别的东西冒充正文诚实得多。
     */
    return fallbackDocument(result, bv.error ?? "B站接口未返回可用内容", t0, {
      publishedAt: bv.publishedAt ?? result.publishedAt,
    });
  }

  /**
   * B 站的其它页面类型：**在发请求之前就拦掉**。
   *
   * 能走到这里说明上面那条 `isBilibiliVideoUrl` 没认出视频 id。但要注意它
   * 已经比以前宽了：`/list/…?bvid=BV…` 这种合集页会**顺着 query 里的 bvid
   * 走上面那条视频接口**去拿真实内容（实测 14 条 /list/ 里 9 条能这么救回来），
   * 不会落到这里。
   *
   * 真正落到这里的是 `/cheese/play/` 这种付费课程落地页、`space.` / `live.`
   * 子域 —— 它们页面上根本不存在「文章正文」，HTML 主体是推荐位和购买入口，
   * Readability 抓得又长又像那么回事（实测一千多字，全是侧栏别人的视频标题）。
   * 它比抓不到更糟：抓不到会退化成摘要并被标注，它却会当成一篇完整资料，
   * 还因为字多拿到不低的权重。详见 `bilibili.ts` 的 `isBilibiliNonContentUrl`。
   *
   * 这里**不退回 Readability 碰运气**，直接给出可解释的失败。
   */
  if (isBilibiliNonContentUrl(result.url)) {
    return fallbackDocument(
      result,
      "该 B 站页面类型没有正文可抓（仅视频页 / 专栏 / 图文有）",
      t0,
    );
  }

  // ── 三级：HTTP + Readability ──
  const res = await fetchHtml(result.url, { signal });

  if (res.ok && res.body) {
    const extraction = extractWithReadability(res.body, res.finalUrl);

    /**
     * 第二道防线：即使剥掉了 script/style，仍可能有站点的内联 JSON 以普通
     * 文本节点存在。这种「正文」一旦入库，TF-IDF 会把 window/var/function
     * 这类词顶成核心概念。宁可让它退化为摘要，也不能污染语义图。
     */
    if (looksLikeCode(extraction.text)) {
      return fallbackDocument(
        result,
        "正文疑似为脚本或内联数据，已丢弃",
        t0,
      );
    }

    /**
     * 第三道防线：抽到的**不是文章**。
     *
     * `looksLikeCode` 防的是「抽到了脚本」，`Extraction.thin` 防的是「没抽到」，
     * 而这里防的是第三种：**抽到了，但抽错了** —— 页面主体确实是一大块文本，
     * 只是那块是导航条 / 推荐位。前两道都判不出来（它不是代码，字数也够多）。
     *
     * 命中时**不走 `fallbackDocument`**：那会把已经抽到的文本换成搜索摘要，
     * 反而丢掉了排查线索。改为保留文本、但明确标成 `raw` + error —— 于是它
     * 自动被 `bodyGrade` 判为 `snippet`，不进拓扑图、不进下载包，而用户和
     * 开发者都还能在会话里看到「到底抽到了什么」。
     */
    const boiler = boilerplateReason(extraction.text);
    if (boiler) {
      return buildDoc(result, {
        method: "raw",
        text: extraction.text,
        markdown: extraction.markdown,
        title: extraction.title || result.title,
        images: extraction.images,
        publishedAt: extraction.publishedAt ?? result.publishedAt,
        lang: extraction.lang,
        startedAt: t0,
        error: boiler,
      });
    }

    if (!extraction.thin) {
      return buildDoc(result, {
        method: "readability",
        text: extraction.text,
        markdown: extraction.markdown,
        title: extraction.title || result.title,
        images: extraction.images,
        author: extraction.byline ?? result.author,
        publishedAt: extraction.publishedAt ?? result.publishedAt,
        lang: extraction.lang,
        truncated: res.truncated,
        startedAt: t0,
      });
    }

    /*
      ── 四级：JS 空壳 → 无头浏览器 ──

      要不要试这一级由 `playwrightMode` 决定（三态见 `env.ts` 的注释）：
      `off` 从不试，`on-demand` 只在 `looksLikeSpa` 判为 JS 空壳时试，
      `always` 每篇都试。

      不试的原因**必须留下来**：下面两条降级路径会把 `browserSkip` 写进 `error`
      （声明在函数顶部，见那里的说明）。
    */
    const wantsBrowser =
      config.playwrightMode === "always" ||
      (config.playwrightMode === "on-demand" &&
        looksLikeSpa(res.body, extraction));

    if (wantsBrowser && (await isPlaywrightAvailable())) {
      if (!takePlaywrightSlot(budget)) {
        browserSkip =
          `疑似动态渲染，本轮无头浏览器配额（${config.playwrightMaxPagesPerRun} 页）已用完` +
          `。调大 PLAYWRIGHT_MAX_PAGES_PER_RUN 或减少一次抓取的篇数。`;
      } else {
        const br = await fetchWithBrowser(result.url, { signal });
        if (br.html) {
          // 站点专用选择器命中时直接用，比再跑一次 Readability 准。
          // 但仍要过一遍代码检测：选择器可能框到了一块内联 JSON。
          if (
            br.selectorText &&
            br.selectorText.length > 200 &&
            !looksLikeCode(br.selectorText)
          ) {
            return buildDoc(result, {
              method: "playwright",
              text: br.selectorText,
              markdown: br.selectorText,
              title: extraction.title || result.title,
              images: extraction.images,
              /*
                别把第一次 HTTP 那趟已经读到的日期丢掉。

                这一支换的是正文来源（静态 HTML → 无头浏览器渲染结果），
                和日期没有关系；`extraction` 是从静态 HTML 解析出来的，
                它的 publishedAt 与这次替换无关，仍然有效。
              */
              publishedAt: extraction.publishedAt ?? result.publishedAt,
              lang: extraction.lang,
              startedAt: t0,
            });
          }
          const re = extractWithReadability(br.html, result.url);
          if (!re.thin) {
            return buildDoc(result, {
              method: "playwright",
              text: re.text,
              markdown: re.markdown,
              title: re.title || result.title,
              images: re.images,
              author: re.byline ?? result.author,
              publishedAt: re.publishedAt ?? result.publishedAt,
              lang: re.lang,
              startedAt: t0,
            });
          }
        }
        // 浏览器跑了但也没抽出东西 —— 也要说清是「跑了没用」而不是「没跑」
        browserSkip = "已用无头浏览器渲染，仍没抽到正文";
      }
    }

    // Readability 拿到了一点东西但不完整 —— 仍比纯摘要强，标 raw 并说明原因
    if (extraction.text.length > 50) {
      return buildDoc(result, {
        method: "raw",
        text: extraction.text,
        markdown: extraction.markdown,
        title: extraction.title || result.title,
        images: extraction.images,
        // 同上：降级的是正文，不是日期
        publishedAt: extraction.publishedAt ?? result.publishedAt,
        lang: extraction.lang,
        startedAt: t0,
        error:
          browserSkip ??
          "正文提取不完整（疑似动态渲染，需启用 Playwright）",
      });
    }
  }

  // ── 五级：兜底 ──
  return fallbackDocument(
    result,
    // 走到这里时 Readability 连 50 字都没拿到；如果无头浏览器那条路也因为
    // 配额或没装而没走成，那个原因比笼统的「未能提取到正文」有用得多
    browserSkip ?? res.error ?? "未能提取到正文",
    t0,
  );
}

// ─────────────────────────── 构造工具 ───────────────────────────

interface DocParts {
  method: ExtractMethod;
  text: string;
  markdown: string;
  title: string;
  images?: Document["images"];
  author?: string;
  publishedAt?: string;
  lang?: Document["lang"];
  truncated?: boolean;
  error?: string;
  startedAt: number;
}

function buildDoc(r: SearchResult, p: DocParts): Document {
  const text = p.text.trim();
  const title = p.title || r.title;
  return {
    id: r.id,
    url: r.url,
    title,
    site: r.site,
    /*
      按 **URL 路径** 判，不按站点判。

      原先写的是 `site === "youtube" || site === "bilibili" ? "video" : "article"`，
      于是 B 站的专栏（`/read/`）和图文（`/opus/`）被一律标成 video，而
      我们实测过 `/opus/` 抓到的是真正文。这个字段不是显示用的标签，它决定
      下游三件事：要不要排「字幕」下载任务、要不要排「媒体」下载任务、
      进包的哪个目录。判错就会去做一件根本不存在的事。

      判据集中在 `core/kind.ts`（纯函数，零依赖），这里只是调用点。
    */
    kind: contentKind(r.site, r.url),
    text,
    markdown: p.markdown.trim() || text,
    excerpt: text.slice(0, 200),
    lang: p.lang ?? detectLangFromText(text),
    author: p.author ?? r.author,
    publishedAt: p.publishedAt ?? r.publishedAt,
    images: p.images ?? [],
    /**
     * 连同标题一起计。构图时启发式的语料是 `` `${doc.title}。${doc.text}` ``，
     * 图的门槛（`wordCount >= 30`）理应按同一份语料来量 —— 否则 B 站那种
     * 「标题二十字 + 简介十几字、没有字幕」的视频会被判成没内容而挡在图外，
     * 尽管它其实是有语料的。
     */
    wordCount: countWords(`${title}。${text}`),
    extractMethod: p.method,
    extractMs: Date.now() - p.startedAt,
    fetchedAt: new Date().toISOString(),
    truncated: p.truncated,
    error: p.error,
    /*
      从搜索结果复制一份切题判定。下游（打包判据、报告、界面）因此直接读
      `doc.relevance` 就行，不必各自再去 join 一次 results —— 那种 join
      漏掉一处就是「某个界面不显示徽章」这种局部失灵，很难注意到。

      `undefined` = 未判定（旧会话、或那条结果没被判定）。**不是**不相关。
    */
    relevance: r.relevance,
  };
}

/**
 * 全部降级路径的唯一出口 —— 六个调用点都走这里。
 *
 * 错误文案在这一处翻译成「已知限制」，而不是在每个调用点各写一遍：调用点只
 * 需要给出**发生了什么**（`HTTP 403`、`该视频没有可用字幕`），由 `knownLimitation`
 * 判断这是不是一条平台固有属性，是就换成带结论的说法。放在 choke point 上，
 * 将来新增降级路径也自动获得这个待遇，不会漏。
 *
 * 没命中时**原样保留**原始错误 —— 绝不把一次真故障说成「已知限制」。
 */
function fallbackDocument(
  r: SearchResult,
  error: string,
  startedAt = Date.now(),
  extra: { publishedAt?: string } = {},
): Document {
  return buildDoc(r, {
    method: "raw",
    text: r.snippet,
    markdown: r.snippet,
    title: r.title,
    publishedAt: extra.publishedAt,
    startedAt,
    error: knownLimitation(r.site, error) ?? error,
  });
}

/** 中文按字数计，英文按词数计 —— 混排时取两者之和的近似。 */
function countWords(text: string): number {
  const cjk = (text.match(/[一-鿿]/g) ?? []).length;
  const latin = (text.match(/[a-zA-Z]+/g) ?? []).length;
  return cjk + latin;
}

function detectLangFromText(text: string): "zh" | "en" | "unknown" {
  const sample = text.slice(0, 1000);
  if (!sample) return "unknown";
  const cjk = (sample.match(/[一-鿿]/g) ?? []).length;
  return cjk / sample.length > 0.15 ? "zh" : "en";
}

export const fetchConfig = config;
