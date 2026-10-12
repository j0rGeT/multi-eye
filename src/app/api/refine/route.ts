import type { NextRequest } from "next/server";
import type { RefinementRecord, SearchPlan, SearchResult } from "@/core/types";
import { refineSession } from "@/core/search/refine";
import { normalizeUrl } from "@/core/search/normalize";
import { loadSession, saveSession } from "@/core/store";
import { config } from "@/core/env";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface RefineBody {
  sessionId?: string;
}

/**
 * 抓取后的“整理 + 补搜”入口。
 *
 * 用普通 JSON 而不是 SSE：这一轮的关键产物是“整理摘要 + 新增结果”，用户
 * 可以等它一次性返回；站点级的逐条流式结果仍由 `/api/search` 负责。
 */
export async function POST(req: NextRequest) {
  let body: RefineBody;
  try {
    body = (await req.json()) as RefineBody;
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
  if (session.documents.length === 0) {
    return Response.json({ error: "请先抓取正文，再进行整理与补搜" }, { status: 409 });
  }

  const maxDepth = Math.max(
    1,
    Math.min(10, session.searchOptions?.depth ?? config.searchDepth),
  );

  const current = session.refinements?.length ?? 0;
  if (current >= maxDepth) {
    return Response.json(
      {
        done: true,
        iteration: current,
        maxIterations: maxDepth,
        message: `已达到 ${maxDepth} 轮补搜上限`,
      },
      { status: 200 },
    );
  }

  try {
    const { record, results, plan, logs } = await refineSession(session, {
      signal: req.signal,
    });

    const existing = new Map(
      session.results.map((result) => [normalizeUrl(result.url), result]),
    );
    for (const result of results) {
      existing.set(normalizeUrl(result.url), result);
    }
    const merged = [...existing.values()];

    const refinements = [...(session.refinements ?? []), record];
    await saveSession({
      ...session,
      results: merged,
      plan,
      providerLog: [...session.providerLog, ...logs],
      refinements,
      topic: { ...session.topic, updatedAt: new Date().toISOString() },
    });

    return Response.json({
      record,
      results,
      plan,
      total: merged.length,
      iteration: record.iteration,
      maxIterations: maxDepth,
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export type RefineResponse = {
  record: RefinementRecord;
  results: SearchResult[];
  plan: SearchPlan;
  total: number;
  iteration: number;
  maxIterations: number;
};
