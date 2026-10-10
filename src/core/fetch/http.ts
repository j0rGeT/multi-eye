/**
 * HTTP 抓取基元。
 *
 * 两个必须自己控制的点：
 *  1. 大小上限 —— 不设限的话一个误判成 HTML 的视频文件能吃掉几个 G 内存
 *  2. 超时 —— 搜索引擎返回的链接里有一堆慢站/死站，不能让它拖垮整批
 *
 * 关于代理：统一走 agent.ts 里的 httpFetch —— Node 的全局 fetch 不读
 * 代理环境变量，而本机的 VPN 出口有时是唯一可达路径（境外站点）。
 * 代理地址由 config.fetchProxyUrl 控制，置空即直连。
 *
 * ── 关于登录态 cookie（P14）──
 *
 * **只有这里和 `playwright.ts` 会带 cookie**，这是刻意的：
 *
 *   - `agent.ts` 的 `httpFetch` 是更底层的网络原语，搜索结果 provider、LLM
 *     调用都从它走。凭证的注入点放在那一层的话，`grep Cookie` 就再也说不清
 *     「到底哪些请求带着你的身份出去了」。
 *   - `http.ts` 这两个函数（`fetchHtml` / `fetchBinary`）才是「以你的身份读
 *     一个公开页面」这件事本身。
 *
 * 发给谁是 `core/auth/cookies.ts` 里那张表说了算（目前只有 zhihu.com 及其子域），
 * 别的站点一个字节都拿不到。
 *
 * 实测：undici 与 Node 全局 fetch 都允许手动设 `Cookie` 头（浏览器里它是禁止
 * 头，所以这个组合是量过的，不是想当然）。
 */

import { config } from "@/core/env";
import { cookieHeaderFor } from "@/core/auth/store";
import { httpFetch } from "./agent";

export interface HttpResult {
  ok: boolean;
  status: number;
  finalUrl: string;
  contentType: string;
  body: string;
  truncated: boolean;
  error?: string;
}

const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export async function fetchHtml(
  url: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<HttpResult> {
  const timeoutMs = opts.timeoutMs ?? config.fetchTimeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // 外部 signal 与超时 signal 合并：任一触发都要中止
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    // 只有 `core/auth/cookies.ts` 那张表里的站点、且用户真的登录过，才有值
    const cookie = await cookieHeaderFor(url);

    const res = await httpFetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": DESKTOP_UA,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Cache-Control": "no-cache",
        ...(cookie ? { Cookie: cookie } : {}),
      },
    });

    const contentType = res.headers.get("content-type") ?? "";

    // 非 HTML 直接放弃 —— 后面几步都假设有 DOM 可解析
    if (!/text\/html|application\/xhtml|text\/plain|application\/xml/i.test(contentType)) {
      return {
        ok: false,
        status: res.status,
        finalUrl: res.url || url,
        contentType,
        body: "",
        truncated: false,
        error: `非 HTML 内容（${contentType || "未知类型"}）`,
      };
    }

    const { text, truncated } = await readCapped(res, config.fetchMaxBytes);

    return {
      ok: res.ok,
      status: res.status,
      finalUrl: res.url || url,
      contentType,
      body: text,
      truncated,
      error: res.ok ? undefined : `HTTP ${res.status}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 0,
      finalUrl: url,
      contentType: "",
      body: "",
      truncated: false,
      error: /abort/i.test(msg) ? `超时（${timeoutMs}ms）` : msg,
    };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * 按字节上限读取响应体。超过上限就停止读取并标记 —— 显式截断，
 * 而不是让调用方拿到一个被静默砍掉的半截文档。
 */
async function readCapped(
  res: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const body = res.body;
  if (!body) return { text: await res.text(), truncated: false };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        chunks.push(value.slice(0, Math.max(0, maxBytes - (total - value.byteLength))));
        truncated = true;
        break;
      }
      chunks.push(value);
    }
  } finally {
    // 提前退出时必须取消，否则连接会一直挂着不释放
    if (truncated) await reader.cancel().catch(() => {});
  }

  const merged = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }

  return { text: new TextDecoder("utf-8").decode(merged), truncated };
}

/**
 * 下载二进制资源（图片等），返回 Buffer 与内容类型。
 *
 * **刻意不带 cookie**：表里那些站点的图片/视频都在独立 CDN 上
 * （知乎是 `*.zhimg.com`），`accountSiteFor` 本来就不会匹配到它们。
 * 而「每一个能把你的凭证发出去的地方」都是要单独审一遍的，所以这条边界
 * 画在 HTML 那一侧 —— 真的遇到同域二进制资源被 403 挡住，再加一行也不迟。
 */
export async function fetchBinary(
  url: string,
  opts: { signal?: AbortSignal; timeoutMs?: number; maxBytes?: number } = {},
): Promise<{ data: Buffer; contentType: string; error?: string }> {
  const timeoutMs = opts.timeoutMs ?? config.fetchTimeoutMs;
  const maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await httpFetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": DESKTOP_UA, Referer: new URL(url).origin },
    });
    if (!res.ok) {
      return { data: Buffer.alloc(0), contentType: "", error: `HTTP ${res.status}` };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) {
      return {
        data: Buffer.alloc(0),
        contentType: "",
        error: `超过大小上限（${buf.byteLength} > ${maxBytes}）`,
      };
    }
    return { data: buf, contentType: res.headers.get("content-type") ?? "" };
  } catch (err) {
    return {
      data: Buffer.alloc(0),
      contentType: "",
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}
