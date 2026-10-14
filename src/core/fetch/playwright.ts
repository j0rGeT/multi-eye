/**
 * 无头浏览器降级路径（可选依赖）。
 *
 * 只在 Readability 判定页面为 JS 空壳时才走到这里。Playwright 体积数百 MB，
 * 因此设成可选：没装就跳过这一级，正文退化为搜索摘要，其余功能不受影响。
 *
 * ── 登录态（P14）──
 *
 * 这里会往浏览器上下文里灌 cookie，但**不是**去连本机那个已经登录的 Chrome
 * （CDP 复用登录态）。那等于借用一个用户自己都说不清状态的会话，而且会让
 * 一个外来的无头进程拿到他日常浏览器里的全部身份。要接的话只需改 getBrowser
 * 这一处 —— 不做，是刻意的。
 *
 * 灌进去的是用户在界面上**自己扫码**（见 `core/auth/zhihu.ts`）拿到的 cookie，
 * 只对该站点生效，存本机、不入库。
 */

import { createRequire } from "node:module";
import { join } from "node:path";
import type { Browser, ElementHandle, Page } from "playwright";
import { config } from "@/core/env";
import { shouldProxy } from "@/core/net/domestic";
import { cookiesFor } from "@/core/auth/store";
import { ZHIHU_EXPAND_SELECTORS, ZHIHU_EXPAND_TEXT } from "./readability";

/**
 * 用 createRequire 而不是 `await import("playwright")`。
 *
 * 打包器会静态分析 import() 里的字面量，遇到没安装的包就每次构建都吐一条
 * "Module not found" 警告 —— 对一个刻意不装的可选依赖来说这是纯噪音，而且
 * 会训练人忽略构建输出。require 对打包器不透明，警告消失，解析规则仍是标准的
 * node_modules 向上查找，所以用户 `pnpm add playwright` 之后立刻就能生效。
 *
 * 锚定在 cwd 而非 import.meta.url：Next 会把服务端代码打进 .next/ 下的产物，
 * 以产物位置为基准会找不到项目根目录的 node_modules。
 */
const requireFromRoot = createRequire(join(process.cwd(), "package.json"));

/**
 * 浏览器实例按「要不要走代理」各存一个。
 *
 * 为什么是**两个实例**而不是一个带 `bypass` 的实例：`bypass` 在这个组合上
 * 根本不生效。实测（Playwright 1.51 + chromium 1161，本地静态服务器
 * `127.0.0.1:8791`）：
 *
 *   proxy.bypass = "127.0.0.1"          → 没到（代理返回错误页）
 *   proxy.bypass = "localhost,127.0.0.1" → 没到
 *   proxy.bypass = "<-loopback>"         → 没到
 *   proxy.bypass = "*"                   → 没到
 *   --proxy-bypass-list 直给 args        → 没到
 *   不配代理                             → 885 字，正常
 *
 * 连 `*` 都不生效，说明这不是匹配规则写错了，而是这条路走不通。于是回到
 * 和 HTTP 层**同一个判据**：`shouldProxy(url)` 说不用代理的，就用一个
 * 根本没配代理的浏览器。两处判断同源，不会再出现「HTTP 层直连、浏览器层
 * 绕代理」这种两层不一致。
 *
 * 代价是可能同时存在两个 Chromium 进程（各约 100MB）。只有在一次抓取里
 * 既有国内/本机页面又有境外页面时才会都起来，而那种情况本来就要两个实例
 * 才能都对。
 */
const browsers = new Map<boolean, Promise<Browser | null>>();

/** 冷启动约 1 秒，复用后每次抓取只需新建 context。 */
function getBrowser(useProxy: boolean): Promise<Browser | null> {
  if (config.playwrightMode === "off") return Promise.resolve(null);

  let p = browsers.get(useProxy);
  if (!p) {
    p = launchBrowser(useProxy);
    browsers.set(useProxy, p);
  }
  return p;
}

