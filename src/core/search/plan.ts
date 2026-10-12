/**
 * 搜索词分析。
 *
 * ── 为什么要有这一步 ──
 *
 * 用户实测：查 `DeepSeek-V4.1-Flash` 搜回来 35 条，其中 7 条连「DeepSeek」都
 * 没出现（一条是 ERP 产品的「v4.1.7 发布」——纯版本号撞车）。根因是带连字符
 * 的型号名被后端拆成 `deepseek` / `v4.1` / `flash` 三个通用 token。
 *
 * 原话原样下发就没法对付这个：`buildQuery` 只会在后面追加站点关键词。所以在
 * **唯一的扇出点之前**插一次分析，产出各站点各自的查询串，外加一份「用户到底
 * 想查什么」的明确表述供相关性判定使用。
 *
 * ── 三条硬约束 ──
 *
 *  1. **`variants` 只含查询正文**，不含站点关键词 —— 那是 `buildQuery` 的职责，
 *     在这里再拼一次会得到「知乎 知乎」。
 *  2. **绝不阻塞搜索。** 整个分析（含可能的返修）共享一个 `PLAN_TIMEOUT_MS`
 *     的截止时间；超时、报错、没配 key 一律走 `lexicalPlan`，而它在任何情况下
 *     产出的查询串都与加这个功能**之前逐字相同**。搜索仍会给你结果。
 *  3. **不猜。** 拿不准的站就不给 `variants[site]`，回退到原话 —— 一个擅自
 *     改写的查询可能把本来搜得到的东西搜没了，那比不改更糟。
 */

import { z } from "zod";
import type { SearchPlan, SiteKey } from "@/core/types";
import { config, hasLLM } from "@/core/env";
import { chatJson } from "@/core/llm/chat";

/**
 * 整个分析过程的截止时间（含返修那一轮）。
 *
 * 8 秒是拿「用户按下搜索到看见第一批结果」的耐受反推的：搜索本身要十几秒，
 * 再挂一个更长的前置等待，用户会以为卡住了。超时就退化成不改写 ——
 * 慢一点比没有结果好，但没有结果比慢一点更糟。
 */
const PLAN_TIMEOUT_MS = Number(process.env.PLAN_TIMEOUT_MS ?? 15_000);

/**
 * 分析用的输出上限。
 *
 * 比构图的 32768 小得多，但**不能太小**：这个模型（deepseek-flash）是推理
 * 模型，思维链与正文共享额度，给小了会出现「正文为空、finish_reason=length」。
 * 4096 是留了余量的估计，实测不够就调 PLAN_MAX_TOKENS。
 */
const PLAN_MAX_TOKENS = Number(process.env.PLAN_MAX_TOKENS ?? 4_096);

/**
 * 单个站点最多尝试多少个查询变体。
 *
 * 一次查询的召回上限由上游引擎决定；`DeepSeek-V4.1-Flash` 这类型号名在
 * 不同引擎上对连字符、空格和站点关键词的处理并不一致。多准备几条变体、
 * 在结果不足时逐条补搜，比把所有词硬塞进一条超长查询稳定得多。
 */
const MAX_QUERY_VARIANTS = Number(process.env.SEARCH_QUERY_VARIANTS ?? 5);

/**
 * 输出形状。
 *
 * 全部字段必填，不用 `.optional()` / `.nullable()` —— 结构化输出对可选字段的
 * 支持面窄，「没有就返回空数组/空串」比「字段可能不存在」稳得多。这一条是从
 * `graph/llm.ts` 的 `Extraction` 那里学来的。
 */
const PlanSchema = z.object({
  intent: z.string().describe("一句话说明用户想查什么，不要复述原词"),
  relatedTerms: z
    .array(z.string())
    .describe(
      "与主题紧密相关的技术词/概念词，例如 DeepSeek-V4-Flash 的 KVCache；最多 8 个，不要编造",
    ),
  entity: z.object({
    name: z.string().describe("最能代表主题的专有名词；没有明确实体就填空字符串"),
    aliases: z
      .array(z.string())
      .describe("同一实体的其他写法（全称、简称、中英文名），没有就给空数组"),
  }),
  disambiguators: z
    .array(z.string())
    .describe("能把这个主题和同名事物区分开的限定词，没有就给空数组"),
  negatives: z
    .array(z.string())
    .describe("和主题同名但明显不是用户要的东西，没有就给空数组"),
  variants: z
    .record(z.string(), z.string())
    .describe("站点名 → 针对该站点改写后的查询正文，只写查询词本身"),
});

