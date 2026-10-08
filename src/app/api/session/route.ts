import type { NextRequest } from "next/server";
import { listSessions, loadSession } from "@/core/store";

// 不导出 runtime：Next 16 里 'nodejs' 已是默认值（Edge 废弃），文档要求移除该导出。
export const dynamic = "force-dynamic";

/**
 * 读取会话。
 *
 *   GET /api/session?id=X   取回整份会话（主题、结果、正文、图）
 *   GET /api/session        列出最近的会话
 *
 * 存在的理由只有一个：**刷新页面之后要能接着用**。搜索、抓取、构图、下载的
 * 产物本来就在服务端，下载任务更是自己跑自己的、与浏览器无关；但页面状态
 * 只活在内存里，刷新一次就全没了 —— 于是「异步下载」变成「别关这个标签页」。
 * 这个接口让前端在挂载时把会话重新读回来。
 */
export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id")?.trim();

  if (!id) {
    return Response.json(
      { sessions: await listSessions() },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const session = await loadSession(id);
  if (!session) {
    return Response.json({ error: `会话不存在：${id}` }, { status: 404 });
  }

  return Response.json({ session }, { headers: { "Cache-Control": "no-store" } });
}
