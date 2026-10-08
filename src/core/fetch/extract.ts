/**
 * 抓取降级链编排。
 *
 *   1. YouTube URL      → yt-dlp 字幕（视频的「正文」就是字幕）
 *   2. HTTP + Readability → 覆盖大部分博客/新闻/专栏
 *   3. JS 空壳判定命中   → 无头浏览器重试
 *   4. 全部失败          → 退化为搜索摘要（extractMethod: 'raw'）
 *
 * 核心原则：**单篇失败不抛异常，而是产出带 error 的 Document**。
 * 一个主题下有几十篇资料，其中几篇抓不到是常态（知乎不登录、站点下线、
 * 反爬拦截），不该让整批失败。
 */

import type { Document, ExtractMethod, SearchResult } from "@/core/types";
import { config } from "@/core/env";
import { fetchHtml } from "./http";
import { extractWithReadability, looksLikeCode, looksLikeSpa } from "./readability";
import { fetchWithBrowser, isPlaywrightAvailable } from "./playwright";
import { fetchTranscript, isYoutubeUrl } from "./youtube";
import { limiter } from "@/core/limit";

export interface ExtractOptions {
  signal?: AbortSignal;
  /** 并发上限。默认 4：再高容易触发目标站点的反爬。 */
  concurrency?: number;
  onProgress?: (done: number, total: number, doc: Document) => void;
}

export async function extractMany(
  results: SearchResult[],
  opts: ExtractOptions = {},
): Promise<Document[]> {
  const concurrency = opts.concurrency ?? 4;
  const gate = limiter("extract", concurrency);

  let done = 0;
  const tasks = results.map((r) =>
    gate(async () => {
      const doc = await extractOne(r, opts.signal);
      done += 1;
      opts.onProgress?.(done, results.length, doc);
      return doc;
    }),
  );

  // 用 allSettled 而不是 all：即使某个任务因为意外抛出，其他文档也要保住
  const settled = await Promise.allSettled(tasks);
  return settled.map((s, i) =>
    s.status === "fulfilled" ? s.value : fallbackDocument(results[i], String(s.reason)),
  );
}

