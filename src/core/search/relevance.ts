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

// ─────────────────────── 体裁预筛（招聘 / 招标 / 二手）───────────────────────

/**
 * 「字面相关、主题跑偏」的体裁识别。
 *
 * ── 它要解决什么 ──
 *
 * 用户原话：搜 `Mooncake kvcache 资料`，搜出来**招聘信息**，内容里确实有
 * `KVCache`、`Mooncake`，字面完全相关，但那不是用户要的东西。
 *
 * 实测反例（会话 `bmXwa3Dxzc`，主题 `MoonCake`、意图「主要关注Kvcache变化」）：
 *
 *   job.xiaohongshu.com/campus/position/17017  【2026校招】KVCache/高性能存储开发工程师
 *     → likely，score 0.9，理由「出现了「kvcache」」
 *   job.xiaohongshu.com/campus/intern/position/21702  实习生招聘 - 小红书校园招聘
 *     → likely，score 0.9，理由「出现了「mooncake」」
 *
 * 下面的词法判定只问「关键词出现了没有」，而**招聘 JD 恰恰是关键词密度最高
 * 的一类文本** —— 它的岗位职责里写的就是你要找的那些技术。这是体裁问题，
 * 不是相关性问题，调阈值调不出来：得先认出「这压根不是一份资料」。
 *
 * ── 判据的两条硬规矩（防误杀）──
 *
 *  1. **只认域名与标题形态，不认摘要里的词。** 正文里出现「招聘」的技术分析
 *     （「从一次校招面试看 KVCache 的考察方式」）是好资料；反过来，标题里带
 *     `岗位职责` / `任职资格` 的几乎不可能是技术资料。判据落在**体裁的标志性
 *     结构**上，而不是某一个词。
 *  2. **用户自己在查什么，就不拦什么。** 主题或意图里明写了「招聘」时，
 *     招聘结果**就是**用户要的资料。拿通用规则否掉用户显式要的东西，
 *     比漏判更糟。
 */
export type OffTopicCategory = "招聘" | "招标采购" | "二手交易" | "用户个人主页";

/** 招聘类平台域名。用「等于该域或以 `.<域>` 结尾」匹配，`includes` 会放过 `zhipin.com.evil.com`。 */
const JOB_DOMAINS = [
  "zhipin.com", // BOSS直聘
  "lagou.com", // 拉勾
  "liepin.com", // 猎聘
  "51job.com", // 前程无忧
  "zhaopin.com", // 智联招聘
  "yingjiesheng.com", // 应届生
  "nowcoder.com", // 牛客（岗位列表页）
  "maimai.cn", // 脉脉
];

/** 二手交易平台域名。 */
const TRADE_DOMAINS = [
  "xianyu.com", // 闲鱼
  "goofish.com", // 闲鱼（新域名）
  "zhuanzhuan.com", // 转转
  "paipai.com",
];

/**
 * 招聘子域前缀。
 *
 * 只匹配**主机名的第一段**：`job.xiaohongshu.com` 命中，而 `github.com/jobs/…`
 * 不命中 —— 那是路径不是子域，路径不进这条判据（一个站的 `/jobs/` 目录
 * 完全可能是别的东西）。
 */
const JOB_SUBDOMAINS = ["job", "jobs", "careers", "career", "zhaopin", "hr"];

/** 招标 / 采购公告的标志性标题 —— 公文体，不可能是技术资料。 */
const TENDER_TITLE =
  /(招标公告|中标公告|询价公告|采购公告|竞争性磋商|投标邀请|中标结果公示)/;

function pathOf(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return "";
  }
}

/** 招聘专有路径特征（如 /campus/position/、/campus/intern/、/recruitment/ 等） */
const JOB_PATH_MARKER =
  /^\/(campus|job|jobs|career|careers|intern|recruitment|position)(\/|$)|(\/position\/\d+)/i;

