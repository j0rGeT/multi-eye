/**
 * 资料价值分类 —— 整理阶段的「这条值不值得留」。
 *
 * 与 `relevance.ts` 的边界：
 *
 *   - 相关性回答「切不切题」，判据是用户原话，任何时候都在跑；
 *   - 价值回答「即使切题，它有没有把事情讲清楚」，判据是**正文**，只有抓完
 *     才能判 —— 一篇切题但全是转载标题党的文章，相关性 likely、价值 low。
 *
 * 两者绝不合成一个分数：`types.ts` 里那句「这个系统不回答内容对不对」在这里
 * 同样成立。`lowValue.reason` 必须是可核对的事实（正文太短、只是新闻通稿、
 * 只有登录墙），而不是「我觉得没用」。
 *
 * **只标记不删除**：价值 low 的资料仍然留在列表、报告和下载包里，只是默认
 * 不进整理视图与拓扑。理由随标记一起存，界面必须能显示出来。
 */

import { z } from "zod";
import type {
  Document,
  SearchResult,
  ValueAssessment,
  ValueVerdict,
} from "@/core/types";
import { chatJson } from "@/core/llm/chat";
import { hasLLM } from "@/core/env";

// 类型在 types.ts 里定义（SearchResult.value 要用），这里重导出保持既有调用点不变。
export type { ValueAssessment, ValueVerdict };

const MAX_TOKENS = Number(process.env.VALUE_MAX_TOKENS ?? 8_192);
const TIMEOUT_MS = Number(process.env.VALUE_TIMEOUT_MS ?? 25_000);
/** 一批送多少条。太大会让模型从后面开始偷懒、照抄前一条的结论。 */
const BATCH = 30;

const AssessmentsSchema = z.object({
  items: z.array(
    z.object({
      index: z.number().int().describe("对应输入数组里的第几项，从 0 开始"),
      verdict: z
        .enum(["high", "medium", "low"])
        .describe("high=有实质内容可参考；medium=有用但浅/重复；low=价值低或跑题"),
      reason: z
        .string()
        .describe("一句话依据，只描述材料里看得见的事实，中文"),
      category: z
        .string()
        .describe("把这条归到一个不超过 6 个字的类别，如「原理分析」「部署实践」"),
    }),
  ),
});

const SYSTEM_PROMPT = [
  "你在给一批已抓取的技术资料做「参考价值」分类，供整理与补搜使用。",
  "只输出一个 JSON 对象，不要解释、不要 Markdown 代码块。",
  "",
  "**纪律：**",
  "- 你判的是「对这次调研有没有可参考的内容」，不是「内容对不对、作者可不可信」。",
  "- verdict 分三档：high（有原理、参数、代码、实测等实质内容）；",
  "  medium（切题但浅、只有结论没有依据、或与其它条目高度重复）；",
  "  low（正文极短、只是标题党/新闻通稿/登录墙/明显跑题）。",
  "- reason 必须能被下一个人在材料里核实，不要写「质量不高」这种空话。",
  "- 拿不准就 medium。宁可少标 low，也不要误杀一份有用的资料。",
  "- category 是给资料**分类**：不超过 6 个字的中文短语，如「原理分析」「部署实践」",
  "  「踩坑记录」「参数对比」「入门教程」「新闻转载」「官网/下载页」「讨论帖」。",
  "  **不要把 verdict 单词（high/medium/low）写进 category** —— 两个字段各管各的。",
].join("\n");

/**
 * 批量给搜索结果判价值。**没有 LLM 时整体弃权**（返回空表），由调用方原样保留。
 *
 * 与 `judgeRelevance` 同一条失败语义：超时 / 结构不合法只丢掉这一批判定，
 * 不抛异常、不阻断搜索。
 */
