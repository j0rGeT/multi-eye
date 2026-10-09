import type { NextRequest } from "next/server";
import { renderTopologySvg } from "@/core/export/svg";
import { loadSession } from "@/core/store";

// 不导出 runtime：Next 16 里 'nodejs' 已是默认值（Edge 废弃），文档要求移除该导出。
export const dynamic = "force-dynamic";

/**
 * 读一个数字型 query 参数。
 *
 * 必须显式判 `null`：`Number(params.get("w"))` 在参数缺失时得到的是
 * `Number(null) === 0`，而 `Number.isFinite(0)` 是 true —— 于是「没传 w」
 * 会被当成「w=0」，再被 clamp 成最小值 400。默认值 1600 永远不会生效。
 * 这个坑实测踩过一次，图小了一圈还以为是布局算法的问题。
 */
function numParam(
  params: URLSearchParams,
  key: string,
  fallback: number,
  min?: number,
  max?: number,
): number {
  const raw = params.get(key);
  if (raw === null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.round(n);
  if (min !== undefined && rounded < min) return min;
  if (max !== undefined && rounded > max) return max;
  return rounded;
}

/**
 * 把会话里的拓扑图导出成图片。
 *
 *   GET /api/export/image?sessionId=X&format=svg
 *
 * 只支持 SVG，这是有意的：Cytoscape 在服务端拿不到渲染结果（见
 * `core/export/svg.ts` 开头那段实测记录），而这台机器上也没有 canvas / sharp
 * 之类的原生依赖。SVG 由我们自己从坐标画出来，不存在这个问题。
 *
 * 参数：
 *   sessionId  必填
 *   w          画布宽度，默认 1600
 *   seed       固定布局随机数，让同一会话每次生成同一张图
 *   docs=0     不画资料节点（节点多的时候图会糊）
 *   download=1 带上 Content-Disposition，浏览器直接下载而不是在标签页里打开
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;

  const sessionId = params.get("sessionId")?.trim();
  if (!sessionId) {
    return Response.json({ error: "缺少 sessionId" }, { status: 400 });
  }

  const format = (params.get("format") ?? "svg").toLowerCase();
  if (format !== "svg") {
    return Response.json(
      { error: `不支持的格式：${format}。服务端只能出 SVG —— Cytoscape 在无头环境里渲染不了位图` },
      { status: 400 },
    );
  }

  const session = await loadSession(sessionId);
  if (!session) {
    return Response.json({ error: `会话不存在：${sessionId}` }, { status: 404 });
  }

  const graph = session.graph;
  if (!graph) {
    return Response.json(
      { error: "该会话还没有构建知识拓扑" },
      { status: 409 },
    );
  }

  const width = numParam(params, "w", 1600, 400, 4000);
  const seed = numParam(params, "seed", 42);

  const svg = renderTopologySvg(graph, {
    width,
    seed,
    showDocuments: params.get("docs") !== "0",
    /*
      说清楚「抓了多少」和「有多少进了这张图」是两件事。
      抓取层会把拿不到正文的资料降级成摘要，构图层只采用够长的那些 ——
      只写「12 篇资料」会让人以为图里那 3 个方块就是全部，看着像丢了 9 篇。
    */
    caption: `来自会话 ${session.topic.id} · 主题「${session.topic.query}」· ${session.documents.length} 篇抓取结果中 ${graph.stats.docCount} 篇进入拓扑`,
  });

  const headers: Record<string, string> = {
    "Content-Type": "image/svg+xml; charset=utf-8",
    "Cache-Control": "no-store",
    /*
      把画进去的数量用响应头报出来。
      调用方（examples/graph-image.mjs）想知道「这张图里有多少概念、多少资料」，
      而正文是不透明的 SVG —— 从里面数 <rect> 会把图例色块也数进去。
      与其在调用方做脆弱的正则猜测，不如这里直接给出准确值。
    */
    "X-Topology-Nodes": String(graph.nodes.length),
    "X-Topology-Edges": String(graph.edges.length),
    "X-Topology-Documents": String(
      graph.nodes.filter((n) => n.kind === "document").length,
    ),
    "X-Topology-Concepts": String(
      graph.nodes.filter((n) => n.kind !== "document").length,
    ),
  };

  if (params.get("download") === "1") {
    const name = `${session.topic.query || "topology"}-拓扑.svg`;
    headers["Content-Disposition"] =
      `attachment; filename="topology.svg"; ` +
      `filename*=UTF-8''${encodeURIComponent(name)}`;
  }

  return new Response(svg, { headers });
}
