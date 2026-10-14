/**
 * 全局类型契约。
 *
 * 全项目的模块边界都围绕这个文件：搜索层、抓取层、图构建层、下载层各自可独立
 * 替换，只要它们吐出的形状不变。前端只认 GraphModel，不关心背后是启发式还是 LLM。
 */

// ─────────────────────────── 站点与提供方 ───────────────────────────

/** 支持定向检索的站点。'web' 表示不做 site: 限定的全网兜底。 */
export type SiteKey =
  | "zhihu"
  | "csdn"
  | "cnblogs"
  | "segmentfault"
  | "v2ex"
  | "infoq"
  | "juejin"
  | "wechat"
  | "xiaohongshu"
  | "youtube"
  | "x"
  | "bilibili"
  | "hackernews"
  | "github"
  | "arxiv"
  | "rss"
  | "web";

/** 实际发出请求的搜索后端。 */
export type ProviderId =
  | "serper"
  | "searxng"
  | "ytdlp"
  | "bilibili"
  | "hackernews"
  | "github"
  | "arxiv"
  | "rss";

// ─────────────────────────── 搜索层 ───────────────────────────

/**
 * 时效筛选窗口。
 *
 * 注意它同时作用在两处，缺一不可：一是作为 `time_range` 参数交给上游引擎
 * （部分引擎认，bing 这类不认），二是拿到结果后**在本地按 publishedAt 兜底过滤**。
 * 只做前者会出现「勾了一周内，结果里却混着三年前的资料」这种静默失效。
 */
export type TimeRange = "day" | "week" | "month" | "year";

/**
 * 搜索结果的融合排序方式。
 *
 * `relevant` 是默认，也是这套系统一直以来的行为：多源印证优先，其次按上游排名。
 * 其余三种是用户在界面上显式选择的 —— **不静默改变默认排序**，
 * 因为「多源印证优先」是这套系统的核心主张，换掉它得由用户自己决定。
 *
 * `quality` 排的是**客观指标**（star 数、播放量、评论数），不是「可信度」。
 * 一个高 star 的仓库仍然是「被很多人 star 了」，不是「内容正确」——
 * 这两件事不能混。详见 `ResultSignal` 的注释。
 */
export type SortMode = "relevant" | "recent" | "mixed" | "quality";

export interface SearchQuery {
  text: string;
  site?: SiteKey;
  /** 任意域名定向（如 blog.csdn.net）。与 site 二选一，优先于 site。 */
  domain?: string;
  limit?: number;
  language?: string;
  /** 时效窗口。provider 应尽量透传给上游（有的认有的不认），本地兜底由调用方做。 */
  timeRange?: TimeRange;
  /**
   * 用户选定的排序方式。provider 可以拿它去**换一个更合适的上游排序参数**
   * （`sortMode: "recent"` 时让 B站按发布时间检索，比事后在本地筛更可靠）。
   *
   * 但它**不能**拿它来改变自己返回什么：融合排序由 `rankResults` 统一做，
   * provider 只负责把最好的那批结果拿回来。
   */
  sortMode?: SortMode;
  /** 用户选定的行业标签列表（可选）。不填表示搜索全部行业。 */
  industries?: string[];
  /** 用户选定的搜索迭代深度。 */
  depth?: number;
}

/**
 * 搜索词的**分析结果**。
 *
 * 存在的理由是一个实测出来的毛病：`DeepSeek-V4.1-Flash` 这种带连字符的型号名
 * 会被后端拆成 `deepseek` / `v4.1` / `flash` 三个通用 token，于是搜回来一批
 * 只在版本号上撞车的无关内容（实测 35 条里有 7 条连「DeepSeek」都没出现，
 * 包括一个 ERP 产品的「v4.1.7 发布」）。
 *
 * 它同时服务两件事：
 *   1. **改写各站点的查询**（`variants`）—— B 站的视频口播、知乎的问答、
 *      GitHub 的仓库名，各自的最优查询并不相同
 *   2. **给相关性判定提供判据**（`entity` / `disambiguators` / `negatives`）——
 *      没有一份「用户到底想查什么」的明确表述，就没法说某条结果不切题
 *
 * `raw` 永远逐字保留用户原话。任何字段被改烂都只是搜索质量下降，
 * 不能变成「用户说的话被丢了」。
 */
