/**
 * 图构建的统一入口。
 *
 * 上层（API 路由、导出、下载）只认这个函数和它返回的 GraphModel，不关心
 * 背后是启发式还是 LLM。这也是两条路径能并存的原因：契约是同一个。
 *
 * 选择策略：配了 ANTHROPIC_API_KEY 就走 LLM，但**任何失败都自动降级**回
 * 启发式并记录原因 —— 用户不该因为一次 API 限流或网络抖动就拿不到图。
 */

import type { Document, GraphBuilder, GraphModel, Topic } from "@/core/types";
import { hasLLM } from "@/core/env";
import { buildHeuristicGraph } from "./heuristic";

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
    // TODO(P6)：接线 LlmGraphBuilder。此刻显式降级并说明原因，
    // 而不是装作「已经走了 LLM」——「为什么图看起来是统计式的」必须可回答。
    return await fallback(topic, docs, opts, "LLM 构图路径尚未接入");
  }

  return buildHeuristicGraph(topic, docs, {
    signal: opts.signal,
    resolution: opts.resolution,
  });
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
