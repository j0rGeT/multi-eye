/**
 * 国内站点判定 —— 决定一个请求该直连还是走代理。
 *
 * 单独成一个**叶子模块**（不 import 任何东西）是因为它有两个消费者，而它们
 * 之间不能互相依赖：
 *
 *   - `fetch/agent.ts` —— HTTP 抓取层，那里写着这条分流的完整实测记录
 *   - `core/env.ts` —— `ytdlpCommonArgs()`，把同一个判断喂给 yt-dlp
 *
 * 让 `env.ts` 去 import `fetch/agent.ts` 会成环（agent.ts 读 config，而 config
 * 就在 env.ts 里）。ESM 能容忍这种环，但「谁先求值」变得依赖加载顺序，
 * 是那种平时没事、某天改个 import 顺序就炸的东西。判定逻辑放在这里，
 * 两边都往下引，环就不存在了。
 */

/**
 * 国内站点与它们的内容 CDN。
 *
 * 列出这一份的理由是：代理出口在境外，而这一类站点对境外 IP 要么超时、
 * 要么直接风控 —— 把它们的请求塞进 VPN 是纯损失。本机实测（2026-10）：
 *
 *   B站视频页   走代理 15 秒超时（→ 只能退回搜索摘要）；直连 0.8 秒拿到 45KB
 *   B站接口     走代理 HTTP 412 风控；直连 200
 *   知乎        两边都是 403（未登录被拦）—— 也就是说这条分流对知乎没有影响，
 *               别指望它能修好知乎
 *
 * 境外站点仍然走代理：那本来就是代理存在的理由。
 */
export const DOMESTIC_SUFFIXES = [
  // B站（含图片/字幕 CDN）
  "bilibili.com",
  "hdslb.com",
  "biliapi.net",
  // 知乎
  "zhihu.com",
  "zhimg.com",
  // 小红书
  "xiaohongshu.com",
  "xhscdn.com",
  // 百度系
  "baidu.com",
  "bdstatic.com",
  "bdimg.com",
  // 其余常见国内站点
  "weibo.com",
  "weibo.cn",
  "sina.com.cn",
  "douyin.com",
  "ixigua.com",
  "csdn.net",
  "juejin.cn",
  "cnblogs.com",
  "gitee.com",
  "qq.com",
  "163.com",
  "sohu.com",
  "alipay.com",
];

export function isDomesticHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  return DOMESTIC_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`));
}

/** 这个 URL 该走代理吗。解析不出主机名时按原策略（走代理）处理。 */
export function shouldProxy(url: string): boolean {
  try {
    return !isDomesticHost(new URL(url).hostname);
  } catch {
    return true;
  }
}
