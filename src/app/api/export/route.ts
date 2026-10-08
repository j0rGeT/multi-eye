import type { NextRequest } from "next/server";
import { renderMarkdownReport, reportFileName } from "@/core/export/markdown";
import { loadSession, writeReport } from "@/core/store";

// 不导出 runtime：Next 16 里 'nodejs' 已是默认值（Edge 废弃），文档要求移除该导出。
export const dynamic = "force-dynamic";

/**
 * 导出主题报告。
 *
 * 同时做两件事：落盘到 data/sessions/<id>/report.md，并把内容作为下载返回。
 * 两个出口都留是有原因的 —— 文件在磁盘上意味着用户可以自己 diff 两次导出的
 * 差异、丢进 Obsidian 的 vault、或者交给别的工具处理；而下载响应让浏览器里
 * 的一次点击就能拿到结果，不必去翻目录。
 *
 * 参数：
 *   sessionId  必填
 *   mermaid=0  关掉 Mermaid 拓扑图（少数渲染器不认它）
 *   urls=0     不输出站点原始链接
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const sessionId = params.get("sessionId")?.trim();
  if (!sessionId) {
    return Response.json({ error: "缺少 sessionId" }, { status: 400 });
  }

  const session = await loadSession(sessionId);
  if (!session) {
    return Response.json({ error: `会话不存在：${sessionId}` }, { status: 404 });
  }

  if (session.results.length === 0) {
    return Response.json(
      { error: "该会话还没有搜索结果，没有可导出的内容" },
      { status: 409 },
    );
  }

  const now = new Date();
  const markdown = renderMarkdownReport(session, {
    now,
    includeMermaid: params.get("mermaid") !== "0",
    includeUrls: params.get("urls") !== "0",
  });

  // 落盘失败不该让下载也失败：文件系统的问题（磁盘满、权限）与「把报告交给
  // 用户」是两件事，后者更重要。
  let savedTo: string | undefined;
  try {
    savedTo = await writeReport(sessionId, markdown);
  } catch {
    savedTo = undefined;
  }

  const filename = reportFileName(session.topic.query, now);

  return new Response(markdown, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      // 文件名是中文，必须同时给 filename*（RFC 5987）：
      // 只给 filename= 的话非 ASCII 会变成乱码或被直接丢掉。
      "Content-Disposition":
        `attachment; filename="report.md"; ` +
        `filename*=UTF-8''${encodeURIComponent(filename)}`,
      // 落盘路径回给调用方，前端可以据此提示「已保存到 …」
      ...(savedTo ? { "X-Saved-To": savedTo } : {}),
      "Cache-Control": "no-store",
    },
  });
}
