import type { NextRequest } from "next/server";
import { buildPackage } from "@/core/export/zip";
import { loadSession } from "@/core/store";

// 不导出 runtime：Next 16 里 'nodejs' 已是默认值（Edge 废弃），文档要求移除该导出。
export const dynamic = "force-dynamic";

/**
 * 打包下载：把一次调研压成 ZIP，一个链接直接拿走。
 *
 * ── 为什么不挂在 /api/export 上 ──
 *
 * `/api/export` 的契约是「返回这份**报告**的 Markdown」，e2e 也按那个契约
 * 断言。给它加一个返回 ZIP 的分支，会让「同一个 URL 可能回两种东西」，
 * 两个契约互相模糊。宁可多一个路由，各自说清楚自己是什么。
 *
 * ── 参数 ──
 *
 *   sessionId  必填
 *
 * **不需要先跑下载任务**：正文与报告是 `session.json` 的纯函数，现场生成。
 * 只有配图必须来自 `assets/`，没下过就跳过并在包里说明（见 `X-Images-Missing`）。
 */
export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get("sessionId")?.trim();
  if (!sessionId) {
    return Response.json({ error: "缺少 sessionId" }, { status: 400 });
  }

  const session = await loadSession(sessionId);
  if (!session) {
    return Response.json({ error: `会话不存在：${sessionId}` }, { status: 404 });
  }

  const result = await buildPackage(session, sessionId);
  if (!result.ok) {
    return Response.json({ error: result.error }, { status: result.status });
  }

  return new Response(result.zip as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/zip",
      // 文件名是中文，必须同时给 filename*（RFC 5987）：
      // 只给 filename= 的话非 ASCII 会变成乱码或被直接丢掉。
      "Content-Disposition":
        `attachment; filename="package.zip"; ` +
        `filename*=UTF-8''${encodeURIComponent(result.filename)}`,
      /*
        三个计数回给前端。放在头里而不是让客户端自己算「优质有几篇」——
        判据只有一处定义（`quality.ts` 的 `isPackageWorthy`），界面照抄一份
        迟早会在某个边界上对不上。前端拿这几个数直接显示即可。
      */
      "X-Package-Included": String(result.included),
      "X-Package-Excluded": String(result.excluded),
      "X-Images-Missing": String(result.imagesMissing),
      "Cache-Control": "no-store",
    },
  });
}
