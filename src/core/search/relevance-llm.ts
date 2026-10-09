/**
 * 相关性判定 —— **模型批量判定那半边**。
 *
 * 本地规则（可复现、零延迟、无 key 也能跑）在 `relevance.ts`。这里只做一件事：
 * 把标题 + 摘要 + 一份「用户到底想查什么」送给模型，让它把本地规则拿不准的
 * 那批（`uncertain`）判出个结果来。
 *
 * ── 为什么是批量而不是逐条 ──
 *
 * 逐条判定意味着 35 次调用、几十秒、几十倍的钱。一次搜索本来就要等十几秒，
 * 再挂一个和结果条数成正比的等待，用户只会以为卡住了。所以：一次封顶两批。
 *
 * ── 与 `quality.ts` 的边界 ──
 *
 * 这里用模型，但**不是在打质量分**。判据是用户自己给的查询（「这条切不切你的题」），
 * 不是「这条内容可不可信」。后者这个系统从不回答 —— 理由写在 `types.ts` 的
 * `Relevance` 和 `quality.ts` 的开头。
 *
 * ── 失败即弃权 ──
 *
 * 没 key、超时、形状不对、某一批炸了 —— 一律**返回已拿到的部分，不抛异常**。
 * 调用方（`orchestrate.ts`）因此始终保有一份词法判定兜底，最差也有结果可看。
 */

import { z } from "zod";
import type { Relevance, SearchPlan, SearchResult } from "@/core/types";
import { chatJson } from "@/core/llm/chat";

/**
 * 送进模型的条数上限。
 *
 * 超出的部分留 `uncertain`（= 不标记）。挑前 K 条的依据是**融合排序后的顺序**，
 * 所以被丢掉的是排在最后的那些 —— 与「先看最可能相关的」一致。
 */
const MAX_ITEMS = 60;

/** 每批条数。一批太大模型会开始偷懒（后几条照抄前一题的答案）。 */
const BATCH = 40;

/**
 * 整个判定的截止时间，罩住所有批次。
 *
 * 不给这个的话，最坏情况是 2 批各自等满 `LLM_TIMEOUT_MS` —— 那是分钟级的，
 * 用户只会以为搜索坏了。超时就放弃剩余的批次，已经拿到的判定照样算数。
 */
const TIMEOUT_MS = Number(process.env.RELEVANCE_TIMEOUT_MS ?? 20_000);

/**
 * 输出上限。**不能给小**：deepseek-flash 是推理模型，思维链与正文共享额度，
 * 给小了会出现「正文为空、finish_reason=length」。
 */
const MAX_TOKENS = Number(process.env.RELEVANCE_MAX_TOKENS ?? 8_192);

/**
 * 输出形状。`index` 是**这批数组里的下标**，不是全局 id ——
 * 让模型回一串 sha1 是自找麻烦：它会抄错，而且错了没法察觉。
 */
const Verdicts = z.object({
  verdicts: z.array(
    z.object({
      index: z.number().int().describe("这条对应输入数组里的第几项（从 0 开始）"),
      verdict: z
        .enum(["likely", "unlikely", "uncertain"])
        .describe("切题 / 不切题 / 拿不准。拿不准就用 uncertain，不要硬猜"),
      reason: z.string().describe("一句话说明依据，中文"),
    }),
  ),
});

const SYSTEM_PROMPT = [
  "你在判断一批搜索结果是否切合用户的调研主题。",
  "只输出一个 JSON 对象，不要解释、不要 Markdown 代码块。",
  "",
  "**纪律：**",
  "- 你的任务是判断「这条是不是用户在找的东西」，**不是**判断「这条内容对不对、好不好」。",
  "  一条切题但质量差的内容，仍然应该判 likely。",
  "- **拿不准就判 uncertain。** 多标一条不相关的，代价是用户错过一份本来有用的资料；",
  "  少标一条，代价只是列表里多一条噪音。两害相权，宁可漏判。",
  "- 依据只看给你的标题、摘要和域名。不要凭常识补全没写出来的东西。",
].join("\n");

function userPrompt(plan: SearchPlan, batch: SearchResult[]): string {
  const items = batch.map((r, i) => ({
    index: i,
    // 只给判定需要的三样东西。正文太贵，而且这时候还没抓
    title: r.title,
    snippet: (r.snippet ?? "").slice(0, 300),
    domain: r.domain,
  }));

  return [
    `用户的原话（逐字）：${plan.raw}`,
    `这句话的意思：${plan.intent}`,
    plan.entity.name ? `主题词：${plan.entity.name}` : "",
    plan.entity.aliases.length
      ? `主题词的其他写法：${plan.entity.aliases.join("、")}`
      : "",
    plan.disambiguators.length ? `限定词：${plan.disambiguators.join("、")}` : "",
    plan.negatives.length ? `应当排除的：${plan.negatives.join("、")}` : "",
    "",
    "结果列表（JSON）：",
    JSON.stringify(items),
    "",
    `请对每一条给出判定，返回 ${items.length} 项，index 用上面给的那个。`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * 批量判定，返回 `SearchResult.id → Relevance`。
 *
 * **绝不抛异常** —— 上面的「失败即弃权」说了为什么。
 */
export async function judgeRelevance(
  results: SearchResult[],
  plan: SearchPlan,
  opts: { signal?: AbortSignal } = {},
): Promise<Map<string, Relevance>> {
  const out = new Map<string, Relevance>();
  if (results.length === 0) return out;

  const targets = results.slice(0, MAX_ITEMS);
  const deadline = AbortSignal.timeout(TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline;

  for (let start = 0; start < targets.length; start += BATCH) {
    const batch = targets.slice(start, start + BATCH);
    try {
      const parsed = await chatJson(
        Verdicts,
        [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt(plan, batch) },
        ],
        /*
          `signal` 是罩住**所有批次**的截止时间，`timeoutMs` 是**单次调用**的
          兜底。两个都要写：只给 signal 的话，兜底会退回到 `LLM_TIMEOUT_MS`
          （默认 300 秒）—— 那正是「超时就放弃剩余的批次」这句注释曾经不成立的
          原因（第二批拿到的是已经 abort 的 deadline，见 `core/timeout.ts`）。
        */
        { signal, maxTokens: MAX_TOKENS, timeoutMs: TIMEOUT_MS },
      );

      for (const v of parsed.verdicts) {
        const r = batch[v.index];
        // 下标越界就丢掉这一条 —— 模型偶尔会回一个不存在的 index，
        // 而把一个判定安到别的结果头上，比丢掉它糟得多
        if (!r) continue;
        out.set(r.id, {
          verdict: v.verdict,
          reason: v.reason.trim() || "模型未给出依据",
          source: "llm",
        });
      }
    } catch {
      // 这一批失败不影响其他批：已经拿到的判定照样有用
    }
  }

  return out;
}
