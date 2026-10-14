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
import type { Extraction } from "./readability";
import { extractWithReadability, looksLikeCode, looksLikeSpa } from "./readability";
import { boilerplateReason } from "./boilerplate";
import { knownLimitation } from "./limitations";
import { isLoggedIn, loggedInFor } from "@/core/auth/store";
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
  /**
   * 这一轮里，用户对哪些站点是**登录着的**（`core/auth/store.ts`）。
   *
   * 只影响错误文案：同样是知乎 403，「去登录一次」和「你登录过期了，重新扫码」
   * 是给用户的两种完全不同的指令（见 `limitations.ts` 里知乎那两段）。
   *
   * 一轮读一次、放进预算里跟着走，而不是每篇去问一次 —— 一次抓取里同一篇
   * 站点的失败往往是同一个原因，问一遍就够了；而且这样 `fallbackDocument`
   * 不必变成 async。
   */
  loggedIn: Record<string, boolean>;
}

export async function extractMany(
  results: SearchResult[],
  opts: ExtractOptions = {},
): Promise<Document[]> {
  const concurrency = opts.concurrency ?? 4;
  const gate = limiter("extract", concurrency);
  const budget: ExtractBudget = {
    playwrightLeft: config.playwrightMaxPagesPerRun,
    loggedIn: await loggedInFor(results.map((r) => r.site)),
  };

  let done = 0;
  const tasks = results.map((r) =>
    gate(() => {
      /*
        知乎和小红书单独串行：它们的风控对并发极其敏感，多路同时打开会显著增加 412/403/重定向。
        其它站点仍走全局并发，避免因为一个平台把整批抓取拖慢。
      */
      const siteGate = limiter(
        `extract:${r.site}`,
        r.site === "zhihu" || r.site === "xiaohongshu" ? 1 : concurrency,
      );
      return siteGate(async () => {
        const doc = await extractOne(r, opts.signal, budget);
        done += 1;
        opts.onProgress?.(done, results.length, doc);
        return doc;
      });
    }),
  );

  // 用 allSettled 而不是 all：即使某个任务因为意外抛出，其他文档也要保住
  const settled = await Promise.allSettled(tasks);
  return settled.map((s, i) =>
    s.status === "fulfilled"
      ? s.value
      : fallbackDocument(results[i], String(s.reason), undefined, {}, budget),
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
    return fallbackDocument(
      result,
      tr.error ?? "该视频没有可用字幕",
      t0,
      { publishedAt: tr.publishedAt ?? result.publishedAt },
      budget,
    );
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
    return fallbackDocument(
      result,
      bv.error ?? "B站接口未返回可用内容",
      t0,
      { publishedAt: bv.publishedAt ?? result.publishedAt },
      budget,
    );
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
      {},
      budget,
    );
  }

  // ── 三级：HTTP + Readability ──
  const res = await fetchHtml(result.url, { signal });

  /*
    HTTP 这一趟**失败**时（403 / 超时 / 连不上），不是立刻兜底 —— 先问一次
    无头浏览器。

    这条路是补上的。`wantsBrowser` 原先整个写在 `if (res.ok && res.body)` 里面，
    于是 403 这条**最常见的知乎失败永远走不到浏览器**：知乎对未登录游客一律回
    403，而无头浏览器带着用户自己扫码拿到的登录态能正常拿到正文。结果就是
    「明明登录了，抓出来还是只有搜索摘要」—— 用户查不出原因，因为代码里
    根本没有那一步。

    失败恰恰是最该换一条路的信号：HTTP 层被拒的是「一个裸请求」，浏览器带的
    是完整渲染环境 + 登录 cookie，两者不是一回事。

    门槛收得很紧（见 `browserWorthRetry`）：只有**手上有登录态**的站点
    才走 —— 没有 cookie 时换浏览器只是换一种方式被同一个 403 拒掉，白白烧掉
    一个全局配额（默认 8 页），同轮真正需要渲染的 JS 空壳页就没有名额了。
  */
  if (!(res.ok && res.body) && (await browserWorthRetry(result, budget))) {
    const viaBrowser = await runBrowserLevel(result, null, signal, budget, t0);
    if (viaBrowser.doc) return viaBrowser.doc;
    /*
      浏览器也没救回来。把两件事**一起**写进 error，而不是让后者盖掉前者：
      「HTTP 403」是发生了什么，「浏览器也试过」是我们做了什么。少了前者，
      排查时看不出原始失败；少了后者，用户会以为我们没试过别的办法。

      前者必须留在串里：`knownLimitation` 靠 `HTTP 40[13]` 这个特征串认出
      知乎限制，整段换掉它认不出来的话，403 会被当成一次普通故障报给用户。
    */
    browserSkip = viaBrowser.skip
      ? `${res.error ?? "抓取失败"}；已尝试无头浏览器：${viaBrowser.skip}`
      : res.error;
  }

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
        {},
        budget,
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
    if (wantsBrowserLevel(result, res.body, extraction)) {
      const viaBrowser = await runBrowserLevel(result, extraction, signal, budget, t0);
      if (viaBrowser.doc) return viaBrowser.doc;
      browserSkip = viaBrowser.skip;
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
    {},
    budget,
  );
}