export async function extractOne(
  result: SearchResult,
  signal?: AbortSignal,
): Promise<Document> {
  const t0 = Date.now();

  // ── 一级：YouTube 字幕 ──
  if (isYoutubeUrl(result.url)) {
    const tr = await fetchTranscript(result.url, { signal });
    if (tr.text) {
      return buildDoc(result, {
        method: "ytdlp-subtitle",
        text: tr.text,
        markdown: tr.text,
        title: result.title,
        startedAt: t0,
      });
    }

    /**
     * 字幕拿不到时**直接兜底，不进 HTTP + Readability**。
     *
     * 这是实测出来的坑：YouTube 观看页的 HTML 里没有正文，只有
     * `var ytInitialPlayerResponse = {...}` 这样的内联 JSON。Readability
     * 会把它当正文抓出来，产出 4~8 万个「字」的 JS 源码垃圾 —— 它既不是
     * 内容，又会以极高权重污染后续的 TF-IDF，比抓不到还糟。
     * 视频的唯一正文本就是字幕，没有字幕就没有正文，退回摘要才是诚实的。
     */
    return fallbackDocument(result, tr.error ?? "该视频没有可用字幕", t0);
  }

  // ── 二级：HTTP + Readability ──
  const res = await fetchHtml(result.url, { signal });

  if (res.ok && res.body) {
    const extraction = extractWithReadability(res.body, res.finalUrl);

    /**
     * 第二道防线：即使剥掉了 script/style，仍可能有站点的内联 JSON 以普通
     * 文本节点存在。这种「正文」一旦入库，TF-IDF 会把 window/var/function
     * 这类词顶成核心概念。宁可让它退化为摘要，也不能污染语义图。
     */
    if (looksLikeCode(extraction.text)) {
      return fallbackDocument(
        result,
        "正文疑似为脚本或内联数据，已丢弃",
        t0,
      );
    }

    if (!extraction.thin) {
      return buildDoc(result, {
        method: "readability",
        text: extraction.text,
        markdown: extraction.markdown,
        title: extraction.title || result.title,
        images: extraction.images,
        author: extraction.byline ?? result.author,
        publishedAt: extraction.publishedAt ?? result.publishedAt,
        lang: extraction.lang,
        truncated: res.truncated,
        startedAt: t0,
      });
    }

    // ── 三级：JS 空壳 → 无头浏览器 ──
    if (looksLikeSpa(res.body, extraction) && (await isPlaywrightAvailable())) {
      const br = await fetchWithBrowser(result.url, { signal });
      if (br.html) {
        // 站点专用选择器命中时直接用，比再跑一次 Readability 准。
        // 但仍要过一遍代码检测：选择器可能框到了一块内联 JSON。
        if (
          br.selectorText &&
          br.selectorText.length > 200 &&
          !looksLikeCode(br.selectorText)
        ) {
          return buildDoc(result, {
            method: "playwright",
            text: br.selectorText,
            markdown: br.selectorText,
            title: extraction.title || result.title,
            images: extraction.images,
            lang: extraction.lang,
            startedAt: t0,
          });
        }
        const re = extractWithReadability(br.html, result.url);
        if (!re.thin) {
          return buildDoc(result, {
            method: "playwright",
            text: re.text,
            markdown: re.markdown,
            title: re.title || result.title,
            images: re.images,
            author: re.byline ?? result.author,
            publishedAt: re.publishedAt ?? result.publishedAt,
            lang: re.lang,
            startedAt: t0,
          });
        }
      }
    }

    // Readability 拿到了一点东西但不完整 —— 仍比纯摘要强，标 raw 并说明原因
    if (extraction.text.length > 50) {
      return buildDoc(result, {
        method: "raw",
        text: extraction.text,
        markdown: extraction.markdown,
        title: extraction.title || result.title,
        images: extraction.images,
        lang: extraction.lang,
        startedAt: t0,
        error: "正文提取不完整（疑似动态渲染，需启用 Playwright）",
      });
    }
  }

  // ── 四级：兜底 ──
  return fallbackDocument(
    result,
    res.error ?? "未能提取到正文",
    t0,
  );
}

// ─────────────────────────── 构造工具 ───────────────────────────

interface DocParts {
  method: ExtractMethod;
  text: string;
  markdown: string;
  title: string;
  images?: Document["images"];
  author?: string;
  publishedAt?: string;
  lang?: Document["lang"];
  truncated?: boolean;
  error?: string;
  startedAt: number;
}

function buildDoc(r: SearchResult, p: DocParts): Document {
  const text = p.text.trim();
  return {
    id: r.id,
    url: r.url,
    title: p.title || r.title,
    site: r.site,
    kind: r.site === "youtube" || r.site === "bilibili" ? "video" : "article",
    text,
    markdown: p.markdown.trim() || text,
    excerpt: text.slice(0, 200),
    lang: p.lang ?? detectLangFromText(text),
    author: p.author ?? r.author,
    publishedAt: p.publishedAt ?? r.publishedAt,
    images: p.images ?? [],
    wordCount: countWords(text),
    extractMethod: p.method,
    extractMs: Date.now() - p.startedAt,
    fetchedAt: new Date().toISOString(),
    truncated: p.truncated,
    error: p.error,
  };
}

function fallbackDocument(
  r: SearchResult,
  error: string,
  startedAt = Date.now(),
): Document {
  return buildDoc(r, {
    method: "raw",
    text: r.snippet,
    markdown: r.snippet,
    title: r.title,
    startedAt,
    error,
  });
}

/** 中文按字数计，英文按词数计 —— 混排时取两者之和的近似。 */
function countWords(text: string): number {
  const cjk = (text.match(/[一-鿿]/g) ?? []).length;
  const latin = (text.match(/[a-zA-Z]+/g) ?? []).length;
  return cjk + latin;
}

function detectLangFromText(text: string): "zh" | "en" | "unknown" {
  const sample = text.slice(0, 1000);
  if (!sample) return "unknown";
  const cjk = (sample.match(/[一-鿿]/g) ?? []).length;
  return cjk / sample.length > 0.15 ? "zh" : "en";
}

export const fetchConfig = config;
