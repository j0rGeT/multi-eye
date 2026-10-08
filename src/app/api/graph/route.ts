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
   */
  const usable = session.documents.filter(
    (d) => d.extractMethod !== "raw" && d.wordCount >= 30,
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
