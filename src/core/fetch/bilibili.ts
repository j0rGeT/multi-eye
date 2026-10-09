/**
 * B 站视频抓取：走公开接口，不抓页面。
 *
 * 为什么不沿用 HTTP + Readability —— 实测过，它抓到的东西是这样的：
 *
 *   首页 番剧 直播 游戏中心 会员购 漫画 赛事 投稿 <标题> 点赞 投币 收藏 分享
 *   课程总结 收起全部章节 关闭课程总结 暂无课程总结 10026414876419----<标题>
 *   接下来播放 自动连播 这雨是越下越大… 别利切夫在极地 11.1万 236
 *   用这个帐篷过夜露营，可得小心了 赵老师没灵魂 89.9万 175 …
 *
 * 也就是**站内导航 + 侧栏的「接下来播放」推荐列表**，一千多字里没有一个字是
 * 这个视频的内容。它比抓不到还糟：每篇 B 站资料都是这同一段导航文案，几十篇
 * 叠在一起，TF-IDF 里「首页/番剧/会员购/点赞」这类词的权重会高到离谱。
 *
 * 接口给的是视频自己的东西 —— 标题、UP主、分区、时长、播放/点赞、标签、简介，
 * 有 CC 字幕时还能拿到字幕全文。这些至少都是真的。
 *
 * ── 两个必须记住的坑 ──
 *
 *  1. **不能走代理。** api.bilibili.com 对境外 IP 直接回 412（风控页），
 *     而它本来在国内直连就通。所以这里用 directFetch 而不是 httpFetch。
 *     踩过：加 --proxy 之后返回的是一张 HTML 错误页，JSON.parse 直接炸。
 *  2. **要带 Referer 和浏览器 UA。** 不带的话同样会被风控挡掉，
 *     而且挡的时候返回的是 HTML 而不是 JSON —— 报错会很难懂。
 *
 * 不需要登录、不需要签名。B 站的 wbi 签名是给「播放地址」这类接口用的，
 * 视频元数据这个接口不需要，所以这里没有碰任何签名算法。
 */

import type { DocImage } from "@/core/types";
import { FULL_BODY_CHARS } from "@/core/quality";
import { directFetch, withTimeout } from "./agent";
import { limiter, withRetry } from "@/core/limit";

const API = "https://api.bilibili.com";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * 用不用接口结果的下限：简介 + 章节 + 字幕合计不到 30 字，就退回搜索摘要。
 *
 * 这个数**只在这里用**，所以没有上提到 `quality.ts`：它回答的是抓取策略
 * 问题（「接口这趟值不值得采信」），不是质量分级问题。而 `FULL_BODY_CHARS`
 * 是跨模块共享的「正文完整」线，那个才必须只有一处定义。
 */
const MIN_BODY_CHARS = 30;

/** 接口请求并发。B 站风控对突发流量敏感，宁少勿多。 */
const gate = limiter("bilibili:api", 3);
const REQUEST_TIMEOUT_MS = 15_000;

export function isBilibiliVideoUrl(url: string): boolean {
  return bilibiliVideoId(url) !== null;
}

export type BilibiliId = { key: "bvid" | "aid"; value: string };

/**
 * **有正文**的 B 站路径。
 *
 *   - `/video/`  —— 视频，走接口
 *   - `/read/cv…` —— 专栏，是真的文章
 *   - `/opus/…`   —— 新版图文，实测正文完整（1278 字的散文，不是推荐位）
 *
 * 这个名单是**实测验出来的**，不是照着目录树抄的。判定方式很直接：把这些
 * 路径的页面喂给 Readability，看抽出来的到底是不是正文。
 */
const CONTENT_PATH = /\/(video|read|opus)\//;

/** `/video/BV1kAH16WERt/`、`/av116883609164003` 这类路径里的 id。 */
const BV_IN_PATH = /\/(BV[0-9A-Za-z]{10})/;
const AV_IN_PATH = /\/av(\d+)/i;