export interface SearchPlan {
  /** 用户原话，逐字保留。 */
  raw: string;
  /**
   * 用户额外填写的意图提示，逐字保留。
   *
   * 与 `raw` 分开存：关键词是“搜什么”，意图提示是“为什么搜、要看哪些方面”。
   * 合成一个字段后，刷新页面就没法把两者分别展示，也没法在分析失败时仍原样带回去。
   */
  userIntent?: string;
  /** 一句话说明这次要查什么。 */
  intent: string;
  /** 最能代表主题的专有名词与它的其他写法。`name` 为空串表示没有明确实体。 */
  entity: { name: string; aliases: string[] };
  /** 用来消歧的限定词，如「大语言模型」「开源的」。 */
  disambiguators: string[];
  /** 应当排除的主题，如「招聘」「股价」。 */
  negatives: string[];
  /**
   * 与主题紧密相关的技术词/概念词，例如查 `DeepSeek-V4-Flash` 时的 `KVCache`。
   *
   * 这些词不是替代主题，而是用于扩展检索和关联度排序的线索。旧分析结果没有
   * 这个字段，所以读取方必须允许它缺失。
   */
  relatedTerms?: string[];
  /**
   * 站点 → 针对该站点改写后的**查询正文**。
   *
   * 刻意不含站点关键词与 `site:` 语法 —— 那是 `buildQuery`（`search/sites.ts`）
   * 的职责，在这里再拼一次会得到「知乎 知乎」。
   */
  variants: Partial<Record<SiteKey, string>>;
  /** 用户选定的行业限定标签。 */
  industries?: string[];
  /** 这份分析是谁给的。`lexical` 表示没走上 LLM，此时行为与加这个功能之前逐字一致。 */
  source: "llm" | "lexical";
  /** `source === "lexical"` 时为什么没走上 LLM。 */
  fallbackReason?: string;
}

/** 一条结果切不切题。`uncertain` 表示**不标记**，不是「可能不相关」。 */
export type RelevanceVerdict = "likely" | "unlikely" | "uncertain";

/**
 * 相关性判定结果。
 *
 * ── 它**不是**质量分 ──
 *
 * `quality.ts` 开头写着「不用语言模型打质量分」，那条边界没有被这个字段推翻。
 * 两者回答的是不同的问题：
 *
 *   - 相关性：**「这条切不切你的题」** —— 判据是用户自己给的查询，可对照、可复现
 *   - 质量：**「拿没拿到正文」** —— 见 `bodyGrade`
 *
 * 而这个系统**在任何地方都不回答「内容对不对」**。一个切题的结果完全可能是错的；
 * 一个不切题的结果完全可能是对的（只是不是你要的）。所以：
 *
 *   - 绝不拿它去改 `bodyGrade`，也绝不合成任何「综合评分」
 *   - **不删除**（延续「绝不静默丢东西」）—— 排序仍由 `rankResults` 决定。
 *     关联度只做同印证数下的 tie-breaker，默认的「多源印证优先」不变。
 */
export interface Relevance {
  verdict: RelevanceVerdict;
  /** 为什么这么判，给人看的一句话。 */
  reason: string;
  /** 这一判是谁给的。`lexical` 是本地规则（可复现），`llm` 是模型批量判定。 */
  source: "lexical" | "llm";
  /**
   * 关联度 0~1。它回答“这条资料和用户意图有多贴近”，**不是内容质量或可信度**。
   *
   * 允许缺失：旧会话里的判定没有这个字段，缺失时调用方按未量化处理。
   */
  score?: number;
  /** 命中方式：直接命中主题、只命中关联词，还是拿不准。 */
  match?: "direct" | "related" | "unclear";
}