/**
 * 形状说明直接从 zod schema 生成。
 *
 * 手写一份放在提示词里、再在代码里维护一份 zod，是这类代码最常见的一种烂法：
 * 改了一边忘了另一边，症状是「模型偶尔就不听话」，极难归因。这里只有一份真相。
 */
const SHAPE_HINT = shapeHint();

function shapeHint(): string {
  const schema = z.toJSONSchema(PlanSchema) as Record<string, unknown>;
  delete schema.$schema;
  return JSON.stringify(schema);
}

const SYSTEM_PROMPT = [
  "你是搜索策略助手。用户给出一个调研主题，你要判断他真正想查什么，并把它翻译成更准确的检索词。",
  "只输出一个 JSON 对象，不要解释、不要 Markdown 代码块。",
  "",
  "输出必须严格符合下面这个 JSON Schema：",
  SHAPE_HINT,
  "",
  "分析要求：",
  "- 用户意图提示是**硬约束**：它不是可选的润色，而是这次检索要保证满足的目标。" +
    "variants 与 relatedTerms 必须优先围绕它展开。",
  "- **entity.name 是最关键的一项。** 它要是主题里那个专有名词（产品名、型号、技术名、公司名），" +
    "因为后续要靠它判断一条搜索结果切不切题。主题就是一个普通概念（如「露营装备」）时，" +
    "把整个主题填进去即可。",
  "- aliases 收同一事物的其他写法。比如型号名要同时给出带连字符和不带连字符的写法 —— " +
    "很多搜索引擎会把连字符拆开，导致版本号撞车（「DeepSeek-V4.1」被拆成 deepseek + v4.1，" +
    "搜回来一堆 v4.1.7 之类的无关东西）。",
  "- disambiguators 用来把主题和同名事物分开；negatives 列出同名但明显不是用户想要的。",
  "- variants 按站点分别给查询词：视频站（B 站 / YouTube）偏向完整的产品名或教程标题，" +
    "问答站（知乎）偏向「怎么用 / 是什么 / 对比」这类问句，代码站（GitHub）偏向仓库名或技术名。",
  "- relatedTerms 只放和 entity 紧密相连、能帮助找到关联资料的技术词/架构/应用。" +
    "例如查询 DeepSeek-V4-Flash 时，自动补充相关的底层技术概念（如 MoE 架构、MLA 注意力机制、KVCache、vLLM 推理部署、基准评测），" +
    "以便在直接型号资料较少时，能够搜索其相关技术资料作为参考支撑；不要放泛泛的「AI」「模型」，也不要放同名但无关的领域。",
  "- **variants 里只写查询词本身**，不要写「site:xxx.com」，也不要写站点名 —— " +
    "那部分由调用方追加，写进来会重复。",
  "- **拿不准就不要改写。** 某个站点想不出更合适的查询词，就把它填成和原主题一样。" +
    "一个擅自改坏的查询会把本来搜得到的东西搜没了，比不改更糟。",
  "- 不要凭空编造原主题里没有的品牌、型号、年份。",
].join("\n");

function userPrompt(
  raw: string,
  sites: SiteKey[],
  userIntent?: string,
  avoidPatterns?: string[],
): string {
  const lines = [
    `调研主题（用户原话）：${raw}`,
    userIntent ? `用户意图提示（必须满足）：${userIntent}` : null,
    avoidPatterns?.length
      ? `已识别需规避的低价值/跑题特征（并入 negatives，variants 里避开）：${avoidPatterns.join("、")}`
      : null,
    `将要检索的站点：${sites.join("、")}`,
    "",
    "请分析这个主题并按要求返回 JSON。variants 里请覆盖上面列出的每一个站点。",
  ];
  return lines.filter((l): l is string => l !== null).join("\n");
}

/**
 * 分析搜索词。
 *
 * 无 LLM、超时、返回的形状不对 —— 一律退化成 `lexicalPlan`，**不抛异常**。
 * 这是刻意的：分析是锦上添花，搜索是主功能，前置步骤失败不该让主功能消失。
 */
