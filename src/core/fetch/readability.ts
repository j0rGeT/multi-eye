/**
 * 正文提取主路径：jsdom + Mozilla Readability。
 *
 * 这是覆盖最广的一级 —— 博客、新闻、知乎专栏、大部分文档站都能正确处理。
 * 只有 JS 空壳站点才需要往下降级到无头浏览器。
 */

import { JSDOM, VirtualConsole } from "jsdom";
import { Readability } from "@mozilla/readability";
import * as cheerio from "cheerio";
import TurndownService from "turndown";
import type { DocImage } from "@/core/types";
import { normalizeToIso } from "@/core/dates";

export interface Extraction {
  title: string;
  text: string;
  markdown: string;
  images: DocImage[];
  excerpt: string;
  byline?: string;
  publishedAt?: string;
  lang: "zh" | "en" | "unknown";
  /** Readability 判定失败或正文过短时为 true，调用方据此决定是否降级。 */
  thin: boolean;
}

/** 正文短于这个长度就认为 Readability 没抽到东西（SPA 空壳的典型症状）。 */
const THIN_THRESHOLD = 200;

/** 静音 jsdom 的 CSS 解析警告 —— 抓来的页面里无效样式极多，日志会被刷屏。 */
const silentConsole = new VirtualConsole();

/**
 * 提取前必须移除的标签。
 *
 * 这是踩过的坑，且后果很严重：Readability 自己会剥 script，但它失手后我们
 * 会有一步「退回去取 body.textContent」的兜底，而 textContent **包含
 * script/style 内部的文本**。B 站、YouTube 这类 SPA 的静态 HTML 里几乎没有
 * 正文、却塞满了内联脚本，于是兜底拿到的就是整页 JS 和 CSS ——
 * `window.__INITIAL_STATE__`、`playerInfo`、`.css-xmtg1m{max-width:640px}`。
 *
 * 这些内容一旦进了语料，TF-IDF 会把 `window`、`var`、`function` 顶到权重榜
 * 前列（它们在二十多篇文档里都出现），整张知识图会退化成 JS 关键词图。
 * 所以必须在任何提取动作之前物理移除，而不是提取之后再过滤。
 */
const NON_CONTENT_SELECTORS = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "iframe",
  "object",
  "embed",
];

function stripNonContent(doc: Document): void {
  for (const sel of NON_CONTENT_SELECTORS) {
    doc.querySelectorAll(sel).forEach((el) => el.remove());
  }
}

/**
 * 判定一段文本是不是「代码/CSS 而非自然语言」。
 *
 * 剥离标签是第一道防线，这里是第二道：有些站点把 JSON 放在普通 div 里，
 * 或者把样式写在元素的行内属性上，剥离标签挡不住。宁可判错成代码而丢掉
 * 一篇，也不要让 `{}`、`;`、`=>` 混进语义图。
 */