/**
 * 一条结果自带的客观量化信号 —— 播放量、star 数、评论数这类**上游本来就给了的事实**。
 *
 * 刻意做成「标签 + 数值」的开放列表，而不是一组固定字段：每个源能给的指标
 * 完全不同（GitHub 有 star 没有播放量，视频站反过来），硬塞进统一字段的结果
 * 是大部分源留空、UI 里一排 `undefined`。
 *
 * 更刻意的是：**绝不把这些合成一个「质量分」**。把「12k star」和「45 条评论」
 * 加权成一个 0~100 的数字，看起来精确，其实权重是拍脑袋定的、且不同源之间
 * 根本没有可比性。摆出原始数字、让用户自己判断，是这个项目一贯的做法。
 */
export interface ResultSignal {
  /** 展示标签，如 "播放" / "star" / "评论"。 */
  label: string;
  value: number;
  /**
   * 数值怎么读。`count` 走 1.2k / 3.4万 的紧凑写法，`duration` 当秒数读，
   * 缺省原样显示（星标数、楼层号这类不该缩写的）。
   */
  format?: "count" | "duration";
}

/** 搜索结果的参考价值档位。`medium` 是拿不准时的默认，不是「不好」。 */
export type ValueVerdict = "high" | "medium" | "low";

/**
 * 搜索阶段的价值预判（基于标题+摘要+域名，正文还没抓）。
 *
 * ── 它与 `Relevance` 的边界 ──
 *
 *   - `Relevance` 回答「切不切你的题」，判据是用户原话，任何时候都在跑；
 *   - `ValueAssessment` 回答「即使切题，它看起来像不像有实质内容」，
 *     判据是**标题与摘要给的第一印象** —— 标题党、登录墙、纯转载列表页
 *     这类「搜索阶段就能看出不值一抓」的条目在这里被标出来。
 *
 * 两者同样**只标记不删除**：`low` 结果仍然留在列表、报告与下载包里，
 * 只是默认不为它花抓取成本（见 `/api/fetch` 的 `pickTargets`）。
 */
export interface ValueAssessment {
  verdict: ValueVerdict;
  /** 一句话依据。必须指向给它的材料里能看见的东西。 */
  reason: string;
  /** 整理分类，如「部署实践」「原理分析」。 */
  category: string;
}

export interface SearchResult {
  /** sha1(归一化 URL) 的前 16 位，用作跨 provider 的稳定去重键。 */
  id: string;
  title: string;
  url: string;
  snippet: string;
  domain: string;
  site: SiteKey;
  /** 实际命中的提供方，便于排查「这条结果是哪来的」。 */
  provider: ProviderId;
  /** 该 provider 内的原始排名，用于融合排序。 */
  rank: number;
  /**
   * 命中这条结果的**去重后** provider 数。
   *
   * 注意它不是「可信度」：一个病毒式假消息同样会被很多来源提到。
   * 它回答的是「有几个独立入口指向这里」，不是「有几个独立来源证实了它」——
   * 后者还要再排除同源转载（见 `Document.duplicateOf`）。
   *
   * **它是 `sources` 的长度**，不是「被报答了几次」。同一个 provider 可能在
   * 多个站点桶里各返回一次同一个 URL（searxng 就会），那些是同一个入口。
   */
  hitCount: number;
  /**
   * 命中的 provider 列表（去重）。`hitCount === sources.length`。
   *
   * 存下来是为了界面上能说清「是哪几个来源」—— 只给一个数字，用户没法判断
   * 这几个入口是不是同一类（比如三个都是搜索引擎，那印证力远不如
   * 「一个搜索引擎 + 一个 Hacker News」）。
   */
  sources?: ProviderId[];
  publishedAt?: string;
  author?: string;
  thumbnail?: string;
  durationSec?: number;
  /** 上游给的客观指标。没有就是 undefined —— 不编造，也不填 0。 */
  signals?: ResultSignal[];
  /**
   * 是否切题。不删除；关联度分数只在 `rankResults` 里做同印证数的 tie-breaker。
   *
   * 可选：旧会话没有这个字段，读取方必须把 `undefined` 当「**未判定**」——
   * 绝不当成 `unlikely`。把「没测过」读成「测出来是坏的」是最容易犯、
   * 也最难发现的一类错。
   */
  relevance?: Relevance;
  /**
   * 搜索阶段的价值预判（标题+摘要层面）。
   *
   * 可选：无 LLM、判定超时、或旧会话加载时为 `undefined`，读取方必须把
   * `undefined` 当「**未预判**」—— 绝不当成 `low`。抓取层只跳过
   * `verdict === "low"` 的条目，未预判的一律放行。
   */
  value?: ValueAssessment;
  /** 行业分类匹配判定（只标注，不删除）。 */
  industryMatch?: { matched: string[]; score: number };
}

