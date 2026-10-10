/**
 * 登录态的落盘与读取。
 *
 * ── 这是什么东西 ──
 *
 * 用户在界面上**自己扫码**登录之后，浏览器拿到的 cookie 存在
 * `data/auth/<site>.json`。抓取该站点的**公开页面**时原样带上，这样知乎
 * 不再对游客返回 403。
 *
 * ── 边界的写法（这一段是刻意写得这么啰嗦的）──
 *
 * 这个文件是本项目里唯一一处「会写入用户凭证」的地方，所以：
 *
 *   1. 文件权限 0600（只有本人可读）。默认的 0644 在同机多用户下是敞开的。
 *   2. 落在 `data/` 下，而 `data/` 已经在 .gitignore 里；.gitignore 里另外
 *      又显式加了一行 `data/auth/`，见那里的注释 —— 防的是有人哪天把 data/
 *      从 ignore 里拿掉（比如为了共享一份报告）。
 *   3. **任何 API 都不返回 cookie 值**。状态接口只回答「有没有、什么时候存的、
 *      叫什么名字」。`/api/auth/zhihu` 的 GET 因此必须过一遍这里导出的
 *      `publicAccount()`，而不是直接把 account 丢出去。
 *   4. 不逆向签名、不伪造请求头（见 `./cookies.ts` 的文件头）。
 */

import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { AUTH_DIR } from "@/core/paths";
import type { StoredAccount, StoredCookie } from "./cookies";
import { accountSiteFor, cookieHeader, isAccountExpired } from "./cookies";

/** 站点名做文件名。只允许小写字母数字，避免 `../` 之类的路径穿越。 */
function accountFile(site: string): string {
  if (!/^[a-z0-9]+$/.test(site)) throw new Error(`非法的站点名：${site}`);
  return path.join(AUTH_DIR, `${site}.json`);
}

/**
 * 内存缓存。
 *
 * 抓一次有几十篇文档，每篇都会问一次「这个 URL 要不要带 cookie」。每次都
 * 读一遍磁盘既慢又没必要 —— 而且这些文件在两次写入之间不会变（唯一会改它
 * 的就是本模块自己的 save/clear）。
 *
 * 缓存的是 **Promise** 而不是结果：并发抓取会在同一瞬间发起几十次查询，
 * 缓存结果的话它们会各自读到一次磁盘。缓存 Promise 让它们共享同一次读取。
 */
const cache = new Map<string, Promise<StoredAccount | null>>();

function readAccount(site: string): Promise<StoredAccount | null> {
  let p = cache.get(site);
  if (!p) {
    p = loadFromDisk(site);
    cache.set(site, p);
  }
  return p;
}

async function loadFromDisk(site: string): Promise<StoredAccount | null> {
  try {
    const text = await readFile(accountFile(site), "utf8");
    const parsed = JSON.parse(text) as StoredAccount;
    if (!parsed || !Array.isArray(parsed.cookies)) return null;
    return parsed;
  } catch {
    /*
      读不到就是「没登录」。刻意不区分「文件不存在」和「文件坏了」：
      对这个模块的调用方来说两者的下一步动作完全一样 —— 不带 cookie 去抓，
      拿到 403，然后由 `limitations.ts` 告诉用户「重新扫码」。
      但**坏文件不会被删**，以免一次偶然的读写中断把用户的登录态抹掉。
    */
    return null;
  }
}

/** 存一个账号。写盘用 0600。 */
export async function saveAccount(account: StoredAccount): Promise<void> {
  await mkdir(AUTH_DIR, { recursive: true });
  const file = accountFile(account.site);
  await writeFile(file, JSON.stringify(account, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  cache.set(account.site, Promise.resolve(account));
}

/** 退出登录：删文件 + 清缓存。**不是**「标记失效」，是真的删掉凭证。 */
export async function clearAccount(site: string): Promise<void> {
  cache.delete(site);
  await rm(accountFile(site), { force: true });
}

export async function loadAccount(site: string): Promise<StoredAccount | null> {
  return readAccount(site);
}

/**
 * 这个 URL 该带的 Cookie 请求头；没有就返回 undefined。
 *
 * 两处判据合起来才决定「发不发」：`accountSiteFor` 说这个 URL 属于哪个可登录
 * 站点，`cookieHeader` 说这批 cookie 里哪些还没过期。
 */
export async function cookieHeaderFor(url: string): Promise<string | undefined> {
  const site = accountSiteFor(url);
  if (!site) return undefined;
  const account = await readAccount(site);
  if (!account) return undefined;
  const header = cookieHeader(account.cookies);
  return header || undefined;
}

/**
 * 这个 URL 该带进浏览器的 cookie 原始对象；给 Playwright 的 `addCookies` 用。
 *
 * 为什么不让浏览器也走「Cookie 请求头」那条路：`context.route()` 改写请求头
 * 只能改到能被改写的部分，而带上登录态之后页面里的 XHR 也必须一起带上 ——
 * 那些是页面自己发的，只能靠 `addCookies` 把 cookie 灌进浏览器。
 */
export async function cookiesFor(url: string): Promise<StoredCookie[]> {
  const site = accountSiteFor(url);
  if (!site) return [];
  const account = await readAccount(site);
  if (!account) return [];
  const now = Date.now();
  return account.cookies.filter(
    (c) => c.expires === undefined || c.expires < 0 || c.expires * 1000 > now,
  );
}

/**
 * 给界面看的账号状态。**绝不含 cookie 值**。
 *
 * 这个函数存在的唯一理由是让「不要把凭证发给浏览器」变成一个**结构性**的
 * 约束，而不是「记得别写错」：API 路由手上有 `StoredAccount`，但它不该原样
 * 返回，所以这里给一个明确的、安全的形状。
 */
export interface PublicAccount {
  site: string;
  displayName?: string;
  savedAt: string;
  cookieCount: number;
  /** 已经整体过期（界面据此提示「重新扫码」）。 */
  expired: boolean;
}

export function publicAccount(account: StoredAccount): PublicAccount {
  return {
    site: account.site,
    displayName: account.displayName,
    savedAt: account.savedAt,
    cookieCount: account.cookies.length,
    expired: isAccountExpired(account),
  };
}

/** 某个站点当前登录了吗（给 `limitations.ts` 的调用方用）。 */
export async function isLoggedIn(site: string): Promise<boolean> {
  const account = await readAccount(site);
  return account !== null && !isAccountExpired(account);
}

/**
 * 一批站点里，哪些是登录着的。抓取和导出都要问同一个问题，所以只有这一份。
 *
 * **只问传进来的那些站点**：一轮里没出现过知乎，就不该去读知乎的凭证文件。
 * 既没必要，也让「到底谁读过凭证」这件事保持可 grep。
 */
export async function loggedInFor(
  sites: readonly string[],
): Promise<Record<string, boolean>> {
  const unique = [...new Set(sites)];
  const entries = await Promise.all(
    unique.map(async (s) => [s, await isLoggedIn(s)] as const),
  );
  return Object.fromEntries(entries);
}
