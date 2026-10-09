/**
 * 相关性判定 —— 这条结果切不切用户的题。**本地规则部分。**
 *
 * 这个文件是**叶子模块**：除了类型之外不 import 任何东西。理由有两个 ——
 *
 *  1. 它要能被 `examples/e2e.mjs` 直接 import 来做回归（Node 的类型擦除跑不了
 *     `@/` 别名，`import type` 会被整条擦掉，值导入不会）。判据是本轮最容易
 *     悄悄改坏、又最难靠肉眼发现的东西，必须有断言钉住 —— 见 `boilerplate.ts`
 *     用同一套办法钉住「导航当正文」那个检测器。
 *  2. 模型批量判定在 `relevance-llm.ts`。分开是因为它俩的失败模式完全不同：
 *     这边的每条判据都能复现，那边会超时、会乱回 index。混在一个文件里，
 *     改这边时很难不去想那边的异常路径。
 *
 * ── 它解决的问题 ──
 *
 * 用户实测：查 `DeepSeek-V4.1-Flash` 搜回来 35 条，其中 7 条连「DeepSeek」都没
 * 出现（一条是 ERP 产品的「v4.1.7 发布」）。根因是带连字符的型号名被拆成
 * `deepseek` / `v4.1` / `flash` 三个通用 token，`v4.1.7` 于是撞了上来。
 *
 * 注意分工：**查询分析（`plan.ts`）减少「搜进来什么」，相关性判定管「搜进来之后
 * 怎么标」。** 前者改不了后端的分词方式，后者才是兜底。
 *
 * ── 三条边界（写死在这里，改前先想清楚）──
 *
 *  1. **不是质量分。** 见 `types.ts` 的 `Relevance`。它回答「切不切题」，判据是
 *     用户自己给的查询；它**不回答**「内容对不对」——那件事这个系统从不回答。
 *     绝不允许它污染 `bodyGrade`。
 *  2. **只标记，不删除。** 排序由 `rankResults` 决定，这里一行都不改。
 *  3. **宁可漏判，不可误判。** `uncertain` 是**默认档**，不是「有点可疑」。
 *     下面每一条判据都只认决定性证据，拿不准就弃权 —— 一个被误标「疑似不相关」
 *     的优质资料，比十条没被标出来的噪音更伤。
 *
 * ── 判据是量出来的，不是拍的 ──
 *
 * 在真实会话 `bzIgW6vdFj`（`DeepSeek-V4.1-Flash`，35 条）上量过：标出 **7 条、
 * 零误杀**，7 条恰好就是那批不含实体的结果。在 `NZ1Eh2r9wO`（露营装备，55 条）
 * 上**一条都不标**（中文主题走弃权，见下）。具体数字记在 `latinHead` 上。
 */

import type { Relevance, SearchPlan, SearchResult } from "@/core/types";

/** 判「不相关」用的拉丁词根最短长度。低于这个长度的词（`ai` / `js`）到处都是，没有判别力。 */
const MIN_HEAD_LEN = 3;

/**
 * 取实体名里**最长的那段拉丁字母**，作为判别性词根。
 *
 * ── 为什么是「最长的一段」，而不是「所有 ≥N 字符的词」──
 *
 * 试过后者，实测不行。`DeepSeek-V4.1-Flash` 切出来是 `deepseek` / `flash`
 * （`v4`、`1` 不够长），而 **`flash` 是个通用英文词**：拿它当判据，
 * 「[Google Gemini] Gemini 好像用不了了」（摘要写的是「Flash 目前好像正常」）
 * 和「$100 预算 + 四个顶级大模型」（写的是「Gemini 3.8 Flash」）都会被判成相关 ——
 * 这两条正是用户点名的无关结果。
 *
 * 取最长的一段，`deepseek` 就压过了 `flash`，两条都被正确地标出来。
 *
 * ── 为什么只看 `entity.name`，不看 `aliases` ──
 *
 * 别名可能是**跨语言的译名**（主题「露营装备」的别名里很可能有 "camping gear"）。
 * 拿一个英文词根去判中文结果，会把「露营装备清单」这种明明切题的中文资料
 * 全判成不相关。这个方向的代价太大，所以别名一律不参与 —— 宁可少标。
 * （这一条是推理，不是实测：手上没有「中文主题 + 英文别名」的真实 plan 可量。）
 */