/**
 * 从各种 URL 形态里取视频标识。
 *
 * 三种来源，按可信度排序：
 *
 *  1. **路径里的 `/video/`** —— 站内链接会长成 `/video/BV1kAH16WERt/`、
 *     带语言前缀的 `/tr/video/BV…`，以及老式的 `/video/av116883609164003`
 *     （这些在搜索结果里都真的出现过）
 *  2. **query 里的 `bvid` / `oid`** —— 合集页 `/list/…?bvid=BV…&oid=…`
 *     指向的是**这个页面当下在放的那个视频**。实测 14 条 `/list/` 里 9 条
 *     带着 bvid；顺着它去拿那个视频的真实内容，比把整页当垃圾丢掉强得多
 *  3. 其余 → 没有 id，交给 `isBilibiliNonContentUrl` 处置
 *
 * 专栏 `/read/cv…` 与图文 `/opus/…` 在有正文的路径名单里，**不参与** query
 * 兜底 —— 它们自己就是文章，不该被 query 里某个 id 抢去走视频接口。
 */
export function bilibiliVideoId(url: string): BilibiliId | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/(^|\.)bilibili\.com$/.test(u.hostname)) return null;

  const path = u.pathname;

  if (path.includes("/video/")) {
    const bv = path.match(BV_IN_PATH);
    if (bv) return { key: "bvid", value: bv[1] };
    const av = path.match(AV_IN_PATH);
    if (av) return { key: "aid", value: av[1] };
    return null;
  }

  // 专栏与图文是有正文的页面，不走视频接口
  if (CONTENT_PATH.test(path)) return null;

  const bvid = u.searchParams.get("bvid");
  if (bvid && /^BV[0-9A-Za-z]{10}$/.test(bvid)) return { key: "bvid", value: bvid };

  const oid = u.searchParams.get("oid");
  if (oid && /^\d+$/.test(oid)) return { key: "aid", value: oid };

  return null;
}

/**
 * 这个 URL 是不是**B 站上抓不到正文、又没有可救的视频 id**的页面。
 *
 * ── 为什么需要它 ──
 *
 * `bilibiliVideoId` 认不出来的 B 站页面会全部掉进三级「HTTP + Readability」。
 * 而在这些页面上，Readability 眼中的「主内容」是侧栏的「接下来播放」推荐
 * 列表 —— 一千多字里没有一句是这个页面的内容。它会带着 `error: undefined`
 * 混进语料，看起来和一篇正常资料一模一样（样本见 `boilerplate.ts` 头注释）。
 *
 * 调用点必须**先问 `bilibiliVideoId`**：能救回的（`/list/…?bvid=`）走接口，
 * 救不回的才落到这里。剩下的是真正没有正文可抓的页面 —— `/cheese/play/`
 * 这种付费课程落地页（实测只有一句课程简介 + 购买/目录骨架），以及
 * `space.` / `live.` 子域。
 *
 * 拦在**抓取之前**而不是靠内容检测兜底，有两个理由：
 *
 *  1. 这些路径本来就**没有正文可抓**，白跑一趟 HTTP 只是给 B 站添流量
 *  2. 内容检测（`boilerplateReason`）是通用兜底，它认的是「文本形状」；
 *     这里是结构性事实（这个页面类型根本不存在正文），能给出更准的错因
 *
 * 两层都留着：这一层省掉一次注定失败的请求，那一层挡住其它站点的同类污染。
 */
export function isBilibiliNonContentUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    // 解析不出来就交给后面的通用链路，不在这里替它下结论
    return false;
  }
  if (!/(^|\.)bilibili\.com$/.test(u.hostname)) return false;
  return !CONTENT_PATH.test(u.pathname);
}

export interface BilibiliResult {
  /**
   * 语料版正文：UP主、标签、简介、章节、字幕 —— **只有内容本身，没有字段名，
   * 也不重复标题**。
   *
   * 这个形状是被实测逼出来的。第一版把带字段名的整块元数据（`标题：… / UP主：…
   * / 数据：…`）同时当 text 和 markdown 用，结果启发式图上「标题」「数据」
   * 「发布」「标签」直接挤进 TF-IDF 前四名，把「帐篷」「天幕」压了下去 ——
   * 字段名在每篇资料里都出现一次，对统计来说就是最高频的词。
   *
   * 所以标签前缀只留在 markdown 里（那是给人看的排版）；标题也不放进来，
   * 因为 heuristic 与 LLM 两条路径本来就会各自带上 doc.title。
   */
  text: string;
  /** 给人看的版本：带字段名、时长与播放数，用于报告和下载落盘。 */
  markdown: string;
  title: string;
  author?: string;
  publishedAt?: string;
  /** 视频封面。当成一张图收进来：它是这个视频唯一的可视产物。 */
  images: DocImage[];
  /**
   * 拿到的是不是**这个视频的内容**。
   *
   * 只有标题和几个标签时为 false（简介 + 章节 + 字幕合计不足 30 字）——
   * 那种文档放进语料就是另一种形式的噪声。调用方据此退回搜索摘要，
   * 而不是把「一个 UP 主名字」当成一篇资料的正文。
   */
  substantive: boolean;
  error?: string;
}