export function looksLikeCode(text: string): boolean {
  const sample = text.slice(0, 3000);
  if (sample.length < 40) return false;

  /**
   * 豁免：以自然语言为主的文本一律放过。
   *
   * 这条是必需的，不是宽容 —— 搜「React hooks」这类编程主题时，正常文章的
   * 正文里本来就夹着代码块，纯按符号密度判定会把它们全部误杀。判别标准是
   * 整体构成：字母/汉字/空白占比高说明这是篇文章，代码只是其中一部分；
   * 而抽错页面时拿到的是**整页**脚本，字母占比反而很低（满是 {};=<>"）。
   */
  const letters = (sample.match(/[\p{L}\p{N}\s]/gu) ?? []).length;
  if (letters / sample.length > 0.75) return false;

  const codeMarks = (sample.match(/[{};=<>]|=>|::/g) ?? []).length;
  if (codeMarks / sample.length > 0.05) return true;

  // 强特征：出现这些片段基本可以断定是脚本或内联数据
  return /function\s*\(|window\.\w+\s*=|document\.(getElementById|querySelector)|\bvar\s+\w+\s*=|__INITIAL_STATE__|ytInitialPlayerResponse/.test(
    sample,
  );
}

export function extractWithReadability(
  html: string,
  url: string,
): Extraction {
  const dom = new JSDOM(html, {
    url,
    virtualConsole: silentConsole,
  });

  const doc = dom.window.document;

  /*
    日期必须在 stripNonContent **之前**读。

    结构化数据（JSON-LD）就住在 `<script type="application/ld+json">` 里，
    而下一步会把所有 script 物理删掉 —— 顺序反了就永远读不到它，且不会有
    任何报错，只是日期一直显示「未知」。
  */
  const metaDate = extractMetaDate(doc);

  // 必须在任何提取之前剥离：下面的 Readability 和 body.textContent 兜底
  // 都会读到这些标签里的代码/CSS
  stripNonContent(doc);

  // 先抓图片清单：Readability 会把内容重组成新 DOM，原文档的 img 就找不回来了
  const images = collectImages(doc, url);
  const lang = detectLang(doc);

  let title = doc.title?.trim() ?? "";
  let text = "";
  let markdown = "";
  let byline: string | undefined;
  let publishedAt: string | undefined;

  try {
    const article = new Readability(doc.cloneNode(true) as Document, {
      charThreshold: 100,
    }).parse();

    if (article) {
      title = article.title?.trim() || title;
      text = cleanText(article.textContent ?? "");
      byline = article.byline ?? undefined;
      publishedAt = article.publishedTime ?? undefined;

      if (article.content) {
        markdown = htmlToMarkdown(article.content, url);
      }
    }
  } catch {
    // Readability 在畸形 DOM 上偶尔会抛。这不是致命错误 —— 回退到 body 文本，
    // 让降级链的下一步去处理。
  }

  // Readability 失手时退一步：直接取 body 的可见文本，至少还有东西可用
  if (text.length < THIN_THRESHOLD) {
    const fallback = cleanText(doc.body?.textContent ?? "");
    if (fallback.length > text.length) text = fallback;
  }

  if (!markdown && text) {
    markdown = text;
  }

  /*
    我们自己那套元信息链优先于 Readability 的 `article.publishedTime`。

    不是因为它更准，而是因为它**更全**：Readability 只认少数几个 meta，
    而中文站点的日期大量藏在 `<time datetime>`、JSON-LD 和 `pubdate` 这类
    属性里。两边的第一选择其实是同一个（`article:published_time`），
    所以只有在 Readability 一无所获时才会看出差别。
  */
  const publishedIso = metaDate ?? (publishedAt ? normalizeToIso(publishedAt) : undefined);

  return {
    title,
    text,
    markdown,
    images,
    excerpt: text.slice(0, 200),
    byline,
    publishedAt: publishedIso,
    lang,
    thin: text.length < THIN_THRESHOLD,
  };
}

/**
 * 判定页面是否为「JS 空壳」—— 内容由前端渲染，静态 HTML 里什么都没有。
 * 命中则调用方应降级到无头浏览器。
 */
export function looksLikeSpa(html: string, extraction: Extraction): boolean {
  if (!extraction.thin) return false;

  const lower = html.toLowerCase();
  const shellMarkers = [
    'id="app"',
    'id="root"',
    "__next_data__",
    "window.__nuxt__",
    'id="__nuxt"',
    "data-reactroot",
  ];
  if (shellMarkers.some((m) => lower.includes(m))) return true;

  // script 占比过高也说明正文是运行时生成的
  const scriptChars = [...html.matchAll(/<script[\s\S]*?<\/script>/gi)].reduce(
    (n, m) => n + m[0].length,
    0,
  );
  return html.length > 0 && scriptChars / html.length > 0.5;
}

// ─────────────────────────── 发布日期 ───────────────────────────

/**
 * 日期元信息的查找顺序。
 *
 * 靠前的是结构化程度最高、最不容易出错的。`name="date"` 排在最后是有意的 ——
 * 它太泛，有些站点拿它放「本页更新于」甚至别的语义，能不用就不用。
 */
const DATE_META_SELECTORS = [
  'meta[property="article:published_time"]',
  'meta[property="og:published_time"]',
  'meta[itemprop="datePublished"]',
  'meta[name="article:published_time"]',
  'meta[name="parsely-pub-date"]',
  'meta[name="sailthru.date"]',
  'meta[name="publish-date"]',
  'meta[name="publishdate"]',
  'meta[name="pubdate"]',
  'meta[name="date"]',
  'meta[name="DC.date.issued"]',
  'meta[name="dc.date"]',
];

/** JSON-LD 里表示「这篇文章什么时候发的」的键，按可信度排序。 */
const JSONLD_DATE_KEYS = ["datePublished", "dateCreated", "uploadDate", "dateModified"];

/** `<time>` 元素最多扫这么多个 —— 有些页面把时间轴上的每个刻度都做成 `<time>`。 */
const MAX_TIME_ELEMENTS = 50;

/**
 * 从页面里挖出发布日期。
 *
 * 这是一处**投入产出比极高**的改动：搜索层给的日期覆盖率实测是 0%（纯
 * SearXNG 会话几十条结果一条日期都没有），而页面自己其实常常是知道的 ——
 * 只是藏在 meta、JSON-LD 或 `<time>` 里，此前没人去读。抓取这一步顺手
 * 把它带出来，几乎是白捡的。
 *
 * 返回归一化后的 ISO 串；所有候选都解析不出来时返回 `undefined`（表示
 * 「这页确实没写日期」，而不是「我们没找到」—— 两者在展示上是一回事，
 * 但对调用方而言只有一个诚实答案）。
 */
export function extractMetaDate(doc: Document): string | undefined {
  for (const raw of dateCandidates(doc)) {
    const iso = normalizeToIso(raw);
    if (iso) return iso;
  }
  return undefined;
}

/**
 * 按优先级收集所有候选日期串。
 *
 * 收集而不是「找到第一个就返回」：某个站点把 meta 写成 `"未知"` 是常事，
 * 那种值解析不出来，但下一顺位的 JSON-LD 往往是好的。逐条试、取第一条
 * **能解析成功**的，比取第一条**存在**的稳得多。
 */
function dateCandidates(doc: Document): string[] {
  const out: string[] = [];

  for (const sel of DATE_META_SELECTORS) {
    const v = doc.querySelector(sel)?.getAttribute("content")?.trim();
    if (v) out.push(v);
  }

  out.push(...jsonLdDates(doc));

  const times = doc.querySelectorAll("time[datetime]");
  for (let i = 0; i < times.length && i < MAX_TIME_ELEMENTS; i += 1) {
    const v = times[i].getAttribute("datetime")?.trim();
    if (v) out.push(v);
  }

  return out;
}

/**
 * 从 JSON-LD 里取日期。
 *
 * 线上页面的 JSON-LD 有三个现实情况必须容错：可能语法就是错的（手写、
 * 拼接产生），可能是数组，也可能把文章包在 `@graph` 里而日期在下一层。
 * 所以坏块跳过而不是整体失败，并且递归找。
 */
function jsonLdDates(doc: Document): string[] {
  const out: string[] = [];
  for (const block of doc.querySelectorAll('script[type="application/ld+json"]')) {
    let data: unknown;
    try {
      data = JSON.parse(block.textContent ?? "");
    } catch {
      continue;
    }
    collectJsonLdDates(data, out, 0);
  }
  return out;
}

function collectJsonLdDates(node: unknown, out: string[], depth: number): void {
  if (depth > 6 || node === null || typeof node !== "object") return;

  if (Array.isArray(node)) {
    for (const item of node) collectJsonLdDates(item, out, depth + 1);
    return;
  }

  const obj = node as Record<string, unknown>;
  for (const key of JSONLD_DATE_KEYS) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) out.push(v.trim());
  }
  for (const v of Object.values(obj)) {
    if (v !== null && typeof v === "object") collectJsonLdDates(v, out, depth + 1);
  }
}