async function launchBrowser(useProxy: boolean): Promise<Browser | null> {
  try {
    const { chromium } = requireFromRoot("playwright") as typeof import("playwright");
    // 境外站点必须走代理：无头浏览器绕不过网络可达性，直连会超时。
    // 与 httpFetch 用同一个 config.fetchProxyUrl，两处行为保持一致。
    const proxy = useProxy ? config.fetchProxyUrl.trim() : "";
    return await chromium.launch({
      headless: true,
      args: ["--disable-blink-features=AutomationControlled"],
      ...(proxy ? { proxy: { server: proxy } } : {}),
    });
  } catch {
    return null;
  }
}

export async function isPlaywrightAvailable(): Promise<boolean> {
  // 用不带代理的那个探活：`isPlaywrightAvailable` 回答的是「有没有可用的
  // 浏览器二进制」，与代理通不通无关，而配了代理的实例要多一层无关变量。
  return (await getBrowser(false)) !== null;
}

/**
 * 「包装了没有」—— 只做模块解析，**不启动浏览器**。
 *
 * 和 `isPlaywrightAvailable()` 的分工：
 *
 *   - 那边要真启动一次（~1 秒）才知道行不行，所以结果缓存在单例里，供抓取链用；
 *   - 这边给 `/api/health` 用。健康检查是用户刷新页面就会打一次的东西，
 *     在里面启动一个 Chromium 是不可接受的 —— 一个探活接口不该有这种副作用。
 *
 * 因此它回答的只是「playwright 这个包解析得到吗」，**不包括**浏览器二进制
 * 有没有下载。两者是分开的两步（`npm i playwright` 与 `npx playwright install
 * chromium`），而后者只能靠真启动来确认。所以返回 true 时提示语里仍然要写清
 * 「首次使用需要 npx playwright install chromium」—— 不能因为这里返回 true
 * 就告诉用户「已经可用」。
 */
export function isPlaywrightInstalled(): boolean {
  try {
    requireFromRoot.resolve("playwright");
    return true;
  } catch {
    return false;
  }
}

export interface BrowserFetchResult {
  html: string;
  /** 站点专用选择器命中的正文，直接可用，比再跑一次 Readability 更准。 */
  selectorText?: string;
  error?: string;
}

/**
 * 站点专用正文选择器。
 *
 * 这些站点把正文塞在特定容器里，通用 Readability 经常抽到导航或推荐流。
 * 直取容器比事后调参可靠。
 */
const SITE_SELECTORS: { match: RegExp; selectors: string[] }[] = [
  {
    match: /zhihu\.com/,
    selectors: [".RichContent-inner", ".QuestionAnswer-content", ".Post-RichText"],
  },
  {
    match: /xiaohongshu\.com/,
    selectors: [
      "#detail-desc",
      ".note-content",
      ".desc",
      ".interaction-container .note-scroller",
      ".content-container",
      ".note-detail-mask",
    ],
  },
  {
    match: /mp\.weixin\.qq\.com/,
    selectors: ["#js_content", ".rich_media_content", "#img-content"],
  },
  {
    match: /bilibili\.com/,
    selectors: [".article-holder", ".video-desc", "#read-article-holder"],
  },
  {
    match: /(twitter|x)\.com/,
    selectors: ['[data-testid="tweetText"]', "article"],
  },
];

/**
 * 知乎折叠正文的展开。
 *
 * ── 为什么必须点一下 ──
 *
 * 知乎的回答/专栏在 HTML 里默认是**折叠态**：DOM 里只有「展开阅读全文」之前
 * 露出的两三百字预览，正文的其余部分要等用户点开才由 XHR 拉回来。所以光把
 * 页面渲染出来没用 —— 静态侧（`readability.ts` 的 `isCollapsed`）只能看出
 * 折叠，点不开；真正把全文放出来必须有人去点那个按钮。这一步没法在 jsdom
 * 里补，只能在真实渲染的页面上做。
 *
 * ── 点完要等 ──
 *
 * 点击之后正文是异步写进 DOM 的（知乎先收起按钮、再渲染全文），立刻读 innerText
 * 拿到的仍是旧的预览。800ms 是实测值：更短会稳定读到折叠内容，更长只是白白
 * 拖慢每一篇（知乎是串行抓取，这个等待会线性累加）。
 *
 * ── 不做无限重试 ──
 *
 * 上限 20 次：一个问题页有十几个回答，全部展开是合理的；再往上要么是改版后
 * 选择器误命中了别的按钮，要么是页面结构变了。这两种都该停下来，而不是把
 * 每篇的浏览器时间拖成几十秒。
 */
