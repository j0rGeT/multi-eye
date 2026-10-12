/**
 * 行业分类预设与匹配规则（叶子模块，不依赖 Node.js 内置模块，客户端与服务端通用）。
 *
 * 纪律：
 * 1. 行业筛选采用“注入查询 + 结果标注/排序加权”，不静默丢弃未命中结果。
 * 2. 匹配规则基于标题和摘要的词法匹配，快速、确定、可解释。
 */

export interface IndustryPreset {
  key: string;
  label: string;
  keywords: string[];
}

export const INDUSTRY_PRESETS: IndustryPreset[] = [
  {
    key: "llm-ai",
    label: "大模型/AI",
    keywords: ["大模型", "LLM", "人工智能", "机器学习", "深度学习", "推理", "训练", "Transformer", "MoE", "Agent"],
  },
  {
    key: "semi",
    label: "芯片半导体",
    keywords: ["芯片", "半导体", "晶圆", "制程", "EDA", "GPU", "NPU", "光刻", "封装", "存算一体"],
  },
  {
    key: "biomed",
    label: "生物医药",
    keywords: ["生物医药", "药物", "临床", "基因", "蛋白", "靶点", "抗体", "疫苗", "医疗器械"],
  },
  {
    key: "energy",
    label: "新能源",
    keywords: ["新能源", "电池", "光伏", "储能", "风电", "氢能", "电动车", "固态电池", "电网"],
  },
  {
    key: "fintech",
    label: "金融科技",
    keywords: ["金融科技", "支付", "量化", "风控", "清算", "区块链", "数字货币", "征信"],
  },
  {
    key: "ent-sw",
    label: "企业软件",
    keywords: ["企业软件", "SaaS", "ERP", "CRM", "协同办公", "云原生", "中间件", "数据库", "DevOps"],
  },
  {
    key: "consumer",
    label: "消费电子",
    keywords: ["消费电子", "智能手机", "可穿戴", "无人机", "智能家居", "XR", "VR", "AR", "耳机"],
  },
];

export interface IndustryMatch {
  matched: string[];
  score: number;
}

/**
 * 获取一组行业标签对应的展开关键词（预设标签展开为预设关键词，自定义标签使用原词）。
 */
export function industryKeywordsOf(tags: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const presetMap = new Map(INDUSTRY_PRESETS.map((p) => [p.label, p.keywords]));

  for (const tag of tags) {
    const trimmed = tag.trim();
    if (!trimmed) continue;
    const keywords = presetMap.get(trimmed) ?? [trimmed];
    map.set(trimmed, keywords);
  }
  return map;
}

/**
 * 把行业标签转换为可拼接到搜索语句的查询子句。
 * 格式例如：`("大模型" OR "LLM" OR "芯片" OR "半导体")`
 * 展开预设标签的具象技术关键词，确保搜索引擎能命中对应领域的专业文献，
 * 避免因直接拼接如 "大模型/AI" 这种带斜杠的展示分类名而导致检索召回骤降。
 */
export function industryClause(tags: string[] | undefined): string {
  if (!tags || tags.length === 0) return "";
  const kwMap = industryKeywordsOf(tags);
  const terms = new Set<string>();
  for (const kws of kwMap.values()) {
    // 挑选每个行业中最具区分度的前 2~3 个核心关键词注入检索语句，避免变体过长超出引擎上限
    for (const kw of kws.slice(0, 3)) {
      if (kw.trim()) terms.add(kw.trim());
    }
  }
  if (terms.size === 0) return "";
  return `(${[...terms].map((t) => `"${t}"`).join(" OR ")})`;
}

/**
 * 校验单条搜索结果是否命中所选行业。
 */
export function matchIndustries(
  result: { title: string; snippet?: string; domain?: string },
  tags: string[] | undefined,
): IndustryMatch {
  if (!tags || tags.length === 0) {
    return { matched: [], score: 1 };
  }

  const text = `${result.title} ${result.snippet ?? ""}`.toLowerCase();
  const kwMap = industryKeywordsOf(tags);
  const matchedTags: string[] = [];

  for (const [tag, keywords] of kwMap.entries()) {
    const hit = keywords.some((kw) => text.includes(kw.toLowerCase()));
    if (hit) {
      matchedTags.push(tag);
    }
  }

  const score = tags.length > 0 ? matchedTags.length / tags.length : 1;
  return {
    matched: matchedTags,
    score,
  };
}
