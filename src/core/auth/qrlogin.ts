/**
 * 通用扫码登录流程（多站点共用）。
 *
 * ── 为什么抽出来 ──
 *
 * `./zhihu` 是这个流程的原型：开一个**有窗口的**浏览器 → 打开站点自己的登录页
 * → 轮询等登录态凭证出现 → 把 cookie 存进 `data/auth/<site>.json`。小红书要的
 * 完全是同一件事，只差四个参数（登录 URL、判定成功用的 cookie 名、读昵称的
 * 选择器、消息文案）。把这四件事复制一份意味着两处的轮询逻辑、超时处理、
 * 「浏览器被关掉了」的判据会各自演化 —— 而它们全都属于「错了会让用户干等
 * 三分钟」的那一类。
 *
 * ── 三条不因站点而变的规矩 ──
 *
 *  1. **只打开站点自己的官方登录页**，走它自己的前端。不碰密码、不碰验证码、
 *     不伪造任何请求签名，也不逆向任何 `x-`/`wbi`/`x-s` 签名头。
 *  2. 拿到的只是浏览器正常登录后本来就有的 cookie，抓的还是公开页面。
 *  3. cookie 只写本机 `data/auth/`，0600，任何 API 都不返回其值。
 */

import { createRequire } from "node:module";
import { join } from "node:path";
import type { Browser, BrowserContext } from "playwright";
import type { StoredAccount, StoredCookie } from "./cookies";
import { saveAccount, publicAccount, type PublicAccount } from "./store";

const requireFromRoot = createRequire(join(process.cwd(), "package.json"));

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

/** 一个站点的扫码登录规格 —— 换站点只换这四样。 */
export interface QrLoginSpec {
  /** 与 `SiteKey` 同名，例如 "xiaohongshu"。 */
  site: string;
  /** 站点**自己的**官方登录页。 */
  signinUrl: string;
  /** `context.cookies()` 的查询域。 */
  cookieDomain: string;
  /**
   * 判定「登录成功」的 cookie 名。必须是**登录后才会出现**的那个，
   * 不能是访客也会拿到的匿名 id（那样会在用户还没扫的时候就误判成功）。
   */
  authCookie: string;
  /** 界面文案：请在弹出的窗口里用什么扫码。 */
  scanHint: string;
  /** 成功后的祝贺语模板。`{name}` 是读到的昵称，读不到就整句换 fallback。 */
  doneNamed: (name: string) => string;
  doneUnnamed: string;
  /** 读昵称的选择器。读不到不影响登录（见 readDisplayName）。 */
  displayNameSelectors?: readonly string[] | string[];
}

/**
 * 打开一个**有窗口的**浏览器，等用户扫码，成功后把 cookie 存到本机。
 *
 * 必须是有窗口的：无头浏览器没人能扫它画出来的二维码。
 */
export async function runQrLogin(
  spec: QrLoginSpec,
  opts: {
    onEvent?: (e: LoginEvent) => void;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<LoginResult> {
  const emit = (e: LoginEvent) => opts.onEvent?.(e);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let chromium: typeof import("playwright").chromium;
  try {
    ({ chromium } = requireFromRoot("playwright") as typeof import("playwright"));
  } catch {
    const error =
      `没有装 playwright —— 扫码登录需要它来打开真实的${spec.site}登录页。` +
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

    browser = await chromium.launch({
      headless: false,
      args: ["--disable-blink-features=AutomationControlled"],
    });

    const context = await browser.newContext({
      locale: "zh-CN",
      viewport: { width: 1280, height: 860 },
    });
    // 站点的风控会看这个属性（实测知乎就是），登录页也不例外
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });

    const page = await context.newPage();
    await page.goto(spec.signinUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    emit({ stage: "waiting", message: spec.scanHint });

    const cookie = await waitForLogin(spec, context, browser, timeoutMs, opts.signal);
    if (!cookie.ok) {
      emit({ stage: "error", message: cookie.error, error: cookie.error });
      return { ok: false, error: cookie.error };
    }

    emit({ stage: "saving", message: "登录成功，正在把登录态保存到本机…" });

    const stored = (
      await context.cookies(spec.cookieDomain).catch(() => [])
    ).map(toStored);
    if (stored.length === 0) {
      const error = "拿到登录态之后读不到 cookie（浏览器上下文可能已经关掉了）";
      emit({ stage: "error", message: error, error });
      return { ok: false, error };
    }

    const account: StoredAccount = {
      site: spec.site,
      displayName: await readDisplayName(context, spec.displayNameSelectors ?? []),
      cookies: stored,
      savedAt: new Date().toISOString(),
    };
    await saveAccount(account);

    const pub = publicAccount(account);
    emit({
      stage: "done",
      message: pub.displayName
        ? spec.doneNamed(pub.displayName)
        : spec.doneUnnamed,
      account: pub,
    });
    return { ok: true, account: pub };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    emit({ stage: "error", message: error, error });
    return { ok: false, error };
  } finally {
    await browser?.close().catch(() => {});
  }
}

/**
 * 轮询等登录 cookie 出现。
 *
 * 三个退出条件，缺一个都会让用户干等：
 *   1. 拿到登录 cookie  → 成功
 *   2. 用户把窗口关了  → 立刻停，别空等到三分钟
 *   3. 超时            → 说清楚是超时，而不是「失败了」这种没法行动的话
 */
async function waitForLogin(
  spec: QrLoginSpec,
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

    const cookies = await context.cookies(spec.cookieDomain).catch(() => []);
    if (cookies.some((c) => c.name === spec.authCookie && c.value)) {
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
 */
async function readDisplayName(
  context: BrowserContext,
  selectors: readonly string[],
): Promise<string | undefined> {
  if (selectors.length === 0) return undefined;
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
    for (const sel of selectors) {
      const el = await page.$(sel).catch(() => null);
      if (!el) continue;
      const alt = (await el.getAttribute("alt").catch(() => null))?.trim();
      if (alt) return alt;
      const text = (await el.innerText().catch(() => "")).trim();
      if (text && text.length < 40) return text;
    }
  } catch {
    // 见上：装饰性信息，失败不是错误
  }
  return undefined;
}

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
    domain: c.domain ?? "",
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
