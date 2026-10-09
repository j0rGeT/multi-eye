import type { NextRequest } from "next/server";
import { buildGraph } from "@/core/graph/build";
import { tokenizerBackend } from "@/core/graph/tokenize";
import { loadSession, saveSession } from "@/core/store";

// 不导出 runtime：Next 16 里 'nodejs' 已是默认值（Edge 废弃），文档要求移除该导出。
export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface GraphBody {
  sessionId?: string;
  /** "heuristic" | "llm"，省略则按是否配了 API key 自动选。 */
  force?: "heuristic" | "llm";
  /**
   * Louvain 分辨率，调高会切出更多、更小的主题簇。
   *
   * 开放成请求参数而不是写死在代码里：合适的粒度取决于语料 ——
   * 一个宽泛主题（"露营"）和一个具体主题（"某款帐篷的搭建方式"）需要的粒度
   * 完全不同，而判据是主观的「这簇读起来是不是一个主题」，只能由人调。
   */
  resolution?: number;
}

/**
 * 为一次会话构建知识拓扑。
 *
 * 为什么不做成 SSE：构图是「一次性产出」，中间态（分词进度、TF-IDF 进度）
 * 对用户没有意义，而且整个过程通常是几秒到几十秒。相比之下搜索结果逐条
 * 冒出来是有价值的 —— 所以那边用流式，这边用普通 JSON。
 *
 * 前置条件：会话里必须有已抓取的正文。只有搜索结果（摘要）也能构图，但
 * 摘要太短，TF-IDF 会退化成按标题匹配。所以这里明确提示用户先去抓取。
 */
/**
 * 分辨率夹在合理区间内。
 *
 * 0.1 会退化成「所有词一簇」，10 以上会碎成几十个只有一两个词的簇 ——
 * 两者都不报错，只是产出一张没用的图，所以在这里挡住比事后排查划算。
 */
function clampResolution(v: number | undefined): number | undefined {
  if (v === undefined || !Number.isFinite(v)) return undefined;
  return Math.min(4, Math.max(0.4, v));
}

export async function POST(req: NextRequest) {
  let body: GraphBody;
  try {
    body = (await req.json()) as GraphBody;
  } catch {
    return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const sessionId = body.sessionId?.trim();
  if (!sessionId) {
    return Response.json({ error: "缺少 sessionId" }, { status: 400 });
  }

  const session = await loadSession(sessionId);
  if (!session) {
    return Response.json({ error: `会话不存在：${sessionId}` }, { status: 404 });
  }

  /**
   * 只用真正抓到正文的文档构图。
   *
   * extractMethod 为 'raw' 的文档正文就是搜索摘要（一两句话），把它们放进
   * 语料会同时污染 IDF 和共现：摘要里的词会被当成「这篇文档的内容」，而
   * 实际上它只是搜索页的片段。宁可图小一点，也不要一张由摘要撑起来的假图。
   *
   * **`!d.error` 这一条是 P11 补上的。** 光看 `extractMethod` 不够：抓取链里
   * 有好几处是「保留了抓到的文本，但明确标了失败」—— 比如 B 站视频只有简介
   * 没有字幕（`bilibili-api` + error），或者抽到的是导航位（`raw` + error）。
   * 它们的 `extractMethod` 不是 `raw`，光靠上面那个条件会照样混进语料。
   *
   * 这里刻意**不**改用 `bodyGrade === "full"`：那会把 `thin`（120~300 字、
   * 确实是正文只是短）的文档也一起挡在图外，比现状更激进。带 error 才是
   * 「这篇的内容不可信」的准确判据。
   */
  const usable = session.documents.filter(
    (d) => !d.error && d.extractMethod !== "raw" && d.wordCount >= 30,
  );

  if (usable.length === 0) {
    return Response.json(
      {
        error:
          session.documents.length === 0
            ? "该会话还没有抓取正文，请先执行抓取"
            : `已抓取的 ${session.documents.length} 篇里没有一篇拿到足够正文（都退化为搜索摘要了），无法构图`,
        documents: session.documents.length,
        usable: 0,
      },
      { status: 409 },
    );
  }

  try {
    const graph = await buildGraph(session.topic, usable, {
      signal: req.signal,
      force: body.force,
      resolution: clampResolution(body.resolution),
    });

    await saveSession({
      ...session,
      topic: { ...session.topic, updatedAt: new Date().toISOString() },
      graph,
    });

    return Response.json({
      graph,
      // 用的哪套分词，直接暴露出来 —— 分词是这条链最容易静默降级的地方
      tokenizer: await tokenizerBackend(),
      usedDocuments: usable.length,
      ignoredDocuments: session.documents.length - usable.length,
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