// ─────────────────────────── 内部工具 ───────────────────────────

/** 把相对 URL 解析成绝对 URL，并过滤掉明显无意义的图（图标、埋点像素）。 */
function collectImages(doc: Document, baseUrl: string): DocImage[] {
  const out: DocImage[] = [];
  const seen = new Set<string>();

  for (const img of doc.querySelectorAll("img")) {
    const raw =
      img.getAttribute("src") ||
      img.getAttribute("data-src") ||
      img.getAttribute("data-original");
    if (!raw) continue;

    let abs: string;
    try {
      abs = new URL(raw, baseUrl).toString();
    } catch {
      continue;
    }
    if (seen.has(abs)) continue;
    if (/^data:/i.test(abs)) continue;

    const w = Number(img.getAttribute("width") ?? 0);
    const h = Number(img.getAttribute("height") ?? 0);
    // 1x1 像素是埋点，小图通常是图标 —— 都排除
    if ((w && w < 80) || (h && h < 80)) continue;

    seen.add(abs);
    out.push({
      url: abs,
      alt: img.getAttribute("alt")?.trim() || undefined,
      width: w || undefined,
      height: h || undefined,
    });

    if (out.length >= 30) break;
  }

  return out;
}

/** 从 html lang 属性与正文字符构成推断语言。 */
function detectLang(doc: Document): "zh" | "en" | "unknown" {
  const attr = doc.documentElement.getAttribute("lang")?.toLowerCase() ?? "";
  if (attr.startsWith("zh")) return "zh";
  if (attr.startsWith("en")) return "en";

  const sample = (doc.body?.textContent ?? "").slice(0, 1000);
  if (!sample) return "unknown";
  const cjk = (sample.match(/[一-鿿]/g) ?? []).length;
  if (cjk / sample.length > 0.15) return "zh";
  return "en";
}

/** 折叠空白、去掉常见的噪声行。 */
function cleanText(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => {
      if (!l) return true; // 保留空行以维持段落结构
      // 纯导航/分享噪声
      if (/^(分享|收藏|点赞|评论|关注|举报|展开|收起|阅读全文)$/.test(l)) return false;
      return true;
    })
    .join("\n")
    .trim();
}

function htmlToMarkdown(html: string, baseUrl: string): string {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });

  // 去掉对结构化资料无价值的元素
  td.remove(["script", "style", "noscript", "iframe", "form", "nav", "footer"]);

  // 相对链接转绝对，否则导出的 Markdown 里全是打不开的链接
  td.addRule("absoluteLinks", {
    filter: "a",
    replacement: (content, node) => {
      const href = (node as HTMLAnchorElement).getAttribute?.("href");
      if (!href || !content.trim()) return content;
      let abs = href;
      try {
        abs = new URL(href, baseUrl).toString();
      } catch {
        return content;
      }
      return `[${content.trim()}](${abs})`;
    },
  });

  try {
    return td.turndown(html).trim();
  } catch {
    return "";
  }
}

export { THIN_THRESHOLD };