export interface ProviderCapabilities {
  /** 是否支持 site:/domain 定向语法。yt-dlp 不支持（它只能搜 YouTube）。 */
  supportsSiteSyntax: boolean;
  supportsVideo: boolean;
  needsApiKey: boolean;
  /**
   * 这个 provider 是「按站点查」还是「按主题查」。缺省 `"site"`。
   *
   * 这个区分不是分类癖，它决定调用方式：**`site` 类会被放进「每个勾选站点
   * 各跑一遍」的循环里，`topic` 类整个主题只跑一次**。
   *
   * 对 GitHub 这类有严格配额的接口，这个区别是致命的：未认证的 GitHub
   * Search 只有 10 次/分钟，而站点点一下可能勾六七个，放进循环里一轮就把
   * 配额打光，剩下全是 429。HN/GitHub/arXiv 这类「一个接口覆盖全站」的源
   * 天然属于 topic 类。
   */
  scope?: "site" | "topic";
}

export interface SearchProvider {
  readonly id: ProviderId;
  readonly capabilities: ProviderCapabilities;
  /** 探测网络/API key/二进制是否就绪。用于 /api/health 与 fallback 链构建。 */
  available(): Promise<boolean>;
  search(q: SearchQuery, signal?: AbortSignal): Promise<SearchResult[]>;
}

// ─────────────────────────── 文档层 ───────────────────────────

export type DocKind = "article" | "video" | "social" | "unknown";

/** 正文是怎么拿到的。降级链每往下走一级，质量就降一档。 */
export type ExtractMethod =
  | "readability"
  | "playwright"
  | "ytdlp-subtitle"
  /** B站公开接口（标题/标签/简介/字幕）。不是页面提取，所以单列一项。 */
  | "bilibili-api"
  | "raw";

export interface DocImage {
  url: string;
  alt?: string;
  width?: number;
  height?: number;
}

export interface Document {
  /** 与 SearchResult.id 对齐，保证能反查回搜索结果。 */
  id: string;
  url: string;
  title: string;
  site: SiteKey;
  kind: DocKind;
  /** 清洗后的正文纯文本 —— TF-IDF 与共现图的输入。 */
  text: string;
  /** HTML 转来的 Markdown，供报告与下载使用。 */
  markdown?: string;
  excerpt: string;
  lang: "zh" | "en" | "unknown";
  author?: string;
  publishedAt?: string;
  images: DocImage[];
  /** 上游给出的封面/缩略图，视频预览优先使用它。 */
  thumbnail?: string;
  wordCount: number;
  extractMethod: ExtractMethod;
  extractMs: number;
  fetchedAt: string;
  /** 命中大小上限被截断。显式标记，而不是静默截断。 */
  truncated?: boolean;
  /**
   * 与哪篇文档同源（转载）。值是**代表文档**的 id —— 抓取最早的那一篇。
   *
   * **只标记，不删除**：被标了也照样出现在结果列表、报告和下载里。
   * 这个字段只改变一件事 —— 统计「独立出处」时，同一组的成员算一个。
   * 见 `search/dedupe.ts` 开头关于「宁可漏判不可误判」的说明。
   */
  duplicateOf?: string;
  /**
   * 整理阶段（`/api/refine` 的 LLM）给这篇资料归的类。
   *
   * 可选：只有走过整理才会写。它不参与任何判定 —— 只用于把已抓取的资料
   * 按主题分组展示，以及给下一轮补搜提供「这批已经覆盖了哪些角度」的依据。
   */
  category?: string;
  /**
   * 整理阶段判定为「对本主题参考价值低」的标记，值是判定理由。
   *
   * **只标记、不删除** —— 与 `duplicateOf` 同一条纪律：资料仍然留在列表、
   * 报告与下载包里，图和整理列表默认不展示它，但用户随时能看回来。
   * 理由必须留着：一个没有理由的「低价值」标记无法被核实，等于凭空删数据。
   */
  lowValue?: { reason: string };
  /**
   * 抓取失败的原因。注意：失败仍会产出 Document（正文退化为 snippet），
   * 而不是抛异常 —— 单篇失败不该中断整个主题的流程。
   */
  error?: string;
  /**
   * 从对应的 `SearchResult` 复制过来的切题判定。
   *
   * 复制而不是让下游自己去 `results.find(...)`：正文、报告、下载包、界面都要读它，
   * 每处再建一次索引既是重复劳动，也容易出现「某一处漏了 join」这种局部失灵。
   * `undefined` = 未判定，**不是**不相关。
   */
  relevance?: Relevance;
}