export async function planQueries(
  raw: string,
  sites: SiteKey[],
  opts: {
    signal?: AbortSignal;
    intent?: string;
    /**
     * 前几轮整理识别出的低价值/跑题特征（标题模式）。
     *
     * 由 `refine.ts` 把历轮 `avoidPatterns` 传进来：并进 prompt 让模型写
     * variants 时主动避开，同时合并进返回的 `negatives` —— 词法相关性
     * 与下一轮判定的判据也跟着收紧，补搜不会再把同一类垃圾捞回来。
     */
    avoidPatterns?: string[];
  } = {},
): Promise<SearchPlan> {
  const userIntent = opts.intent?.trim() || undefined;
  if (!hasLLM()) {
    return lexicalPlan(raw, "未配置 LLM_API_KEY", userIntent);
  }
  if (sites.length === 0) {
    return lexicalPlan(raw, "没有选中任何站点", userIntent);
  }

  /*
    一个截止时间罩住整个过程（含 chatJson 内部可能的返修轮）。

    不这么做的话最坏情况是「两次调用各自等满 LLM_TIMEOUT_MS」—— 那是分钟级的，
    用户只会以为搜索坏了。这里超时就放弃改写，而不是继续等。
  */
  const deadline = AbortSignal.timeout(PLAN_TIMEOUT_MS);
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, deadline])
    : deadline;

  try {
    const parsed = await chatJson(
      PlanSchema,
      [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: userPrompt(raw, sites, userIntent, opts.avoidPatterns),
        },
      ],
      /*
        同时给出 `timeoutMs`：`signal` 是「整个分析」的截止时间，`timeoutMs` 是
        「这一次 HTTP 调用」的兜底。两个都要写 —— 只给 signal 的话，兜底就退回
        到 `LLM_TIMEOUT_MS`（默认 300 秒），一旦 signal 那条路出任何意外，用户
        等到的就是五分钟而不是八秒。两道闸各自能独立生效，才是想要的。
      */
      { signal, maxTokens: PLAN_MAX_TOKENS, timeoutMs: PLAN_TIMEOUT_MS },
    );

    return {
      raw,
      userIntent,
      intent: parsed.intent.trim() || raw,
      relatedTerms: clean(parsed.relatedTerms),
      entity: {
        name: parsed.entity.name.trim(),
        aliases: clean(parsed.entity.aliases),
      },
      disambiguators: clean(parsed.disambiguators),
      negatives: clean([...parsed.negatives, ...(opts.avoidPatterns ?? [])]),
      variants: pickVariants(parsed.variants, sites),
      source: "llm",
    };
  } catch (err) {
    return lexicalPlan(
      raw,
      err instanceof Error ? err.message : String(err),
      userIntent,
    );
  }
}

/**
 * 该站点的查询该用什么词。
 *
 * 回退顺序是 `variants[site]` → 原话。**没有第三条路** —— 尤其不要拿别的站点的
 * 改写结果顶替：B 站那套口播式的查询丢给 arXiv 只会搜出一堆无关论文。
 */
export function variantFor(plan: SearchPlan, site: SiteKey): string {
  const v = plan.variants[site]?.trim();
  const base = v || plan.raw;
  const clauses: string[] = [base];

  // 意图提示始终参与真实查询，即使分析失败或模型忘了把它写进 variants。
  const intent = plan.userIntent?.trim();
  if (intent && !base.toLowerCase().includes(intent.toLowerCase())) {
    clauses.push(intent);
  }

  /*
   * 关联词用 OR 追加，而不是 AND：用户要找的是“这个主题的关联技术”，
   * 只写 `DeepSeek-V4-Flash KVCache` 会把没有同时出现两者的资料全部挡掉。
   * 相关性判定会在结果回来后再按关联度排序，宁可多捞几条再筛。
   */
  const related = (plan.relatedTerms ?? []).filter((term) => term.trim());
  if (related.length > 0) {
    clauses.push(`(${related.slice(0, 4).map((term) => `"${term.trim()}"`).join(" OR ")})`);
  }

  return clauses.join(" ");
}

/**
 * 生成一个站点的候选查询正文（不含站点关键词 / `site:` 语法）。
 *
 * `variantFor` 仍是“首选查询”，但单次查询可能因为引擎分词、站点收录或
 * 查询过长而空手而归。这里把用户原词、实体别名和关联技术词拆成几条更短
 * 的查询，调用方按结果数量决定是否继续尝试。
 *
 * 顺序有意偏向短查询：型号名 + 站点关键词这类查询最容易命中知乎，而把
 * 意图、四个关联词和问句全部拼在一起时，任何一段不匹配都会拖垮整条查询。
 */
