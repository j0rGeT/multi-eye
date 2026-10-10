/**
 * 知乎扫码登录 —— 本项目里**唯一**一处会主动去拿用户凭证的代码。
 *
 * ── 为什么是这个做法，而不是别的 ──
 *
 * 用户明确要求支持知乎登录，于是在 2026-10-10 把方案第七章「不碰登录态」
 * 那条红线开了一个口子。开的口子要尽可能小，所以做法是三选一里最小的那个：
 *
 *   ✅ 打开知乎**自己的**登录页，让用户自己扫码 —— 走的是官方前端，我们
 *      不碰密码、不碰短信验证码、不伪造任何请求签名
 *   ❌ 不做账号密码登录：那意味着密码要经过我们的进程。哪怕只存内存，
 *      也是一个完全不该存在的风险面，而且知乎自己都在推扫码
 *   ❌ 不连用户本机已登录的 Chrome（CDP 复用）：那会让我们拿到他日常浏览器里
 *      的全部身份，远超「读知乎正文」所需
 *
 * **签名算法仍然一个字节都不逆向**（`x-zse-93` / `x-zse-96` 那套）。这里
 * 拿到的只是浏览器正常登录后本来就有的 cookie，抓的还是公开页面。
 *
 * ── 判据是量过的 ──
 *
 * 未登录访问 `https://www.zhihu.com/signin` 实测拿到的 cookie 是：
 *
 *   _zap, _xsrf, BEC, d_c0, captcha_session_v2, SESSIONID, JOID, osd,
 *   __snaker__id, Hm_lvt_*, Hm_lpvt_*, HMACCOUNT, gdxidpyhxdE
 *
 * **没有 `z_c0`** —— 而 `z_c0` 就是知乎的登录态。所以「等 `z_c0` 出现」
 * 是一个可判定的成功条件，不是猜的。
 *
 * 同一次实测还确认：登录页**默认就展示二维码**（页面文案「打开知乎App
 * 在「我的页」右上角打开扫一扫」，二维码画在一个 `canvas.Qrcode-qrcode`
 * 上，120×120）。所以不需要点任何「切换到扫码」的标签页。
 */

import { createRequire } from "node:module";
import { join } from "node:path";
import type { Browser, BrowserContext } from "playwright";
import type { StoredAccount, StoredCookie } from "./cookies";
import { saveAccount, publicAccount, type PublicAccount } from "./store";

const requireFromRoot = createRequire(join(process.cwd(), "package.json"));

/** 知乎登录态 cookie 的名字。见文件头那一段实测记录。 */
export const ZHIHU_AUTH_COOKIE = "z_c0";

const SIGNIN_URL = "https://www.zhihu.com/signin";

/** 等用户扫码的默认上限。真人扫码一般十几秒，三分钟够从容了。 */
const DEFAULT_TIMEOUT_MS = 180_000;

export interface LoginEvent {
  stage: "launching" | "waiting" | "saving" | "done" | "error";
  /** 给用户看的一句话。 */
  message: string;
  /** 只在 `done` 时出现。**里面没有 cookie 值**（见 store.ts 的 publicAccount）。 */
  account?: PublicAccount;
  /** 只在 `error` 时出现。 */
  error?: string;
}

export type LoginResult =
  | { ok: true; account: PublicAccount }
  | { ok: false; error: string };

/**
 * 打开一个**有窗口的**浏览器，等用户扫码，成功后把 cookie 存到本机。
 *
 * 必须是有窗口的：无头浏览器没人能扫它画出来的二维码。这也是本项目里唯一
 * 一次以 `headless: false` 启动浏览器。
 */
