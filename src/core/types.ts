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
  | "xiaohongshu"
  | "youtube"
  | "x"
  | "bilibili"
  | "web";

/** 实际发出请求的搜索后端。 */
export type ProviderId = "serper" | "searxng" | "ytdlp" | "bilibili";

// ─────────────────────────── 搜索层 ───────────────────────────

export interface SearchQuery {
  text: string;
  site?: SiteKey;
  /** 任意域名定向（如 blog.csdn.net）。与 site 二选一，优先于 site。 */
  domain?: string;
  limit?: number;
  language?: string;
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
  /** 多个 provider 都返回了这条结果，值越高越可信。 */
  hitCount: number;
  publishedAt?: string;
  author?: string;
  thumbnail?: string;
  durationSec?: number;
}

export interface ProviderCapabilities {
  /** 是否支持 site:/domain 定向语法。yt-dlp 不支持（它只能搜 YouTube）。 */
  supportsSiteSyntax: boolean;
  supportsVideo: boolean;
  needsApiKey: boolean;
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

/** 一次搜索会话的完整快照，落盘为 data/sessions/<id>/session.json。 */
export interface Session {
  topic: Topic;
  results: SearchResult[];
  documents: Document[];
  graph?: GraphModel;
  /** 每个 provider 在本次会话中的表现，用于排查「为什么某站点没结果」。 */
  providerLog: ProviderLogEntry[];
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
  | { type: "snapshot"; job: DownloadJob; at: string }
  | { type: "task"; task: DownloadTask; at: string }
  | { type: "job"; job: DownloadJob; at: string }
  | { type: "error"; message: string; at: string };

// ─────────────────────────── 搜索的流式事件 ───────────────────────────

/** /api/search 通过 SSE 逐步回传，让用户不用干等全部站点返回。 */
export type SearchEvent =
  | { type: "plan"; topic: Topic; queries: string[] }
  | { type: "results"; site: SiteKey; results: SearchResult[] }
  | { type: "provider"; log: ProviderLogEntry }
  | { type: "done"; total: number; sessionId: string }
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