export function queryVariantsFor(
  plan: SearchPlan | undefined,
  site: SiteKey,
  fallbackTopic?: string,
): string[] {
  const raw = plan?.raw.trim() || fallbackTopic?.trim() || "";
  if (!raw) return [];

  const primary = plan ? variantFor(plan, site) : raw;
  const base = plan?.variants[site]?.trim() || raw;
  const entity = plan?.entity.name.trim() || raw;
  const aliases = (plan?.entity.aliases ?? []).map((s) => s.trim()).filter(Boolean);
  const related = (plan?.relatedTerms ?? []).map((s) => s.trim()).filter(Boolean);

  /*
    知乎优先尝试最短的原词查询。实测带连字符的型号在长查询里会被引擎拆散，
    `DeepSeek-V4.1-Flash 知乎` 反而能拿到更稳定的命中；其它站点仍优先使用
    已经过站点改写的首选查询，避免牺牲平台特定的改写效果。
  */
  const preferred =
    site === "zhihu"
      ? [raw, entity, ...aliases, primary, base]
      : [primary, base, raw, entity, ...aliases];

  const expanded = [
    ...preferred,
    /*
      连字符型号名的**去标点形态**。

      `DeepSeek-V4.1-Flash` 在不同引擎里有三种命运：bing 把它当一个词（常常
      一个都搜不到），duckduckgo 按连字符拆词（搜回来一堆 v4 和 flash 的
      无关组合），还有些引擎把它整个短语当停用词丢掉。补一条空格形态
      `DeepSeek V4.1 Flash` 和一条引号精确形态，三种引擎各有一条能走通的路。
    */
    ...punctuationForms(raw),
    ...punctuationForms(entity).slice(0, 2),
    /*
      技术扩展查询：当精确型号文章较少时，直接搜索与该技术强相关的词汇作为参考材料
    */
    ...related.map((term) => `${entity} ${term}`),
    ...related.map((term) => `${raw} ${term}`),
    ...aliases.map((alias, index) =>
      related[index] ? `${alias} ${related[index]}` : alias,
    ),
    // 单独补充 1~2 个关键衍生技术词（如 DeepSeek 相关时搜索 "DeepSeek MoE", "DeepSeek MLA"）
    ...related.slice(0, 3).map((term) => `${entity.split(/[-_.\s]/)[0] || entity} ${term}`),
  ];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of expanded) {
    const value = candidate.trim().replace(/\s+/g, " ");
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= MAX_QUERY_VARIANTS) break;
  }
  return out;
}

/**
 * 把一个查询词拆成「去标点」与「引号精确匹配」两种形态。

 * 只对**真的含标点的词**动手：`露营装备` 这类纯中文词加引号是多余的，
 * 反而可能让某些引擎按字面短语匹配而漏掉分词命中的结果。
 */
function punctuationForms(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed || !/[-_./]/.test(trimmed)) return [];
  const spaced = trimmed.replace(/[-_./]+/g, " ").replace(/\s+/g, " ").trim();
  const out: string[] = [];
  if (spaced && spaced.toLowerCase() !== trimmed.toLowerCase()) out.push(spaced);
  // 引号形态放最后：它最精确，也最容易因为引擎差异空手而归，当保底不当首选
  out.push(`"${trimmed.replace(/"/g, "")}"`);
  return out;
}

/**
 * 不改写时的分析结果 —— 查询串与加这个功能之前**逐字相同**。
 *
 * `variants` 留空而不是填满原话：留空让 `variantFor` 走同一条回退路径，
 * 少一处「填了但填的是原值」的中间状态。
 */
export function lexicalPlan(
  raw: string,
  reason: string,
  userIntent?: string,
): SearchPlan {
  const intent = userIntent?.trim();
  return {
    raw,
    userIntent: intent || undefined,
    intent: intent ? `${raw}；${intent}` : raw,
    // 原话就是这里的实体名。它不完美（原话可能是一整句话），但相关性判定
    // 的判据是「判别性 token 一个都不出现」，一整句话同样能用 ——
    // 只是比 LLM 给的那个更容易漏判，而漏判（不标记）正是安全的方向。
    entity: { name: raw, aliases: [] },
    disambiguators: [],
    negatives: [],
    relatedTerms: [],
    variants: {},
    source: "lexical",
    fallbackReason: reason,
  };
}

/** 去掉空白项、去重、保序。模型很爱回 `["", ""]` 这种占位。 */
function clean(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const s = raw.trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/**
 * 只收我们真的会检索的站点。
 *
 * 模型可能回一个不存在的站点名或旧站点名。不认识就丢掉，让那个站点走原话 ——
 * 直接把未知 key 塞进 `variants` 的话，它既不会被用到，又会让「哪些站点被
 * 改写过」这件事在界面上显示得莫名其妙。
 */
function pickVariants(
  raw: Record<string, string>,
  sites: SiteKey[],
): Partial<Record<SiteKey, string>> {
  const out: Partial<Record<SiteKey, string>> = {};
  for (const site of sites) {
    const v = raw[site]?.trim();
    if (v) out[site] = v;
  }
  return out;
}

/** 这次要不要走 LLM。给界面和健康检查用。 */
export function describePlanSource(): string {
  return hasLLM() ? `LLM（${config.llmModel}）` : "本地规则（未配置 LLM_API_KEY）";
}
