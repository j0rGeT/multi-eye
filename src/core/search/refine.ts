import { z } from "zod";
import type {
  Document,
  ProviderLogEntry,
  RefinementRecord,
  SearchResult,
  Session,
  SearchPlan,
} from "@/core/types";
import { chatJson } from "@/core/llm/chat";
import { hasLLM } from "@/core/env";
import { planQueries } from "./plan";
import { searchAll } from "./orchestrate";
import { normalizeUrl } from "./normalize";

/**
 * 抓取后的“整理 + 补搜”模块。
 *
 * 流程被刻意拆成两段：
 *   1. LLM 只负责从已经抓到的正文里提炼分类、缺口和新的检索词；
 *   2. 搜索仍交给既有的 `searchAll`，沿用站点、相关性判定、质量闸门和去重。
 *
 * 这样“整理”失败只会退化成一次普通补搜，不会让整个会话丢失；补搜轮次
 * 由调用方控制，默认最多三轮，避免模型每轮都把主题带偏。
 */

const MAX_REFINEMENTS = Math.max(1, Number(process.env.SEARCH_REFINE_MAX ?? 3));
const MAX_DOCUMENTS = 20;
const TIMEOUT_MS = Number(process.env.SEARCH_REFINE_TIMEOUT_MS ?? 25_000);
const MAX_TOKENS = Number(process.env.SEARCH_REFINE_MAX_TOKENS ?? 8_192);

const RefineSchema = z.object({
  summary: z.string().describe("用一到三句话概括当前资料已经覆盖了什么"),
  categories: z.array(z.string()).describe("把当前资料整理成不超过 6 个类别"),
  missingAngles: z
    .array(z.string())
    .describe("当前资料还缺少的角度或技术问题，最多 6 个，不要泛泛而谈"),
  queries: z
    .array(z.string())
    .describe("针对缺口生成的补充检索词，最多 8 条，每条是可直接搜索的短查询"),
  avoidPatterns: z
    .array(z.string())
    .describe("当前资料中明显低价值或跑题的标题/内容特征，最多 6 条"),
});

export interface RefineResult {
  record: RefinementRecord;
  results: SearchResult[];
  plan: SearchPlan;
  logs: ProviderLogEntry[];
}

/**
 * 从已抓取正文里整理出一轮补充检索计划。
 *
 * 不抛异常：没有 LLM、超时或结构化输出不合法时，仍然用原始计划补搜一次，
 * 并在记录里写明退化原因。这样“整理模块”不会变成搜索链上的单点故障。
 */
export async function refineSession(
  session: Session,
  opts: { signal?: AbortSignal } = {},
): Promise<RefineResult> {
  const sites = session.topic.sites;
  const docs = selectDocuments(session.documents);
  const originalPlan = session.plan ?? {
    raw: session.topic.query,
    userIntent: session.topic.intent,
    intent: session.topic.intent ?? session.topic.query,
    entity: { name: session.topic.query, aliases: [] },
    disambiguators: [],
    negatives: [],
    relatedTerms: [],
    variants: {},
    source: "lexical" as const,
  };

  const analysis = hasLLM()
    ? await analyzeDocuments(session.topic.query, session.topic.intent, docs, opts.signal)
    : {
        summary: "未配置 LLM_API_KEY，按当前查询计划直接补搜。",
        categories: [],
        missingAngles: [],
        queries: [],
        avoidPatterns: [],
        fallbackReason: "未配置 LLM_API_KEY",
      };

  const refinedIntent = [
    session.topic.intent,
    ...analysis.missingAngles,
    ...analysis.queries,
  ]
    .filter(Boolean)
    .join("；");

  /*
    把整理结果作为新的意图提示再跑一次标准查询分析。这里不直接伪造
    `SearchPlan.variants`：站点改写、实体识别、相关性判定仍然由既有模块负责，
    补搜不会绕开这些质量边界。

    avoidPatterns 走两条路：
      1. 传给 planQueries —— 并进下一轮 negatives，让词法/LLM 相关性判定的
         判据跟着收紧，补搜从源头少捞同类垃圾；
      2. 对本轮补搜结果做本地词法标记 —— 命中的标 value: low，
         下游 /api/fetch 自动跳过。只标记不删除，用户随时能核查。
  */
  const avoidPatterns = [
    ...(session.refinements ?? []).flatMap((r) => r.avoidPatterns ?? []),
    ...analysis.avoidPatterns,
  ]
    .map((s) => s.trim())
    .filter((s) => s.length >= 2)
    .slice(-12);

  const plan = await planQueries(session.topic.query, sites, {
    signal: opts.signal,
    intent: refinedIntent || undefined,
    avoidPatterns: avoidPatterns.length ? avoidPatterns : undefined,
  });

  const existingUrls = new Set(session.results.map((r) => normalizeUrl(r.url)));
  const search = await searchAll({
    topic: session.topic.query,
    plan,
    sites,
    signal: opts.signal,
    timeRange: session.searchOptions?.timeRange,
    sortMode: session.searchOptions?.sortMode,
  });

  const added = applyAvoidPatterns(
    search.results.filter((r) => !existingUrls.has(normalizeUrl(r.url))),
    analysis.avoidPatterns,
  );
  const iteration = (session.refinements?.length ?? 0) + 1;
  const record: RefinementRecord = {
    iteration,
    at: new Date().toISOString(),
    summary: analysis.summary,
    categories: analysis.categories,
    missingAngles: analysis.missingAngles,
    queries: analysis.queries,
    avoidPatterns: analysis.avoidPatterns,
    added: added.length,
    fallbackReason: "fallbackReason" in analysis ? analysis.fallbackReason : undefined,
  };

  return { record, results: added, plan, logs: search.log };
}