// ─────────────────────────── 四级：无头浏览器 ───────────────────────────

/**
 * 正文拿到了但是空壳（`thin`）时，`on-demand` 模式下要不要花一个浏览器名额。
 *
 * `always` 每篇都试、`off` 从不试，两个都不用判页面；只有 `on-demand` 要看页
 * 长什么样，所以判据都收敛在这里，而不是散在调用点。
 *
 * 知乎那条**额外**判据是刻意单列的：它的静态 HTML 通常不是典型 SPA 空壳
 * （`id="app"` 这类标记一个都没有），`looksLikeSpa` 认不出来；但它给的常常
 * 只是「展开阅读全文」之前的两三百字预览。正文一旦过短就直接走浏览器，用
 * 登录态拿完整正文 —— 只对知乎生效，不改变其它站点的降级成本。
 */
function wantsBrowserLevel(
  result: SearchResult,
  html: string,
  extraction: Extraction,
): boolean {
  if (config.playwrightMode === "always") return true;
  if (config.playwrightMode !== "on-demand") return false;
  return (
    looksLikeSpa(html, extraction) ||
    ((result.site === "zhihu" || result.site === "xiaohongshu" || result.site === "wechat") &&
      extraction.thin)
  );
}

/**
 * HTTP 那一趟**整趟失败**（403 / 超时 / 连不上）之后，还要不要让无头浏览器再试一次。
 *
 * ── 为什么这条路上原来一步都没有 ──
 *
 * `wantsBrowserLevel` 原先整个写在 `if (res.ok && res.body)` 里面，于是
 * 「请求本身失败」这条路永远到不了浏览器 —— 而这恰恰是最需要换一条路的信号：
 * 被拒的是一个裸 HTTP 请求，浏览器带的是完整渲染环境 + 登录 cookie。
 * 知乎未登录游客一律 403 是最大的一类失败，用户明明登录了也照样只有摘要，
 * 就是因为这里根本没有那一步。
 *
 * ── 为什么门槛收得比 `wantsBrowserLevel` 还紧 ──
 *
 * `on-demand` 下只对**手上有登录态**的站点开这一路：浏览器之所以可能成功，
 * 靠的就是 `cookiesFor()` 里那份用户自己扫码拿到的 cookie（目前只有知乎有）。
 * 没有 cookie 时换浏览器只是换一种方式被同一个 403 拒掉，白烧一个全局配额
 * （默认 8 页）—— 那个配额是同轮所有页面共享的，烧在一个注定失败的站点上，
 * 真正需要渲染的 JS 空壳页就没有名额了。
 *
 * `always` 则是「每篇都试」的字面语义，失败也不例外。
 */
async function browserWorthRetry(
  result: SearchResult,
  budget: ExtractBudget | undefined,
): Promise<boolean> {
  if (config.playwrightMode === "off") return false;
  if (config.playwrightMode !== "always") {
    const loggedIn = budget
      ? !!budget.loggedIn[result.site]
      : await isLoggedIn(result.site);
    if (!loggedIn) return false;
  }
  return true;
}

