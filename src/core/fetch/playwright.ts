/**
 * 无头浏览器降级路径（可选依赖）。
 *
 * 只在 Readability 判定页面为 JS 空壳时才走到这里。Playwright 体积数百 MB，
 * 因此设成可选：没装就跳过这一级，正文退化为搜索摘要，其余功能不受影响。
 *
 * 明确不做的事：不连接本机已登录的 Chrome（CDP 复用登录态）。那属于未授权
 * 抓取，违反平台用户协议且有封号风险。要接的话只需改 getBrowser 这一处。
 */

import { createRequire } from "node:module";
import { join } from "node:path";
import type { Browser } from "playwright";
import { config } from "@/core/env";
import { shouldProxy } from "@/core/net/domestic";

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
    selectors: ["#detail-desc", ".note-content", ".desc"],
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

      let selectorText: string | undefined;
      for (const { match, selectors } of SITE_SELECTORS) {
        if (!match.test(url)) continue;
        for (const sel of selectors) {
          const el = await page.$(sel);
          if (!el) continue;
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