// ─────────────────────────── 接口返回的形状 ───────────────────────────

interface ViewData {
  bvid: string;
  aid: number;
  title: string;
  desc: string;
  pic?: string;
  pubdate?: number;
  duration?: number;
  tname?: string;
  owner?: { name?: string };
  stat?: { view?: number; like?: number; favorite?: number; danmaku?: number; reply?: number };
  pages?: { cid: number; part?: string }[];
}

interface TagData {
  tag_name?: string;
}

interface PlayerData {
  subtitle?: {
    subtitles?: { lan?: string; lan_doc?: string; subtitle_url?: string }[];
  };
  view_points?: { from?: number; to?: number; content?: string }[];
}

interface SubtitleBody {
  body?: { from?: number; to?: number; content?: string }[];
}

export interface BilibiliOptions {
  signal?: AbortSignal;
}

export async function fetchBilibiliVideo(
  url: string,
  opts: BilibiliOptions = {},
): Promise<BilibiliResult> {
  const id = bilibiliVideoId(url);
  if (!id) return empty("无法从 URL 解析出视频 ID");

  const referer = `https://www.bilibili.com/video/${id.value}`;
  const query = `${id.key}=${encodeURIComponent(id.value)}`;

  let view: ViewData;
  try {
    view = await apiGet<ViewData>(`/x/web-interface/view?${query}`, referer, opts.signal);
  } catch (err) {
    // 接口都不通时不做任何猜测：宁可用搜索摘要，也不要把页面上的推荐列表
    // 当成正文。这条降级看起来「更差」，但它是诚实的。
    return empty(errText(err));
  }

  const cid = view.pages?.[0]?.cid;

  // 标签和字幕都是锦上添花，各自失败不影响主体
  const [tags, player] = await Promise.all([
    apiGet<TagData[]>(`/x/tag/archive/tags?${query}`, referer, opts.signal).catch(() => []),
    cid
      ? apiGet<PlayerData>(`/x/player/v2?${query}&cid=${cid}`, referer, opts.signal).catch(
          () => null,
        )
      : Promise.resolve(null),
  ]);

  const sub = player?.subtitle?.subtitles?.find((s) => s.subtitle_url);
  const transcript = sub?.subtitle_url
    ? await fetchSubtitle(sub.subtitle_url, referer, opts.signal).catch(() => "")
    : "";

  const desc = cleanDesc(view.desc, view.title);
  const title = view.title?.trim() || "";

  const meta: Meta = {
    title,
    author: view.owner?.name,
    tname: view.tname,
    duration: view.duration,
    pubdate: view.pubdate,
    stat: view.stat,
    part: view.pages?.length === 1 ? undefined : view.pages?.map((p) => p.part).join(" / "),
    tags: tags.map((t) => t.tag_name?.trim() ?? "").filter(Boolean),
    desc,
    chapters: (player?.view_points ?? [])
      .filter((p) => p.content)
      .map((p) => `${formatClock(p.from ?? 0)} ${p.content}`),
    transcript,
  };

  /**
   * 判断的尺度和 composeText 保持一致：量的是**内容字段**的字数，不是
   * 「有没有字段」。标题和标签任何视频都有，拿它们当「拿到内容了」的证据，
   * 就等于把一个空壳当成一篇资料收进语料。
   *
   * 简介、章节、字幕三类里任何一类够长就算数 —— 有章节没有简介的课程视频
   * 同样是完整的资料。
   */
  const body = [desc, meta.chapters.join("\n"), transcript].filter(Boolean).join("\n").trim();

  /**
   * ── 两段式判定（P11）──
   *
   * 原先只有一道 `body >= 30`。实测下来这道闸太松：接口返回的文档里，
   * **没有错误但也不到 300 字**的那一批有 41 篇，正文全是「UP主 + 标签 +
   * 一句简介」，中位数一百多字 —— 它们却因为 `error` 为空，看起来和一篇
   * 完整资料一模一样，`bodyGrade` 判 `thin` 甚至够进图。
   *
   * 但**不能直接把门槛抬到 300**：那样这些视频会退回搜索摘要，而摘要的信息
   * 比接口给的还少 —— 那是用更差的数据换一个更干净的数字，不划算。
   *
   * 所以拆成两问：
   *
   *   1. `substantive`（`>= MIN_BODY_CHARS`）—— **要不要用接口结果**。
   *      没到就退回摘要，行为不变。
   *   2. `error` —— **这段正文算不算数**。够 30 字就产出文档、把抓到的
   *      简介和标签如实留着；但不到 `FULL_BODY_CHARS`（= `quality.ts` 的
   *      「正文完整」线）时写明「没有字幕，只有简介」。
   *
   * 这样既不丢数据（文本原样保留，用户还能看到），又让下游三处 —— 拓扑图、
   * 下载包、界面分级 —— 自动得到正确判断，**不需要新增任何字段**。
   */
  const substantive = body.length >= MIN_BODY_CHARS;

  let error: string | undefined;
  if (!substantive) {
    error = "该视频没有可用的字幕与简介，仅有标题与标签";
  } else if (body.length < FULL_BODY_CHARS) {
    error = `该视频没有可用字幕，正文仅有简介与标签（${body.length} 字）`;
  }

  return {
    text: composeText(meta),
    markdown: composeMarkdown(meta),
    title,
    author: view.owner?.name,
    publishedAt: view.pubdate ? new Date(view.pubdate * 1000).toISOString() : undefined,
    images: view.pic ? [{ url: normalizeUrl(view.pic), alt: title }] : [],
    substantive,
    error,
  };
}