/**
 * 招聘 JD 的标志性标题。四组都要求**结构性**证据：
 *
 *  · 【…校招…】这种方括号标签 —— 中文招聘标题的固定写法
 *  · 「岗位职责 / 任职资格 / 职位描述」—— JD 正文才有的小标题
 *  · 标题以「校园招聘 / 社会招聘」等收尾
 *  · 标题含招聘特征结构：如 "实习生招聘"、"诚聘...工程师"、"招聘...开发"
 *
 * 刻意**不**含单独的「招聘」「实习」「内推」：这三个词在技术文章标题里会
 * 真实出现（「实习生存量系统实践」就是一篇好资料）。
 */
const JD_TITLE_BRACKET = /^【[^】]*(校招|社招|春招|秋招|招聘|内推|急聘|诚聘)[^】]*】/;
const JD_TITLE_MARKER = /(岗位职责|任职资格|职位描述|岗位要求|薪资面议)/;
const JD_TITLE_SUFFIX =
  /(校园招聘|社会招聘|实习生招聘|招聘启事|招聘简章|职位列表|岗位列表)[\s·\-—|]*$/;
const JD_TITLE_KEYWORDS =
  /(招聘[^\s|·—]*工程师|诚聘[^\s|·—]*|急聘[^\s|·—]*|实习生招聘|校招内推)/;

/** 二手/交易：处置动作 + 价格信号同时出现才算。 */
const TRADE_TITLE = /(转让|出售|求购|闲置)[^。]{0,20}(元|价格|包邮|议价|￥|¥)/;

function hostOf(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}