const EXPAND_WAIT_MS = 800;
const MAX_EXPAND_CLICKS = 20;

async function expandZhihu(page: Page): Promise<void> {
  let clicks = 0;

  for (const sel of ZHIHU_EXPAND_SELECTORS) {
    if (clicks >= MAX_EXPAND_CLICKS) return;
    const handles = await page.$$(sel).catch(() => []);
    for (const el of handles) {
      if (clicks >= MAX_EXPAND_CLICKS) return;
      if (!(await shouldClick(el))) continue;
      clicks += 1;
      await el.click({ timeout: 2_000 }).catch(() => {});
      await page.waitForTimeout(EXPAND_WAIT_MS).catch(() => {});
    }
  }
}

/**
 * 这个按钮现在该不该点。
 *
 * 按**文案**判而不是「匹配到了就点」：选择器里有一条 `button[class*='expand' i]`
 * 这种宽匹配，改版后很容易框到「展开评论」「展开目录」这类按钮，点了只是浪费
 * 时间还可能把页面状态弄乱。已经展开过的段落按钮会变回「收起」，同样不该再点。
 *
 * 文案读不出来（元素被移除/隐藏）时按「该点」处理 —— 宁可多点一次，也不要把
 * 一个真的展开按钮因为 innerText 的一次瞬时失败放过。
 */
async function shouldClick(el: ElementHandle): Promise<boolean> {
  const text = (await el.innerText().catch(() => "")).trim();
  if (!text) return true;
  return ZHIHU_EXPAND_TEXT.test(text);
}

/**
 * 这个正文容器是不是**还**处于折叠态（展开点过之后再确认一次）。
 *
 * 两条判据，与静态侧 `readability.ts` 的 `isCollapsed` 逐条对应 —— 两边必须
 * 同一口径，否则会出现「静态说折叠、浏览器说展开了」的自相矛盾：
 *
 *  1. 容器自己的 class 带 `collaps`（知乎的 `RichContent-inner is-collapsed`）
 *  2. 容器里还留着一个文案是「展开阅读全文」的按钮（展开后它会变成「收起」）
 *
 * 判**容器自己**而不是整页：问题页上有十几个回答，我们只点得动前二十个，
 * 页面别处必然还留着折叠容器，按整页判会把已经拿到的正文一起否掉。
 *
 * 仍然折叠时调用方应当**跳过**这段 innerText —— 它是两三百字的预览，却会因为
 * 超过 200 字的门槛被当成「拿到了正文」，正是静态侧那个坑在浏览器侧的重演。
 */
async function containerCollapsed(el: ElementHandle): Promise<boolean> {
  const cls = (await el.getAttribute("class").catch(() => null)) ?? "";
  if (/collaps/i.test(cls)) return true;

  const btns = await el.$$("button, a").catch(() => []);
  for (const b of btns) {
    const text = (await b.innerText().catch(() => "")).trim();
    if (ZHIHU_EXPAND_TEXT.test(text)) return true;
  }
  return false;
}