export async function classifySearchResults(
  results: SearchResult[],
  query: string,
  intent: string | undefined,
  signal?: AbortSignal,
): Promise<Map<string, ValueAssessment>> {
  const out = new Map<string, ValueAssessment>();
  if (!hasLLM() || results.length === 0) return out;

  const targets = results.slice(0, 120);
  for (let start = 0; start < targets.length; start += BATCH) {
    const batch = targets.slice(start, start + BATCH);
    try {
      const parsed = await chatJson(
        AssessmentsSchema,
        [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              `调研主题：${query}`,
              intent ? `用户意图：${intent}` : "",
              "",
              "候选结果（只有标题与搜索摘要，正文还没抓）：",
              JSON.stringify(
                batch.map((r, i) => ({
                  index: i,
                  title: r.title,
                  snippet: (r.snippet ?? "").slice(0, 300),
                  domain: r.domain,
                })),
              ),
              "",
              `请返回 ${batch.length} 项。`,
            ]
              .filter(Boolean)
              .join("\n"),
          },
        ],
        { signal, maxTokens: MAX_TOKENS, timeoutMs: TIMEOUT_MS },
      );
      for (const item of parsed.items) {
        const target = batch[item.index];
        if (!target) continue;
        out.set(target.id, {
          verdict: item.verdict,
          reason: item.reason.trim() || "未给出依据",
          category: normalizeCategory(item.category),
        });
      }
    } catch {
      /*
        一批失败就停：剩下的保留「未判定」，不拿空表冒充「都判过了」。

        这里**必须区分两类失败**——
          - 结构/内容失败（zod 不通过、模型拒绝）：break 是对的，模型这一批
            都写坏了，后面多半也会坏；
          - 调用方主动 abort（用户点了取消 / 上层超时）：**不能把 break 传成
            「模型判了一批 0 项」**，否则表现成「预判全 0、用户没做错什么」。
            AbortError 直接 throw 上去，让编排层知道是「被取消」而非「没判到」。
      */
      if (signal?.aborted) throw signal.reason;
      break;
    }
  }
  return out;
}

/** 已抓取正文的价值分类。比搜索结果判得准，因为这里能看到全文。 */
export async function classifyDocuments(
  documents: Document[],
  query: string,
  intent: string | undefined,
  signal?: AbortSignal,
): Promise<Map<string, ValueAssessment>> {
  const out = new Map<string, ValueAssessment>();
  if (!hasLLM() || documents.length === 0) return out;

  const targets = [...documents]
    .sort((a, b) => (b.relevance?.score ?? 0) - (a.relevance?.score ?? 0))
    .slice(0, 60);

  for (let start = 0; start < targets.length; start += BATCH) {
    const batch = targets.slice(start, start + BATCH);
    try {
      const parsed = await chatJson(
        AssessmentsSchema,
        [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              `调研主题：${query}`,
              intent ? `用户意图：${intent}` : "",
              "",
              "已抓取资料（正文截取到 1200 字）：",
              JSON.stringify(
                batch.map((d, i) => ({
                  index: i,
                  title: d.title,
                  site: d.site,
                  text: (d.text ?? "").slice(0, 1200),
                })),
              ),
              "",
              `请返回 ${batch.length} 项。`,
            ]
              .filter(Boolean)
              .join("\n"),
          },
        ],
        { signal, maxTokens: MAX_TOKENS, timeoutMs: TIMEOUT_MS },
      );
      for (const item of parsed.items) {
        const target = batch[item.index];
        if (!target) continue;
        out.set(target.id, {
          verdict: item.verdict,
          reason: item.reason.trim() || "未给出依据",
          category: normalizeCategory(item.category),
        });
      }
    } catch {
      // 与 classifySearchResults 同一理由：调用方主动 abort 不能静默吞掉。
      if (signal?.aborted) throw signal.reason;
      break;
    }
  }
  return out;
}

/**
 * 把模型给的 category 归一成可信的展示值。
 *
 * 模型偶尔会照抄 verdict 单词（`"category": "low"`）—— 那不是类别，
 * 是字段抄错行。识别出来一律归到「未分类」，不把它当一类主题展示。
 */
const VERDICT_WORDS = new Set(["high", "medium", "low", "高", "中", "低"]);

function normalizeCategory(raw: string): string {
  const c = raw.trim();
  if (!c || VERDICT_WORDS.has(c.toLowerCase())) return "未分类";
  return c;
}

/** 分类结果的中文名。界面与报告共用。 */
export const VALUE_LABELS: Record<ValueVerdict, string> = {
  high: "高价值",
  medium: "中等",
  low: "低价值",
};