function hasSuffix(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function firstLabel(host: string): string {
  const dot = host.indexOf(".");
  return dot > 0 ? host.slice(0, dot) : host;
}

/**
 * 这条结果是不是「用户要的资料」之外的体裁；是就返回类目名，否则 `null`。
 *
 * 域名判据优先于标题：域名是硬事实，标题形态是概率证据。
 * `userWants` 传主题原话 + 意图提示的拼串 —— 用户在查这个类目时返回 `null`。
 */
export function offTopicCategory(
  r: Pick<SearchResult, "url" | "title">,
  opts: { userWants?: string } = {},
): OffTopicCategory | null {
  const hit = matchCategory(r);
  if (!hit) return null;
  if ((opts.userWants ?? "").includes(hit)) return null;
  return hit;
}

function matchCategory(r: Pick<SearchResult, "url" | "title">): OffTopicCategory | null {
  const host = hostOf(r.url);
  const path = pathOf(r.url);
  const title = (r.title ?? "").trim();

  if (host) {
    if (JOB_DOMAINS.some((d) => hasSuffix(host, d))) return "招聘";
    if (TRADE_DOMAINS.some((d) => hasSuffix(host, d))) return "二手交易";
    if (JOB_SUBDOMAINS.includes(firstLabel(host))) return "招聘";
    // B站用户个人主页空间 (space.bilibili.com)
    if (host === "space.bilibili.com" || host.endsWith(".space.bilibili.com")) {
      return "用户个人主页";
    }
  }

  // 路径特征匹配（如 job.xiaohongshu.com/... 或任意主站下的 /campus/position/）
  if (path && JOB_PATH_MARKER.test(path)) {
    return "招聘";
  }

  // 站点用户主页或动态路径（如 bilibili.com/space/ 或 bilibili.com/dynamic）
  if (host && /(^|\.)bilibili\.com$/.test(host) && path && /^\/(space|member|dynamic)(\/|$)/i.test(path)) {
    return "用户个人主页";
  }

  if (!title) return null;
  if (
    JD_TITLE_BRACKET.test(title) ||
    JD_TITLE_MARKER.test(title) ||
    JD_TITLE_SUFFIX.test(title) ||
    JD_TITLE_KEYWORDS.test(title)
  ) {
    return "招聘";
  }
  if (TENDER_TITLE.test(title)) return "招标采购";
  if (TRADE_TITLE.test(title)) return "二手交易";
  return null;
}

/**
 * 词法预筛。**必跑、零延迟、纯函数** —— 没有 key 也能用，所以要独立于模型那条路。
 *
 * 判定顺序（顺序本身是判据的一部分）：
 *
 *   0. 体裁预筛（招聘 / 招标 / 二手）→ `unlikely`。**这一步不看关键词**，
 *      它问的是「这压根是不是一份资料」，见 `offTopicCategory` 上面那段实测反例。
 *   1. 没有拉丁词根、也没有关联词 → `uncertain`（弃权）。中文主题走这条：中文没有词边界，
 *      整名匹配太严、片段匹配太松 —— 实测「露营装备」整名匹配会把 55 条里的
 *      48 条（含 "Camping Gear Guide" 这种明显切题的）判成不相关。**弃权是正确的。**
 *   2. 文本里没有词根、也没有关联词 → `unlikely`。词法这一侧**唯一**的另一种「不相关」。
 *   3. 命中了 negatives → `uncertain`，**不是** `unlikely`。
 *      模型给的 negatives 里混着「兄弟型号」（实测把 `DeepSeek-V3`、`DeepSeek-R1`
 *      也列了进去），而「V3 对比 V4.1」这种结果同时含实体和 negative ——
 *      判死就是误杀。降一档到「不确定」，把最终判断留给能看见 intent 的模型。
 *   4. 其余 → `likely`。
 */
export function lexicalRelevance(r: SearchResult, plan: SearchPlan): Relevance {
  /*
    体裁先于相关性。放在最前面是有意的：第 1、2 步都要看「关键词出现了没有」，
    而招聘 JD 的关键词密度恰恰最高 —— 先问相关性，它必然被判成高分相关。

    `userWants` 把主题原话和意图提示一起给它，用户自己在查招聘时不拦。
  */
  const category = offTopicCategory(r, {
    userWants: `${plan.raw} ${plan.userIntent ?? ""} ${plan.intent}`,
  });
  if (category) {
    return {
      verdict: "unlikely",
      reason: `属于「${category}」类结果，不是调研资料`,
      source: "lexical",
      score: 0.05,
      match: "unclear",
    };
  }

  const head = latinHead(plan);
  const text = judgeText(r);
  const related = (plan.relatedTerms ?? []).filter((term) => {
    const normalized = term.trim().toLowerCase();
    return normalized.length > 0 && text.includes(normalized);
  });

  if (!head && related.length === 0) {
    return {
      verdict: "uncertain",
      reason: "主题里没有拉丁词根，本地规则不适用（中文没有词边界，硬匹配会误杀）",
      source: "lexical",
      score: 0.5,
      match: "unclear",
    };
  }

  if (head && !text.includes(head) && related.length === 0) {
    return {
      verdict: "unlikely",
      reason: `标题与摘要里都没有出现「${head}」`,
      source: "lexical",
      score: 0.05,
      match: "unclear",
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
      score: 0.35,
      match: "unclear",
    };
  }

  if (related.length > 0 && (!head || !text.includes(head))) {
    return {
      verdict: "likely",
      reason: `命中关联词「${related.join("、")}」`,
      source: "lexical",
      score: Math.min(0.85, 0.55 + related.length * 0.1),
      match: "related",
    };
  }

  return {
    verdict: "likely",
    reason: `出现了「${head}」`,
    source: "lexical",
    score: 0.9,
    match: "direct",
  };
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
    const preferred = a.source === "llm" ? a : b.source === "llm" ? b : a;
    const scores = [a.score, b.score].filter(
      (score): score is number => typeof score === "number",
    );
    return {
      ...preferred,
      ...(scores.length > 0 ? { score: Math.max(...scores) } : {}),
      match: preferred.match ?? (a.match ?? b.match),
    };
  }
  return {
    verdict: "uncertain",
    reason: `本地规则与模型判断不一致（${a.reason} / ${b.reason}）`,
    source: a.source === "llm" ? a.source : b.source,
    ...([a.score, b.score].some((score) => typeof score === "number")
      ? {
          score: Math.max(
            ...[a.score, b.score].filter(
              (score): score is number => typeof score === "number",
            ),
          ),
        }
      : {}),
    match: a.match === "related" || b.match === "related" ? "related" : "unclear",
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
