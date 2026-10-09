/**
 * 图构建的统一入口。
 *
 * 上层（API 路由、导出、下载）只认这个函数和它返回的 GraphModel，不关心
 * 背后是启发式还是 LLM。这也是两条路径能并存的原因：契约是同一个。
 *
 * 选择策略：配了 LLM_API_KEY 就走 LLM，但**任何失败都自动降级**回
 * 启发式并记录原因 —— 用户不该因为一次 API 限流或网络抖动就拿不到图。
 */

import type { Document, GraphModel, Topic } from "@/core/types";
import { hasLLM } from "@/core/env";
import { buildHeuristicGraph } from "./heuristic";
import { buildLlmGraph } from "./llm";

export interface BuildOptions {
  signal?: AbortSignal;
  /** 强制指定路径，用于对比两条路径的效果。 */
  force?: "heuristic" | "llm";
  /**
   * Louvain 分辨率。省略则用 heuristic 的默认值。
   * 语料越杂、越需要切细，就调得越高。
   */
  resolution?: number;
}

export async function buildGraph(
  topic: Topic,
  docs: Document[],
  opts: BuildOptions = {},
): Promise<GraphModel> {
  const wantLLM = opts.force === "llm" || (opts.force !== "heuristic" && hasLLM());

  if (wantLLM) {
    if (!hasLLM()) {
      // force:"llm" 但没配 key。如实说，别装作走了 LLM
      return await fallback(topic, docs, opts, "未配置 LLM_API_KEY");
    }
    try {
      return await buildLlmGraph(topic, docs, { signal: opts.signal });
    } catch (err) {
      // 限流、超时、网络抖动、结构化输出解析失败 —— 全都退回启发式。
      // 用户要的是「拿到一张图」，不是「拿到一张因为 429 而没生成的图」，
      // 但降级原因必须带出去，否则他不知道自己看的是统计图。
      return await fallback(topic, docs, opts, llmErrorReason(err));
    }
  }

  return buildHeuristicGraph(topic, docs, {
    signal: opts.signal,
    resolution: opts.resolution,
  });
}

/**
 * 把 LLM 侧的失败翻译成一句能读的原因。
 *
 * 直接把 SDK 的错误抛给用户，界面上会是「529 overloaded」这种只有我们知道
 * 该怎么处理的话；而带上分类之后，「超额了」和「网断了」是两种不同的动作。
 */
function llmErrorReason(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/abort/i.test(msg)) return "LLM 调用被取消";
  if (/\b(429|rate.?limit|overloaded|529)\b/i.test(msg)) {
    return `LLM 限流或过载，已降级：${msg}`;
  }
  if (/\b(401|403|invalid.*api.*key|authentication)\b/i.test(msg)) {
    return `LLM_API_KEY 无效，已降级：${msg}`;
  }
  if (/timeout|ETIMEDOUT|ECONNRESET|fetch failed/i.test(msg)) {
    return `LLM 调用网络失败，已降级：${msg}`;
  }
  return `LLM 构图失败，已降级：${msg}`;
}

async function fallback(
  topic: Topic,
  docs: Document[],
  opts: BuildOptions,
  reason: string,
): Promise<GraphModel> {
  const graph = await buildHeuristicGraph(topic, docs, {
    signal: opts.signal,
    resolution: opts.resolution,
  });
  // 把降级原因写进 stats，让前端能如实告诉用户「为什么没走上 LLM」，
  // 而不是默默给出一张统计图让人以为模型没生效
  return {
    ...graph,
    stats: { ...graph.stats, llmFallbackReason: reason },
  };
}
