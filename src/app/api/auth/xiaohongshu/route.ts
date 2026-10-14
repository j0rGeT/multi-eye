import type { NextRequest } from "next/server";
import { publicAccount, clearAccount, loadAccount, isLoggedIn } from "@/core/auth/store";
import { loginXiaohongshu, type LoginEvent } from "@/core/auth/xiaohongshu";
import { sseResponse } from "@/core/sse";

// 不导出 runtime：Next 16 里 'nodejs' 已是默认值（Edge 废弃），文档要求移除该导出。
export const dynamic = "force-dynamic";
/** 扫码要留够时间：真人从掏出手机到扫完，三分钟是宽松但不夸张的上限。 */
export const maxDuration = 300;

/**
 * 小红书登录态：查状态 / 开始扫码 / 退出登录。
 *
 * 与 `/api/auth/zhihu` 同构，三条规矩也一字不差：
 *
 *  1. **GET 永不返回 cookie 值**（走 `publicAccount()`，它结构上没有 cookie 字段）。
 *  2. POST 走 SSE：扫码要几十秒，中间状态必须让用户看得见。
 *  3. DELETE 是真删文件，不是标记失效。
 */
export async function GET() {
  const account = await loadAccount("xiaohongshu");
  const loggedIn = await isLoggedIn("xiaohongshu");
  return Response.json({
    site: "xiaohongshu",
    loggedIn,
    account: account ? publicAccount(account) : null,
    hint:
      "小红书网页端对未登录访问一律跳登录页，笔记正文抓不到。" +
      "扫码登录后，抓取公开笔记时会带上你自己的登录态。" +
      "cookie 只存在本机 data/auth/，不入库、不上传。不登录也能用，只是正文多半只有搜索摘要。",
  });
}

export async function POST(req: NextRequest) {
  return sseResponse<LoginEvent>(async (emit) => {
    await loginXiaohongshu({
      onEvent: emit,
      signal: req.signal,
    });
  }, req.signal);
}

export async function DELETE() {
  await clearAccount("xiaohongshu");
  return Response.json({ ok: true, loggedIn: false });
}