export async function loginZhihu(opts: {
  onEvent?: (e: LoginEvent) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
} = {}): Promise<LoginResult> {
  const emit = (e: LoginEvent) => opts.onEvent?.(e);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let chromium: typeof import("playwright").chromium;
  try {
    ({ chromium } = requireFromRoot("playwright") as typeof import("playwright"));
  } catch {
    const error =
      "没有装 playwright —— 扫码登录需要它来打开真实的知乎登录页。" +
      "装：pnpm add -D playwright && npx playwright install chromium";
    emit({ stage: "error", message: error, error });
    return { ok: false, error };
  }

  let browser: Browser | null = null;
  try {
    emit({
      stage: "launching",
      message: "正在打开浏览器（这一步不联网，只是启动 chromium）…",
    });

    /*
      不带代理：zhihu.com 在国内清单里，`shouldProxy` 也会说直连。这里显式
      不配 proxy，而不是去调 shouldProxy —— 登录是用户全程盯着的交互过程，
      走代理只会让「为什么卡住了」变得更难解释。
    */
    browser = await chromium.launch({
      headless: false,
      args: ["--disable-blink-features=AutomationControlled"],
    });

    const context: BrowserContext = await browser.newContext({
      locale: "zh-CN",
      viewport: { width: 1280, height: 860 },
    });
    const page = await context.newPage();

    await page.goto(SIGNIN_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    emit({
      stage: "waiting",
      message: "请在弹出的窗口里用知乎 App 扫码。登录成功后窗口会自己关掉。",
    });

    const cookie = await waitForLogin(context, browser, timeoutMs, opts.signal);
    if (!cookie.ok) {
      emit({ stage: "error", message: cookie.error, error: cookie.error });
      return { ok: false, error: cookie.error };
    }

    emit({ stage: "saving", message: "登录成功，正在把登录态保存到本机…" });

    const cookies = (await context.cookies("https://www.zhihu.com")).map(toStored);
    if (cookies.length === 0) {
      const error = "拿到登录态之后读不到 cookie（浏览器上下文可能已经关掉了）";
      emit({ stage: "error", message: error, error });
      return { ok: false, error };
    }

    const account: StoredAccount = {
      site: "zhihu",
      displayName: await readDisplayName(context),
      cookies,
      savedAt: new Date().toISOString(),
    };
    await saveAccount(account);

    const pub = publicAccount(account);
    emit({
      stage: "done",
      message: pub.displayName
        ? `已登录知乎：${pub.displayName}`
        : "已登录知乎（没能读到昵称，不影响抓取）",
      account: pub,
    });
    return { ok: true, account: pub };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    emit({ stage: "error", message: error, error });
    return { ok: false, error };
  } finally {
    // 无论成败都关掉 —— 留着会是一个用户关不掉、我们也不认识的窗口
    await browser?.close().catch(() => {});
  }
}

/**
 * 轮询等 `z_c0` 出现。
 *
 * 三个退出条件，缺一个都会让用户干等：
 *   1. 拿到了 `z_c0`        → 成功
 *   2. 用户把窗口关了        → 立刻停，别空等到三分钟
 *   3. 超时                 → 说清楚是超时，而不是「失败了」这种没法行动的话
 */
async function waitForLogin(
  context: BrowserContext,
  browser: Browser,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (signal?.aborted) return { ok: false, error: "已取消" };
    if (!browser.isConnected()) {
      return { ok: false, error: "浏览器窗口被关掉了，没有完成扫码登录" };
    }

    const cookies = await context.cookies("https://www.zhihu.com").catch(() => []);
    if (cookies.some((c) => c.name === ZHIHU_AUTH_COOKIE && c.value)) {
      return { ok: true };
    }

    if (Date.now() >= deadline) {
      return {
        ok: false,
        error: `等了 ${Math.round(timeoutMs / 1000)} 秒没等到扫码结果。可以再点一次「扫码登录」重来。`,
      };
    }

    await sleep(1_000);
  }
}

/**
 * 读昵称。**尽力而为，读不到就算了**。
 *
 * 昵称只用于界面上显示「已登录：谁」，抓取一个字节都不依赖它。所以这里所有
 * 失败路径都直接返回 undefined，绝不让一个装饰性的信息把登录搞失败。
 *
 * 选择器列了多个：知乎的头像节点类名改过几轮，而这里读的是 `alt` 属性
 * （头像图的 alt 就是用户名）。全不中就退化成没有昵称 —— 那是个可接受的
 * 结果，不值得为它去逆向页面结构。
 */
async function readDisplayName(context: BrowserContext): Promise<string | undefined> {
  const selectors = [
    "img.AppHeader-profileAvatar",
    ".AppHeader-profileAvatar img",
    "img.Avatar",
    ".Avatar img",
    "img[class*=Avatar]",
  ];
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    // 登完之后页面会跳到首页，头部要等一会儿才渲染出来
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
    for (const sel of selectors) {
      const el = await page.$(sel).catch(() => null);
      if (!el) continue;
      const alt = (await el.getAttribute("alt").catch(() => null))?.trim();
      if (alt) return alt;
    }
  } catch {
    // 见上：装饰性信息，失败不是错误
  }
  return undefined;
}

/**
 * Playwright 的 cookie 对象 → 我们自己的形状。
 *
 * `domain` / `path` 在 Playwright 的类型里是可选的，但**从浏览器里读出来的
 * cookie 一定两者都有**（没有域怎么可能被存下来）。这里给个兜底而不是断言，
 * 是为了让类型收窄得干净：真出现空 domain 时存下来一个 `.zhihu.com` 之外
 * 的域也不会被误发（`accountSiteFor` 那道闸在发送前还会再判一次）。
 */
function toStored(c: {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}): StoredCookie {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain ?? ".zhihu.com",
    path: c.path ?? "/",
    expires: c.expires,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: c.sameSite,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
