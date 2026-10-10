/**
 * 登录态 cookie 的**纯函数层**：哪台主机该带、请求头怎么拼。
 *
 * 为什么单独拆出来、且**零 import**：
 *
 *  1. 这是整套登录功能里**最危险的一段**。「把 cookie 发给谁」写错一个字符，
 *     就是把自己的知乎身份送给一个不相关的域名。所以它必须能被 `examples/e2e.mjs`
 *     直接引着跑一组反例 —— 尤其是 `zhihu.com.evil.com`、`notzhihu.com` 这类
 *     看起来像但**不是**的域名。
 *  2. 读写磁盘那半在 `./store` 里，会 import `node:fs`。混在一起的话这里就没法
 *     被裸 node 加载了，反例也就没法钉住。
 *
 * ── 一条必须先说清楚的边界 ──
 *
 * 这里**不碰签名算法**。知乎前端请求带的 `x-zse-93` / `x-zse-96` 之类是本项目
 * 从第一天起就明确不逆向的东西（见 README 的「不做的事」）。本模块做的只有
 * 一件事：把用户**自己扫码登录**拿到的那串 cookie 原样存下来、在请求页面的
 * 时候原样带上。页面是公开页面，我们不伪造任何请求签名。
 */

/** 一个 cookie 的最小完整表示。字段名与 Playwright 的 `addCookies` 对齐。 */
export interface StoredCookie {
  name: string;
  value: string;
  /** 前导点表示「该域及其子域」，与浏览器语义一致。 */
  domain: string;
  path: string;
  /** Unix 秒。-1 表示会话 cookie。 */
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

export interface StoredAccount {
  /** 与 `SiteKey` 同名，例如 "zhihu"。 */
  site: string;
  /** 从页面上读到的昵称，**只为界面显示**，不参与任何抓取判断。 */
  displayName?: string;
  cookies: StoredCookie[];
  /** ISO 时间。 */
  savedAt: string;
}

/**
 * 允许携带登录态的站点。**只有这一张表**。
 *
 * 加一个站点进这张表 = 允许把那个站点的 cookie 发给它的所有子域。所以这张表
 * 要短、要显式、要有理由 —— 不要写成「凡是存过的账号都发」那种自动匹配。
 */
const AUTH_SITES: Record<string, string> = {
  "zhihu.com": "zhihu",
};

/** 这张表里的站点名，供界面与文档展示（顺序稳定，便于断言）。 */
export function authSites(): { suffix: string; site: string }[] {
  return Object.entries(AUTH_SITES).map(([suffix, site]) => ({ suffix, site }));
}

/**
 * 这个 URL 属于哪个可登录站点；不属于任何一个是 `null`。
 *
 * 匹配规则刻意写死成「等于该域，或是它的子域」：
 *
 *   https://www.zhihu.com/question/1      → zhihu   （子域）
 *   https://zhihu.com/                    → zhihu   （本域）
 *   https://zhuanlan.zhihu.com/p/1        → zhihu   （子域）
 *   https://notzhihu.com/                 → null    （不是后缀而是另一个域名）
 *   https://zhihu.com.evil.com/           → null    （后缀被放在前面）
 *   https://zhihu.com.cn/                 → null
 *
 * 注意 `zhihu.com.evil.com` 这一条：用 `includes` 或 `endsWith("zhihu.com")`
 * 之外的任何偷懒写法都会把它放过去。（`endsWith` 本身也不够 —— 它同样会
 * 放 `evilzhihu.com` 进去，所以本域判断必须同时要「前面是点」或「整串相等」。）
 */
export function accountSiteFor(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
  for (const [suffix, site] of Object.entries(AUTH_SITES)) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return site;
  }
  return null;
}

/**
 * 把 cookie 数组拼成请求头的值。
 *
 * 过滤掉**已经过期**的那些：过期的 cookie 留着只会让请求头变长，而且服务端
 * 看到一串过期 cookie 有时会走「半登录」分支，返回一个比 403 更难看懂的结果
 * （比如登录墙 HTML 而不是 403）。
 *
 * 不过滤域名 —— 能走到这里的 cookie 本来就只可能来自该站点的登录流程，
 * 而域名过滤是 `accountSiteFor` 的职责（发送前已经判过一次）。两处都判
 * 只会让「为什么没带上」变得难查。
 *
 * `now` 可注入，因为「过期」这件事必须能被离线断言（不能靠等）。
 */
export function cookieHeader(
  cookies: readonly StoredCookie[],
  now: number = Date.now(),
): string {
  const nowSec = Math.floor(now / 1000);
  return cookies
    .filter((c) => c.name && typeof c.value === "string")
    .filter((c) => c.expires === undefined || c.expires < 0 || c.expires > nowSec)
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

/** 这批 cookie 里最晚的过期时间（秒）；没有带过期时间的就返回 null。 */
export function latestExpiry(
  cookies: readonly StoredCookie[],
): number | null {
  const times = cookies
    .map((c) => c.expires)
    .filter((e): e is number => typeof e === "number" && e > 0);
  return times.length > 0 ? Math.max(...times) : null;
}

/** 这个账号是不是已经整体过期了（所有带过期的都过了）。界面据此提示重新登录。 */
export function isAccountExpired(
  account: StoredAccount,
  now: number = Date.now(),
): boolean {
  const exp = latestExpiry(account.cookies);
  return exp !== null && exp * 1000 <= now;
}