// ─────────────────────────── 图模型 ───────────────────────────

export type NodeKind = "keyword" | "entity" | "document";
export type EdgeKind = "cooccur" | "relation" | "contains";

export interface GraphNode {
  id: string;
  /** 展示名（中文原词，保留大小写）。 */
  label: string;
  kind: NodeKind;
  /** TF-IDF 聚合权重，前端映射为节点大小。 */
  weight: number;
  degree: number;
  /** 支撑该节点的文档，用于「点节点看资料」。 */
  docIds: string[];
  clusterId: string;
  /** kind='entity' 时由 LLM 给出的类型：人物/组织/技术/概念。 */
  type?: string;
  aliases?: string[];
  /** 支撑文档的最早发布年份（用于时间分层与趋势图；保证所有节点均具备年份，缺失时通过拓扑邻居/簇/语料时序推导）。 */
  publishedYear?: number;
  /** 年份是否为推导得出（而非支撑文档确切 publishedAt 原生提取）。用于界面区分真实资料时间与推导演进时序。 */
  isYearInferred?: boolean;
  /** 支撑文档的最早 ISO 发布时间戳。 */
  firstPublishedAt?: string;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  weight: number;
  /** kind='relation' 时的关系谓词（仅 LLM 路径有）。 */
  label?: string;
  evidence?: string[];
}

export interface Cluster {
  id: string;
  label: string;
  nodeIds: string[];
  docIds: string[];
  /** 簇内权重 top 5 的词，用于前端图例。 */
  topTerms: string[];
  size: number;
  /** heuristic 为统计式一句话；llm 为模型撰写的综述。 */
  summary: string;
}

export interface GraphStats {
  nodeCount: number;
  edgeCount: number;
  clusterCount: number;
  docCount: number;
  generatedBy: "heuristic" | "llm";
  durationMs: number;
  /** LLM 路径失败降级时的原因，否则调用方无从知道为什么没走上 LLM。 */
  llmFallbackReason?: string;
}

export interface GraphModel {
  /** 契约版本。前端据此判断快照是否兼容。 */
  version: 1;
  topic: Topic;
  nodes: GraphNode[];
  edges: GraphEdge[];
  clusters: Cluster[];
  stats: GraphStats;
}

export interface GraphBuilder {
  readonly id: "heuristic" | "llm";
  available(): Promise<boolean>;
  build(topic: Topic, docs: Document[], signal?: AbortSignal): Promise<GraphModel>;
}

// ─────────────────────────── 主题与持久化 ───────────────────────────

export interface Topic {
  id: string;
  query: string;
  /** 用户额外填写的意图提示。旧会话没有该字段。 */
  intent?: string;
  sites: SiteKey[];
  createdAt: string;
  updatedAt: string;
}

/**
 * 用户在这张图上留下的界面状态。
 *
 * 放在 Session 而不是 GraphModel：这是**一次会话的界面状态**，不是图的语义。
 * GraphModel 是启发式与 LLM 两条构图路径共用的契约，不该被 UI 概念污染 ——
 * 服务端导出 Markdown 时也不需要知道用户把某个节点拖到了哪里。
 */
