import type { NextRequest } from "next/server";
import { publicAccount, clearAccount, loadAccount, isLoggedIn } from "@/core/auth/store";
import { loginZhihu, type LoginEvent } from "@/core/auth/zhihu";
import { sseResponse } from "@/core/sse";

// 不导出 runtime：Next 16 里 'nodejs' 已是默认值（Edge 废弃），文档要求移除该导出。
export const dynamic = "force-dynamic";
/** 扫码要留够时间：真人从掏出手机到扫完，三分钟是宽松但不夸张的上限。 */
export const maxDuration = 300;

/**
 * 知乎登录态：查状态 / 开始扫码 / 退出登录。
 *
 * ── 三条必须守住的规矩 ──
 *
 *  1. **GET 永不返回 cookie 值**。返回的是 `publicAccount()` 那个形状，它里面
 *     结构性地没有 cookie 字段（见 `core/auth/store.ts`）。这不是靠自觉 ——
 *     是让「泄露凭证」这件事需要先改类型才能发生。
 *  2. POST 走 SSE 而不是一次性请求：扫码要几十秒，中间「浏览器开了没」
 *     「还在等你扫」这些状态必须让用户看得见，否则他会以为点了没反应，
 *     然后再点一次，开出第二个浏览器窗口。
 *  3. DELETE 是真删（`rm` 文件），不是标记失效。
 */

export async function GET() {
  const account = await loadAccount("zhihu");
  /*
    `loggedIn` 的语义是**「抓取时会不会真的带上登录态」**，所以这里直接问
    `isLoggedIn()` —— 也就是抓取侧用的同一个函数。过期的账号它算未登录，
    界面于是说「已过期，重新扫码」，与真实行为一致。

    写成 `account !== null` 就会分叉：界面说「已登录」，抓取按「没登录」
    处理，用户以为生效了，实际仍然 403。
  */
  const loggedIn = await isLoggedIn("zhihu");
  return Response.json({
    site: "zhihu",
    loggedIn,
    // 注意是 publicAccount(account) 而不是 account —— 见上面第 1 条
    account: account ? publicAccount(account) : null,
    hint:
      "扫码登录后，抓取知乎的公开页面时会带上你自己的登录态。" +
      "cookie 只存在本机 data/auth/，不入库、不上传。不登录也能用，只是知乎那几篇只有搜索摘要。",
  });
}

export async function POST(req: NextRequest) {
  return sseResponse<LoginEvent>(async (emit) => {
    await loginZhihu({
      onEvent: emit,
      signal: req.signal,
      /*
        客户端断开时 `req.signal` 会 abort，`loginZhihu` 的轮询据此收手，
        浏览器在 finally 里关掉。**不然**：用户关掉页面，那个 chromium 窗口
        会一直开着等一个永远不会来的扫码。
      */
    });
  }, req.signal);
}

export async function DELETE() {
  await clearAccount("zhihu");
  return Response.json({ ok: true, loggedIn: false });
}