// ─────────────────────────── 正文组装 ───────────────────────────

/** 两个渲染器共用的中间结构，避免在调用处把十几个字段列两遍。 */
interface Meta {
  title: string;
  author?: string;
  tname?: string;
  duration?: number;
  pubdate?: number;
  stat?: ViewData["stat"];
  part?: string;
  tags: string[];
  desc: string;
  chapters: string[];
  transcript: string;
}

/**
 * 语料版：**只有内容本身**。
 *
 * 不带字段名，因为字段名在每篇资料里都恰好出现一次 —— 对 TF-IDF 来说那就是
 * 全语料最高频的词。实测把带前缀的整块喂进去之后，「标题」「数据」「发布」
 * 「标签」直接占据前四名，把真正有信息量的「帐篷」「天幕」压下去。
 *
 * 也不带标题：两条构图路径都会各自拼上 `doc.title`（见 heuristic.ts 的
 * `` `${doc.title}。${doc.text}` ``），这里再来一份就是重复计数。
 */
function composeText(x: Meta): string {
  const parts: string[] = [];

  // UP主留着：它是实体（「赵老师没灵魂」），不是字段名，而且能连起同一作者的多篇
  if (x.author?.trim()) parts.push(x.author.trim());
  if (x.tags.length > 0) parts.push(x.tags.join("、"));
  if (x.desc) parts.push(x.desc);
  if (x.chapters.length > 0) parts.push(x.chapters.join("\n"));
  if (x.transcript) parts.push(x.transcript);

  return parts.join("\n").trim();
}

/**
 * 给人看的版本：带字段名、时长与播放数。
 *
 * 报告里、落盘的 .md 里用它 —— 那里读的是人，字段名是帮忙的而不是噪声。
 */
function composeMarkdown(x: Meta): string {
  const lines: string[] = [];
  const kv = (k: string, v?: string) => {
    if (v && v.trim()) lines.push(`${k}：${v.trim()}`);
  };

  kv("标题", x.title);
  kv("UP主", x.author);
  kv("分区", x.tname);
  kv("时长", x.duration ? formatClock(x.duration) : undefined);
  kv("分P", x.part);
  kv(
    "发布",
    x.pubdate ? new Date(x.pubdate * 1000).toISOString().slice(0, 10) : undefined,
  );
  kv("数据", statLine(x.stat));
  kv("标签", x.tags.join("、"));
  kv("简介", x.desc);

  if (x.chapters.length > 0) lines.push("", "章节：", ...x.chapters);
  if (x.transcript) lines.push("", "字幕：", x.transcript);

  return lines.join("\n").trim();
}