interface BrowserOutcome {
  /** 抽到正文时给出文档；没抽到为 null。 */
  doc: Document | null;
  /** 没走成 / 走了没用的原因。写进 `browserSkip`，最终进 `doc.error`。 */
  skip?: string;
}

/**
 * 四级降级（无头浏览器）的实现，**两条**调用路径共用：
 *
 *   1. HTTP 拿到了 HTML、但正文过短（原有路径）
 *   2. HTTP 这一趟直接失败（本次新增，见 `browserWorthRetry`）
 *
 * 两条路径的差别只在 `extraction`：第 2 条没有静态 HTML 可解析，传 null ——
 * 于是所有从 `extraction` 取的字段都退回 `result` 里搜索层给的值，日期与
 * 标题不会因为「换了一条路」而凭空消失。
 *
 * 抽不出来时**返回 null + skip 而不是抛异常**：单篇失败不该打断整批，
 * 原因由调用方写进 `browserSkip`，最终落成 `doc.error`（见文件头的约定）。
 */
async function runBrowserLevel(
  result: SearchResult,
  extraction: Extraction | null,
  signal: AbortSignal | undefined,
  budget: ExtractBudget | undefined,
  t0: number,
): Promise<BrowserOutcome> {
  if (!(await isPlaywrightAvailable())) {
    return {
      doc: null,
      skip: "已启用无头浏览器，但本机没有可用的浏览器二进制（npx playwright install chromium）",
    };
  }

  // 先问要名额、再开页面：扣不到名额时一个浏览器都不该起
  if (!takePlaywrightSlot(budget)) {
    return {
      doc: null,
      skip:
        `本轮无头浏览器配额（${config.playwrightMaxPagesPerRun} 页）已用完` +
        `。调大 PLAYWRIGHT_MAX_PAGES_PER_RUN 或减少一次抓取的篇数。`,
    };
  }

  const br = await fetchWithBrowser(result.url, { signal });
  if (br.html) {
    // 站点专用选择器命中时直接用，比再跑一次 Readability 准。
    // 但仍要过一遍代码检测：选择器可能框到了一块内联 JSON。
    if (
      br.selectorText &&
      br.selectorText.length > 200 &&
      !looksLikeCode(br.selectorText)
    ) {
      return {
        doc: buildDoc(result, {
          method: "playwright",
          text: br.selectorText,
          markdown: br.selectorText,
          title: extraction?.title || result.title,
          images: extraction?.images,
          /*
            别把第一次 HTTP 那趟已经读到的日期丢掉。

            这一支换的是正文来源（静态 HTML → 无头浏览器渲染结果），
            和日期没有关系；`extraction` 是从静态 HTML 解析出来的，
            它的 publishedAt 与这次替换无关，仍然有效。
          */
          publishedAt: extraction?.publishedAt ?? result.publishedAt,
          lang: extraction?.lang,
          startedAt: t0,
        }),
      };
    }

    const re = extractWithReadability(br.html, result.url);
    if (!re.thin) {
      return {
        doc: buildDoc(result, {
          method: "playwright",
          text: re.text,
          markdown: re.markdown,
          title: re.title || extraction?.title || result.title,
          images: re.images,
          author: re.byline ?? result.author,
          publishedAt: re.publishedAt ?? extraction?.publishedAt ?? result.publishedAt,
          lang: re.lang,
          startedAt: t0,
        }),
      };
    }
  }

  // 浏览器跑了但也没抽出东西 —— 也要说清是「跑了没用」而不是「没跑」
  return { doc: null, skip: "已用无头浏览器渲染，仍没抽到正文" };
}

// ─────────────────────────── 构造工具 ───────────────────────────

interface DocParts {
  method: ExtractMethod;
  text: string;
  markdown: string;
  title: string;
  images?: Document["images"];
  thumbnail?: string;
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
    thumbnail: p.thumbnail ?? r.thumbnail,
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
  budget?: ExtractBudget,
): Document {
  return buildDoc(r, {
    method: "raw",
    text: r.snippet,
    markdown: r.snippet,
    title: r.title,
    publishedAt: extra.publishedAt,
    startedAt,
    error:
      knownLimitation(r.site, error, { loggedIn: budget?.loggedIn?.[r.site] }) ?? error,
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
