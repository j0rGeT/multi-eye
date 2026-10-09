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
  | "juejin"
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
   * 抓取失败的原因。注意：失败仍会产出 Document（正文退化为 snippet），
   * 而不是抛异常 —— 单篇失败不该中断整个主题的流程。
   */
  error?: string;
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
}

/**
 * 这次搜索用的时效选项。落盘是为了让界面刷新后能如实复原当时的口径 ——
 * 报告里写了「一周内」，那么它会话文件里就得有这一条，否则事后无从解释
 * 为什么同一主题两次搜出来的资料差那么多。
 */
export interface SearchOptions {
  timeRange?: TimeRange;
  sortMode?: SortMode;
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
  | { type: "plan"; topic: Topic; queries: string[] }
  | { type: "results"; site: SiteKey; results: SearchResult[] }
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
    }
  | { type: "error"; message: string };

/**
 * /api/fetch 的流式事件。
 *
 * 逐篇回传而不是攒完再发：抓取是最慢的一步（几十篇、每篇数秒），
 * 而且用户往往只想看前几篇的质量决定要不要继续等。
 */
export type FetchEvent =
  | { type: "plan"; total: number; skipped: number }
  | { type: "doc"; doc: Document; done: number; total: number }
  | {
      type: "done";
      sessionId: string;
      documents: number;
      /** 各降级档位的命中数，直接暴露「有多少篇其实只拿到了摘要」。 */
      byMethod: Record<ExtractMethod, number>;
    }
  | { type: "error"; message: string };