export function latinHead(plan: SearchPlan): string | null {
  let best: string | null = null;
  for (const m of plan.entity.name.matchAll(/[a-z]+/gi)) {
    const w = m[0].toLowerCase();
    if (w.length < MIN_HEAD_LEN) continue;
    if (!best || w.length > best.length) best = w;
  }
  return best;
}

/** 判定用的文本：标题 + 摘要，小写化。不读正文 —— 判定跑在抓取之前，那时还没有正文。 */
function judgeText(r: SearchResult): string {
  return `${r.title} ${r.snippet ?? ""}`.toLowerCase();
}

/**
 * 词法预筛。**必跑、零延迟、纯函数** —— 没有 key 也能用，所以要独立于模型那条路。
 *
 * 判定顺序（顺序本身是判据的一部分）：
 *
 *   1. 没有拉丁词根 → `uncertain`（弃权）。中文主题走这条：中文没有词边界，
 *      整名匹配太严、片段匹配太松 —— 实测「露营装备」整名匹配会把 55 条里的
 *      48 条（含 "Camping Gear Guide" 这种明显切题的）判成不相关。**弃权是正确的。**
 *   2. 文本里没有词根 → `unlikely`。**这是唯一会标「不相关」的情形。**
 *   3. 命中了 negatives → `uncertain`，**不是** `unlikely`。
 *      模型给的 negatives 里混着「兄弟型号」（实测把 `DeepSeek-V3`、`DeepSeek-R1`
 *      也列了进去），而「V3 对比 V4.1」这种结果同时含实体和 negative ——
 *      判死就是误杀。降一档到「不确定」，把最终判断留给能看见 intent 的模型。
 *   4. 其余 → `likely`。
 */
export function lexicalRelevance(r: SearchResult, plan: SearchPlan): Relevance {
  const head = latinHead(plan);

  if (!head) {
    return {
      verdict: "uncertain",
      reason: "主题里没有拉丁词根，本地规则不适用（中文没有词边界，硬匹配会误杀）",
      source: "lexical",
    };
  }

  const text = judgeText(r);

  if (!text.includes(head)) {
    return {
      verdict: "unlikely",
      reason: `标题与摘要里都没有出现「${head}」`,
      source: "lexical",
    };
  }

  const negative = plan.negatives.find((n) => {
    const t = n.trim().toLowerCase();
    return t.length > 0 && text.includes(t);
  });
  if (negative) {
    return {
      verdict: "uncertain",
      reason: `提到了可能要排除的「${negative}」`,
      source: "lexical",
    };
  }

  return { verdict: "likely", reason: `出现了「${head}」`, source: "lexical" };
}

/**
 * 合成两边的判定。**取更保守的那一档。**
 *
 * 保守的定义是「谁的结论更弱信谁」：
 *
 *   - 任一边 `unlikely` → `unlikely`（词法已经判死的不许被模型救回来）
 *   - 只有一边有 → 用那一边
 *   - 两边都在、档位相同 → 优先留模型那条（它看得到 intent，理由比「出现了 X」具体）
 *   - 两边都在、档位不同 → `uncertain`（有分歧就降级，不硬选一个）
 *
 * 特别注意最后两条：**模型能把 `likely` 降成 `uncertain`，但升不回去。**
 * 词法说「实体一个都没出现」时，模型看不见那件事（它拿到的是标题摘要，
 * 容易顺着 intent 脑补），所以那一条判定权必须留在词法手里。
 */
export function mergeRelevance(a: Relevance, b: Relevance): Relevance {
  if (a.verdict === "unlikely" || b.verdict === "unlikely") {
    return a.verdict === "unlikely" ? a : b;
  }
  if (a.verdict === b.verdict) {
    return a.source === "llm" ? a : b.source === "llm" ? b : a;
  }
  return {
    verdict: "uncertain",
    reason: `本地规则与模型判断不一致（${a.reason} / ${b.reason}）`,
    source: a.source === "llm" ? a.source : b.source,
  };
}

/** 界面上「35 条 · 其中 7 条疑似与主题不相关」要用的数字。 */
export function relevanceSummary(items: { relevance?: Relevance }[]): {
  judged: number;
  unlikely: number;
} {
  let judged = 0;
  let unlikely = 0;
  for (const it of items) {
    // 没有 relevance 的是**未判定**，不是「判过、没问题」—— 所以不计入 judged
    if (!it.relevance) continue;
    judged++;
    if (it.relevance.verdict === "unlikely") unlikely++;
  }
  return { judged, unlikely };
}