export interface SessionViewState {
  /** 节点位置，nodeId → {x, y}。用户拖过、或布局算出来的。 */
  positions?: Record<string, { x: number; y: number }>;
  /** 被用户锁定（扛得住「重新布局」）的节点 id。 */
  pinned?: string[];
  /** 是否显示文档节点。 */
  showDocuments?: boolean;
  /** 拓扑图布局模式：自由力导向(free) 或 按年份分层(yearly)。 */
  layoutMode?: "free" | "yearly";
  /** 是否展示拓扑图下方的节点时间趋势折线图。 */
  showTimeline?: boolean;
}

/**
 * 这次搜索用的时效选项。落盘是为了让界面刷新后能如实复原当时的口径 ——
 * 报告里写了「一周内」，那么它会话文件里就得有这一条，否则事后无从解释
 * 为什么同一主题两次搜出来的资料差那么多。
 */
export interface SearchOptions {
  timeRange?: TimeRange;
  sortMode?: SortMode;
  /** 本次搜索的用户意图提示。 */
  intent?: string;
  /** 本次搜索选定的行业标签。 */
  industries?: string[];
  /** 本次搜索配置的迭代深度。 */
  depth?: number;
}

/**
 * 一次抓取后的整理与补搜记录。
 *
 * 只记录“这轮看到了什么、下一轮搜什么”，不改写原始资料；界面据此显示轮次，
 * 报告也能说明为什么同一批结果比第一轮多了几条。
 */
export interface RefinementRecord {
  iteration: number;
  at: string;
  summary: string;
  categories: string[];
  missingAngles: string[];
  queries: string[];
  avoidPatterns: string[];
  added: number;
  fallbackReason?: string;
}

/** 一次搜索会话的完整快照，落盘为 data/sessions/<id>/session.json。 */
export interface Session {
  topic: Topic;
  results: SearchResult[];
  documents: Document[];
  graph?: GraphModel;
  /** 每个 provider 在本次会话中的表现，用于排查「为什么某站点没结果」。 */
  providerLog: ProviderLogEntry[];
  /** 图上的位置、锁定与显示开关。刷新页面后据此复原。 */
  viewState?: SessionViewState;
  /**
   * 搜索发生的时刻。用于「这次会话已经放了 N 天」的过时提示。
   *
   * 可选：这个字段是后加的，磁盘上已有的旧会话没有它。读取方必须回退到
   * `topic.createdAt`（一直都在），两条路都走不通才认为无从判断。
   */
  createdAt?: string;
  /** 本次搜索的时效口径。旧会话没有，按「未筛未排」处理。 */
  searchOptions?: SearchOptions;
  /** 本次搜索的查询分析。旧会话没有该字段，恢复时按“未分析”处理。 */
  plan?: SearchPlan;
  /** 抓取后的整理/补搜轮次。最多三轮，避免自动循环失控。 */
  refinements?: RefinementRecord[];
}

export interface ProviderLogEntry {
  provider: ProviderId;
  site: SiteKey;
  ok: boolean;
  count: number;
  ms: number;
  error?: string;
}

// ─────────────────────────── 下载层 ───────────────────────────

export type DownloadKind = "article" | "image" | "transcript" | "media";
export type TaskStatus =
  | "queued"
  | "running"
  | "paused"
  | "done"
  | "failed"
  | "canceled";
export type JobStatus = TaskStatus | "partial";