function statLine(s?: ViewData["stat"]): string | undefined {
  if (!s) return undefined;
  const parts: string[] = [];
  const add = (k: string, v?: number) => {
    if (typeof v === "number" && v > 0) parts.push(`${k} ${fmt(v)}`);
  };
  add("播放", s.view);
  add("点赞", s.like);
  add("收藏", s.favorite);
  add("弹幕", s.danmaku);
  add("评论", s.reply);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * 清洗简介。
 *
 * 实测两种脏数据：一是以视频 aid 打头再跟一串横线（`10026414876419----标题`），
 * 二是接口直接把标题当简介返回。两种都不含新信息，去掉比留着好 ——
 * 否则同一个标题会在正文里出现两次，TF-IDF 会把它当成两个来源在互相印证。
 */
function cleanDesc(desc: string | undefined, title: string): string {
  let d = (desc ?? "").trim();
  if (!d) return "";
  d = d.replace(/^\d{6,}\s*[-–—]+\s*/, "").trim();
  if (d.startsWith(title.trim())) d = d.slice(title.trim().length).trim();
  if (d.length < 10) return "";
  return d;
}

// ─────────────────────────── 接口调用 ───────────────────────────

async function apiGet<T>(
  path: string,
  referer: string,
  signal?: AbortSignal,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<T> {
  return gate(() =>
    withRetry(async () => {
      const { signal: s, release } = withTimeout(signal, timeoutMs, "B站接口");
      try {
        const res = await directFetch(`${API}${path}`, {
          headers: {
            "User-Agent": UA,
            Referer: referer,
            Accept: "application/json",
          },
          signal: s,
        });

        const body = await res.text();

        // 被风控挡下来时返回的是 HTML 而不是 JSON，直接 JSON.parse 会抛出
        // 「Unexpected token <」这种看不出所以然的话
        if (!res.ok) {
          if (res.status === 412) {
            throw new Error("B站接口风控（HTTP 412）：该请求被判定为异常流量");
          }
          throw new Error(`B站接口 HTTP ${res.status}`);
        }

        let parsed: { code?: number; message?: string; data?: T };
        try {
          parsed = JSON.parse(body) as typeof parsed;
        } catch {
          throw new Error("B站接口返回的不是 JSON（疑似被风控拦截）");
        }

        if (parsed.code !== 0) {
          throw new Error(`B站接口 code=${parsed.code} ${parsed.message ?? ""}`.trim());
        }
        return parsed.data as T;
      } finally {
        release();
      }
    }),
  );
}

/**
 * 字幕文件是 JSON，不是 VTT。
 *
 * 形状是 { body: [{ from, to, content }] }，from/to 是秒。相邻条目常常是同一句
 * 的碎片，所以按标点判断是否需要补空格：中文直接连，英文之间留一个空格。
 */
async function fetchSubtitle(
  rawUrl: string,
  referer: string,
  signal?: AbortSignal,
): Promise<string> {
  const url = normalizeUrl(rawUrl);
  const { signal: s, release } = withTimeout(signal, REQUEST_TIMEOUT_MS, "B站字幕");
  try {
    const res = await directFetch(url, { headers: { "User-Agent": UA, Referer: referer }, signal: s });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as SubtitleBody;

    const cues = (data.body ?? [])
      .map((b) => (b.content ?? "").trim())
      .filter(Boolean);

    let out = "";
    for (const cue of cues) {
      if (!out) {
        out = cue;
        continue;
      }
      const last = out.slice(-1);
      // 上一句以中文/中文标点结尾就直接接，否则补空格，避免英文连成一片
      out += /[一-鿿，。！？、；：”』）]$/.test(last) ? cue : ` ${cue}`;
    }
    return out.replace(/\s+/g, " ").trim();
  } finally {
    release();
  }
}

// ─────────────────────────── 小工具 ───────────────────────────

/** 接口返回的图片/字幕地址是 //i0.hdslb.com/… 这种协议相对形式。 */
function normalizeUrl(u: string): string {
  if (u.startsWith("//")) return `https:${u}`;
  return u.replace(/^http:\/\//, "https://");
}

/** 秒 → mm:ss（超过一小时给 h:mm:ss）。 */
function formatClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** 播放量这类数字用「万」比原样堆 digits 好读。 */
function fmt(n: number): string {
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1)} 亿`;
  if (n >= 10_000) return `${(n / 10_000).toFixed(1)} 万`;
  return String(n);
}

function empty(error: string): BilibiliResult {
  return { text: "", markdown: "", title: "", images: [], substantive: false, error };
}


function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
