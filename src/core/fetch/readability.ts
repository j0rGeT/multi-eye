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

export function extractWithReadability(
  html: string,
  url: string,
): Extraction {
  const dom = new JSDOM(html, {
    url,
    virtualConsole: silentConsole,
  });

  const doc = dom.window.document;

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

  const publishedIso = publishedAt ? safeIso(publishedAt) : undefined;

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

function safeIso(raw: string): string | undefined {
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export { THIN_THRESHOLD };