export interface DownloadTask {
  id: string;
  jobId: string;
  sessionId: string;
  docId: string;
  url: string;
  kind: DownloadKind;
  status: TaskStatus;
  bytesTotal?: number;
  bytesDone: number;
  attempts: number;
  /** 相对 data/sessions/<id>/assets/ 的路径。 */
  outputPath?: string;
  /** 服务端是否回了 206，决定能否续传。 */
  resumeSupported?: boolean;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface DownloadJob {
  id: string;
  sessionId: string;
  status: JobStatus;
  tasks: DownloadTask[];
  concurrency: number;
  createdAt: string;
  updatedAt: string;
}

/** SSE 传输的信封。客户端据 type 分派。 */
export type ProgressEvent =
  | {
      type: "snapshot";
      job: DownloadJob;
      /**
       * 这个任务是否还活在服务端进程里。
       *
       * 磁盘上的 tasks.json 会把一个被杀掉的任务永远停在 running，
       * 只看状态字段没法区分「在跑」和「上次死了」。false 表示需要用户点继续。
       */
      live: boolean;
      at: string;
    }
  | { type: "task"; task: DownloadTask; at: string }
  | { type: "job"; job: DownloadJob; at: string }
  | { type: "error"; message: string; at: string };

// ─────────────────────────── 搜索的流式事件 ───────────────────────────

/** /api/search 通过 SSE 逐步回传，让用户不用干等全部站点返回。 */
export type SearchEvent =
  | {
      type: "plan";
      topic: Topic;
      /** 分析结果。界面据此说明「把这句话理解成了什么」。 */
      plan: SearchPlan;
      /** 实际会发给各站点的查询串，由 `plan` 派生 —— 与真实扇出同一份来源。 */
      queries: string[];
    }
  | { type: "results"; site: SiteKey; results: SearchResult[] }
  | {
      type: "relevance";
      /**
       * 切题判定，`SearchResult.id → Relevance`。
       *
       * 单独一个事件、而不是塞进 `results`：判定要等模型几秒，而结果列表
       * 早就该显示了。界面先出列表、徽章随后补上，比让用户对着空列表等
       * 更接近这套系统一贯的做法（能先给的先给）。
       *
       * **不删除。** 收到这个事件的界面不该拿它去过滤掉任何东西 ——
       * 排序仍然由 `rankResults` 决定，关联度只做同印证数下的 tie-breaker。
       */
      verdicts: Record<string, Relevance>;
      /**
       * 搜索阶段的价值预判，`SearchResult.id → ValueAssessment`。
       *
       * 与 `verdicts` 同一个事件、同一批送判：两者都是收口后的 LLM 批处理，
       * 并发跑完一起回来。没有 LLM 或预判失败时这个字段缺失/为空，
       * 界面按「未预判」处理，不显示徽章。
       */
      values?: Record<string, ValueAssessment>;
    }
  | { type: "provider"; log: ProviderLogEntry }
  | {
      type: "done";
      total: number;
      sessionId: string;
      /**
       * 时效筛选的**副作用**：被剔除的条数，以及因为没写日期而无法判断、
       * 于是被保留的条数。界面必须把它显示出来 —— 否则用户勾了「一周内」
       * 却看到一批日期未知的资料，只会以为筛选坏了。
       */
      timeFilter: { dropped: number; unknown: number };
      /** 行业过滤的统计：有多少条未命中所选行业。 */
      industryFilter?: { unmatched: number };
    }
  | { type: "error"; message: string };

/**
 * /api/fetch 的流式事件。
 *
 * 逐篇回传而不是攒完再发：抓取是最慢的一步（几十篇、每篇数秒），
 * 而且用户往往只想看前几篇的质量决定要不要继续等。
 */
export type FetchEvent =
  | {
      type: "plan";
      total: number;
      skipped: number;
      /**
       * 其中有多少条是**因为疑似不相关而跳过**的。
       *
       * 与 `skipped` 分开报，是因为两者的处置完全不同：`skipped` 是用户
       * 自己选的范围（勾了部分站点/结果），不必解释；这一条是程序替他做的
       * 决定，**必须说出来**，否则用户只会觉得「抓取少了几条，是不是坏了」。
       */
      skippedIrrelevant: number;
      /** 因搜索阶段价值预判为 low 而被跳过抓取成本的条数。 */
      skippedLowValue?: number;
      /** 因明显的无用/低质候选规则被过滤的条数。 */
      skippedLowQuality?: number;
    }
  | { type: "doc"; doc: Document; done: number; total: number }
  | {
      type: "done";
      sessionId: string;
      documents: number;
      /** 各降级档位的命中数，直接暴露「有多少篇其实只拿到了摘要」。 */
      byMethod: Record<ExtractMethod, number>;
      /** 本轮质量闸门过滤掉的候选数，便于界面明确告知。 */
      filteredLowQuality?: number;
      /** 整理阶段被判为低价值（只标记不删除）的篇数。 */
      lowValue?: number;
    }
  | { type: "error"; message: string };