export async function fetchWithBrowser(
  url: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<BrowserFetchResult> {
  /*
    走不走代理**按这个 URL** 现算，与 HTTP 抓取层同一个 `shouldProxy`。
    写死成「浏览器一律走代理」会让本地/国内页面拿到代理的错误页，
    而那个错误页会被当成「渲染了但没正文」—— 一个查不出来的假故障。
  */
  const browser = await getBrowser(shouldProxy(url));
  if (!browser) {
    return { html: "", error: "Playwright 未启用或未安装" };
  }

  const timeoutMs = opts.timeoutMs ?? 30_000;
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    locale: "zh-CN",
    viewport: { width: 1440, height: 900 },
  });

  /*
    反自动化特征抹除（2026-10-14 实测补上，修的就是「知乎登录了却只抓到摘要」）。

    实测：用已登录的 zhihu cookie 直接 page.goto 专栏文章，拿到的是一段风控页
    （`{"error":{"code":40362,"message":"您当前请求存在异常..."}}`）—— 知乎的
    zse-ck 风控校验 `navigator.webdriver`，而 Playwright 默认把它暴露成 true。

    起 chromium 时的 `--disable-blink-features=AutomationControlled` 只挡住了
    Blink 层的自动化标记，**不覆盖** `navigator.webdriver` 这个 JS 属性，两者缺一
    不可。加上这段 initScript 之后，同一篇专栏、同样的 cookie 立即拿到 11562 字
    全文（此前只有搜索摘要几百字）。

    这不是绕过任何签名或鉴权（知乎的 x-zse-93/96 一个字节都没碰），只是让一个
    真实浏览器不主动申报「我是自动化脚本」。
  */
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  /*
    登录态要灌进浏览器上下文，而不是只加一个 `Cookie` 请求头。

    页面渲染出来之后，正文往往是页面**自己发的 XHR** 取回来再写进 DOM 的。
    那种请求由浏览器发起，`context.route()` 改写头只能改到能被改写的那部分，
    而 `addCookies` 是让浏览器认为「我本来就是登录着的」—— 后续所有同源请求
    （包括页面自己发的）自动带上。这是两者唯一可靠的分工。

    灌进去的仍然只有 `core/auth/cookies.ts` 表里那些站点（目前只有知乎），
    且是用户自己扫码登录所得。
  */
  const cookies = await cookiesFor(url);
  if (cookies.length > 0) {
    await context.addCookies(
      cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || "/",
        ...(c.expires !== undefined && c.expires > 0 ? { expires: c.expires } : {}),
        ...(c.httpOnly !== undefined ? { httpOnly: c.httpOnly } : {}),
        ...(c.secure !== undefined ? { secure: c.secure } : {}),
        ...(c.sameSite !== undefined ? { sameSite: c.sameSite } : {}),
      })),
    );
  }

  try {
    // 拦掉图片/字体/媒体：正文提取不需要它们，能显著加快加载
    await context.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (type === "image" || type === "font" || type === "media") {
        return route.abort();
      }
      return route.continue();
    });

    const page = await context.newPage();
    const onAbort = () => page.close().catch(() => {});
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      // domcontentloaded 之后内容往往还在渲染，给个短暂的静默期
      await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});

      // 知乎的正文默认是折叠的，不点开就只能拿到两三百字的预览（见 expandZhihu）
      if (/zhihu\.com/.test(url)) await expandZhihu(page);

      let selectorText: string | undefined;
      for (const { match, selectors } of SITE_SELECTORS) {
        if (!match.test(url)) continue;
        for (const sel of selectors) {
          const el = await page.$(sel);
          if (!el) continue;
          // 点开之后仍折叠的容器，读到的只是预览 —— 那正是静态侧那个坑的重演
          if (/zhihu\.com/.test(url) && (await containerCollapsed(el))) continue;
          const txt = (await el.innerText()).trim();
          if (txt.length > 200) {
            selectorText = txt;
            break;
          }
        }
        if (selectorText) break;
      }

      return { html: await page.content(), selectorText };
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
    }
  } catch (err) {
    return {
      html: "",
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * 进程退出时清理浏览器，避免留下孤儿 chromium 进程。
 *
 * 两个实例都要关 —— 一次抓取里既有国内页面又有境外页面时它们都存在。
 */
export async function closeBrowser(): Promise<void> {
  const pending = [...browsers.values()];
  browsers.clear();
  for (const p of pending) {
    const b = await p.catch(() => null);
    await b?.close().catch(() => {});
  }
}
