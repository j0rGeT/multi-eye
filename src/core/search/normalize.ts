/**
 * URL 归一化与去重键。
 *
 * 去重的正确性完全取决于这里：同一个知乎回答可能同时被 baidu 和 google 返回，
 * 但 URL 上挂着不同的 utm 参数。不归一化的话图里会出现重复节点，
 * 直接拉低拓扑质量。
 */

import { createHash } from "node:crypto";
import { resolveSite } from "./sites";
import type { SiteKey } from "@/core/types";

/** 纯跟踪参数，对内容定位没有任何影响，一律剥掉。 */
const TRACKING_PARAMS = [
  /^utm_/,
  /^fbclid$/,
  /^gclid$/,
  /^yclid$/,
  /^msclkid$/,
  /^ref$/,
  /^ref_?src$/,
  /^source$/,
  /^spm$/,
  /^share_?/,
  /^from$/,
  /^share_token$/,
  /^_?from$/,
  /^vd_source$/,
  /^buvid$/,
  /^wfr$/,
  /^share_source$/,
  /^s_r$/,
  /^scene$/,
  /^clicktime$/,
  /^weibo_id$/,
  /^sr_share$/,
  /^utm$/,
];

/** 各平台用于定位内容的关键参数 —— 这些必须保留，否则会误合并不同页面。 */
const KEEP_PARAMS: Partial<Record<SiteKey, string[]>> = {
  youtube: ["v", "list"],
  bilibili: ["bvid", "aid", "p"],
  x: ["status"],
  /*
    arXiv 的版本号必须留着。

    `abs/2610.12448v1` 和 `...v3` 是同一篇论文的两个版本，而 v2/v3 常带
    重大修订 —— 把 `v` 当跟踪参数剥掉，三个版本会被归一成同一条 URL，
    去重后只剩下先到的那个，正是「同一篇论文的不同版本被误合并」。

    注意 arXiv 的版本号在**路径里**（`/abs/2610.12448v3`）而不是查询串里，
    所以这里列 `v` 其实防的是 `?v=` 这种形态；路径里的版本号天然被保留，
    不需要额外处理 —— 但把它写出来，是为了让下一个改这个文件的人知道
    「版本号是内容的一部分」这件事已经被考虑过了。
  */
  arxiv: ["v"],
};

/**
 * 归一化 URL，用于去重比较。不改变其可访问性（返回的仍是一个合法 URL）。
 */
export function normalizeUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw.trim();
  }

  // 协议统一：http 与 https 指向同一内容
  u.protocol = "https:";

  // host 统一小写，并剥掉 www.
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");

  // 主机别名归一
  if (u.hostname === "twitter.com") u.hostname = "x.com";
  if (u.hostname === "m.youtube.com") u.hostname = "youtube.com";
  if (u.hostname === "youtu.be") {
    // 短链转为标准形式，否则和 watch?v= 形式的同一条视频无法去重
    const id = u.pathname.slice(1);
    u.hostname = "youtube.com";
    u.pathname = "/watch";
    u.search = `?v=${id}`;
  }
  // 小红书移动端与桌面端
  if (u.hostname === "www.xiaohongshu.com") u.hostname = "xiaohongshu.com";

  // 参数过滤
  const site = resolveSite(u.toString());
  const keep = new Set(KEEP_PARAMS[site] ?? []);
  const params = [...u.searchParams.entries()].filter(([k]) =>
    keep.size > 0 ? keep.has(k) : !TRACKING_PARAMS.some((re) => re.test(k)),
  );
  // 保留参数按 key 排序，保证 ?a=1&b=2 与 ?b=2&a=1 归一为同一串
  params.sort(([a], [b]) => a.localeCompare(b));
  u.search = "";
  for (const [k, v] of params) u.searchParams.append(k, v);

  // hash 一律剥掉：站内锚点不改变内容
  u.hash = "";

  // 去掉尾部斜杠（但保留根路径的 "/"）
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
    u.pathname = u.pathname.replace(/\/+$/, "");
  }

  return u.toString();
}

/** 稳定的去重键：归一化 URL 的 sha1 前 16 位。 */
export function resultId(rawUrl: string): string {
  const normalized = normalizeUrl(rawUrl);
  return createHash("sha1").update(normalized).digest("hex").slice(0, 16);
}

/** 从 URL 取展示用域名。 */
export function displayDomain(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
