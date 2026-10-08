/**
 * 无头浏览器降级路径（可选依赖）。
 *
 * 只在 Readability 判定页面为 JS 空壳时才走到这里。Playwright 体积数百 MB，
 * 因此设成可选：没装就跳过这一级，正文退化为搜索摘要，其余功能不受影响。
 *
 * 明确不做的事：不连接本机已登录的 Chrome（CDP 复用登录态）。那属于未授权
 * 抓取，违反平台用户协议且有封号风险。要接的话只需改 getBrowser 这一处。
 */

import type { Browser } from "playwright";
import { config } from "@/core/env";

let browserPromise: Promise<Browser | null> | undefined;

/** 单例浏览器。冷启动约 1 秒，复用后每次抓取只需新建 context。 */
async function getBrowser(): Promise<Browser | null> {
  if (!config.enablePlaywright) return null;

  browserPromise ??= (async () => {
    try {
      // 动态 import：没装 playwright 时整个模块仍可加载，只是这一级被跳过
      const { chromium } = await import("playwright");
      // 浏览器同样要走代理：无头浏览器绕不过网络可达性，境外站点直连会超时。
      // 与 httpFetch 用同一个 config.fetchProxyUrl，两处行为保持一致。
      const proxy = config.fetchProxyUrl.trim();
      return await chromium.launch({
        headless: true,
        args: ["--disable-blink-features=AutomationControlled"],
        ...(proxy ? { proxy: { server: proxy } } : {}),
      });
    } catch {
      return null;
    }
  })();

  return browserPromise;
}

export async function isPlaywrightAvailable(): Promise<boolean> {
  return (await getBrowser()) !== null;
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
  const browser = await getBrowser();
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

/** 进程退出时清理浏览器，避免留下孤儿 chromium 进程。 */
export async function closeBrowser(): Promise<void> {
  const b = await browserPromise?.catch(() => null);
  await b?.close().catch(() => {});
  browserPromise = undefined;
}