/**
 * 把整理识别出的低价值/跑题特征应用到补搜结果上：**只标记，不删除**。
 *
 * 每条命中项被标为 `value: low`（除非模型已判它是 high —— 模型的判断比
 * 一个词法模式优先），下游 `/api/fetch` 的 pickTargets 会跳过它的抓取
 * 成本，而结果本身仍留在列表里供用户核查。
 *
 * 词法匹配刻意做保守：
 *   - 忽略 <2 字符的模式（单字几乎必然误杀）；
 *   - 不覆盖已判 high 的结果（一个「标题里有『入门』的深入原理解析」
 *     不该因为一个模式丢掉）。
 */
function applyAvoidPatterns(
  results: SearchResult[],
  avoidPatterns: string[],
): SearchResult[] {
  const patterns = avoidPatterns
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
  if (patterns.length === 0) return results;

  return results.map((r) => {
    if (r.value?.verdict === "high") return r;
    const haystack = `${r.title}\n${r.snippet}`.toLowerCase();
    const hit = patterns.find((p) => haystack.includes(p.toLowerCase()));
    if (!hit) return r;
    return {
      ...r,
      value: {
        verdict: "low" as const,
        reason: `命中整理阶段识别的低价值特征「${hit}」`,
        category: r.value?.category || "未分类",
      },
    };
  });
}

function selectDocuments(documents: Document[]): Document[] {
  return [...documents]
    .sort(
      (a, b) =>
        (b.relevance?.score ?? 0) - (a.relevance?.score ?? 0) ||
        b.wordCount - a.wordCount,
    )
    .slice(0, MAX_DOCUMENTS);
}

async function analyzeDocuments(
  query: string,
  intent: string | undefined,
  docs: Document[],
  signal?: AbortSignal,
) {
  if (docs.length === 0) {
    return {
      summary: "还没有可整理的正文，先抓取资料后再补搜。",
      categories: [],
      missingAngles: [],
      queries: [],
      avoidPatterns: [],
      fallbackReason: "没有已抓取正文",
    };
  }

  const items = docs.map((doc, index) => ({
    index,
    title: doc.title,
    site: doc.site,
    excerpt: doc.excerpt || doc.text.slice(0, 500),
  }));

  try {
    return await chatJson(
      RefineSchema,
      [
        {
          role: "system",
          content: [
            "你在做一次资料整理与补搜规划。",
            "只输出一个 JSON 对象，不要解释、不要 Markdown 代码块。",
            "根据用户主题和已抓取正文，判断当前资料覆盖了什么、还缺什么，并生成能补足缺口的短查询。",
            "不要编造资料里没有的技术名词；查询必须围绕主题和缺失角度，不要生成招聘、股价、泛娱乐等跑题词。",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            `调研主题：${query}`,
            intent ? `用户意图：${intent}` : "",
            "",
            "已抓取资料（JSON）：",
            JSON.stringify(items),
            "",
            "请返回分类、缺口、补搜查询和应避免的低价值特征。",
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
      { signal, maxTokens: MAX_TOKENS, timeoutMs: TIMEOUT_MS },
    );
  } catch (err) {
    return {
      summary: `资料整理失败，已退回当前计划补搜：${err instanceof Error ? err.message : String(err)}`,
      categories: [],
      missingAngles: [],
      queries: [],
      avoidPatterns: [],
      fallbackReason: err instanceof Error ? err.message : String(err),
    };
  }
}
