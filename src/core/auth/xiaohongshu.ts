/**
 * 小红书扫码登录。
 *
 * ── 为什么需要它 ──
 *
 * 小红书网页端对**未登录**访问是硬拦截：`/explore` 一律 302 到登录页，笔记详情
 * 正文拿不到，抓取层只能退化成搜索摘要 —— 用户搜「Mooncake 技术资料」回来的
 * 结果里能提取正文的寥寥无几，这是「抓取的数据都很差」的直接原因之一。
 *
 * ── 判据是量过的 ──
 *
 * 未登录时 `context.cookies("https://www.xiaohongshu.com")` 拿到的是：
 *
 *   acw_tc, abRequestId, ets, webBuild, a1, webId, websectiga,
 *   sec_poison_id, xsecappid, loadts, gid
 *
 * **没有 `web_session`** —— 而 `web_session` 就是小红书网页端的登录态
 * （访客只有 `a1` / `webId` 这类匿名 id）。所以「等 `web_session` 出现」
 * 是一个可判定的成功条件，不是猜的。
 *
 * 同一次实测确认登录页（`https://www.xiaohongshu.com/login`）**默认就展示二维码**
 * （页面上有 `img.qrcode-img`，并且明写「可用小红书或微信扫码」），所以不需要
 * 点任何「切换到扫码」的标签页。
 *
 * ── 红线照旧 ──
 *
 * 只打开小红书**自己的**登录页、走它自己的前端，不碰密码与验证码；`x-s` /
 * `x-t` 那套签名**一个字节都不逆向**。拿到的只是浏览器正常登录后本来就有的
 * cookie，抓的还是公开页面。
 */

import { runQrLogin, type LoginEvent, type LoginResult } from "./qrlogin";

export type { LoginEvent, LoginResult };

/** 小红书登录态 cookie 的名字。见文件头那一段实测记录。 */
export const XHS_AUTH_COOKIE = "web_session";

const LOGIN_URL = "https://www.xiaohongshu.com/login";

const SPEC = {
  site: "xiaohongshu",
  signinUrl: LOGIN_URL,
  cookieDomain: "https://www.xiaohongshu.com",
  authCookie: XHS_AUTH_COOKIE,
  scanHint:
    "请在弹出的窗口里用小红书 App 或微信扫码。登录成功后窗口会自己关掉。",
  doneNamed: (name: string) => `已登录小红书：${name}`,
  doneUnnamed: "已登录小红书（没能读到昵称，不影响抓取）",
  displayNameSelectors: [
    ".user.side-bar-component .name",
    ".user-name",
    ".name",
    "img.user-avatar",
    ".avatar img",
  ],
} as const;

/**
 * 打开有窗口的浏览器等用户扫码，成功后把 cookie 存到本机 `data/auth/xiaohongshu.json`。
 */
export function loginXiaohongshu(opts: {
  onEvent?: (e: LoginEvent) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
} = {}): Promise<LoginResult> {
  return runQrLogin(SPEC, opts);
}
