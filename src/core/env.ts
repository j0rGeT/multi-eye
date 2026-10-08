/**
 * 环境与可用性探测。
 *
 * 全部能力都是可选的 —— 这里只负责回答「某个后端能不能用」，
 * 由调用方决定降级策略。任何一处缺失都不应该让应用崩溃。
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * 定位 yt-dlp 可执行文件。
 *
 * 光靠默认值 "yt-dlp" 走 PATH 是不够的：uv tool / pip --user 装出来的二进制
 * 落在 ~/.local/bin，这个目录在交互式 shell 里通常已入 PATH，但从 IDE 或
 * launchd 拉起的 dev server 继承不到，于是「终端里能跑、应用里说没装」。
 * 所以按已知位置逐个探测，全不命中再退回 "yt-dlp" 交给 PATH 决定。
 */
function findYtdlp(): string {
  const candidates = [
    join(homedir(), ".local", "bin", "yt-dlp"),
    "/opt/homebrew/bin/yt-dlp",
    "/usr/local/bin/yt-dlp",
  ];
  return candidates.find((p) => existsSync(p)) ?? "yt-dlp";
}

export const config = {
  searxngUrl: process.env.SEARXNG_URL ?? "http://localhost:8888",
  serperApiKey: process.env.SERPER_API_KEY ?? "",
  ytdlpPath: process.env.YTDLP_PATH ?? findYtdlp(),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  enablePlaywright: process.env.ENABLE_PLAYWRIGHT === "true",
  fetchTimeoutMs: Number(process.env.FETCH_TIMEOUT_MS ?? 15_000),
  fetchMaxBytes: Number(process.env.FETCH_MAX_BYTES ?? 5 * 1024 * 1024),
  downloadConcurrency: Number(process.env.DOWNLOAD_CONCURRENCY ?? 3),

  /**
   * 抓取与下载走的代理。设成空字符串即关闭。
   *
   * 为什么必须显式配置：Node 的全局 fetch（undici）**不会**读
   * HTTP_PROXY/HTTPS_PROXY 环境变量，所以 shell 里 export 了也没用，
   * 必须自己挂 ProxyAgent。这里默认指向本机的 VPN 代理。
   *
   * 代价要说清楚：走 VPN 意味着用境外 IP 访问知乎/B站这类国内站点，
   * 部分站点会对境外 IP 降级或拦截。若发现国内站点反而抓不到，
   * 把 FETCH_PROXY_URL 置空即可回到直连。
   */
  fetchProxyUrl: process.env.FETCH_PROXY_URL ?? "http://127.0.0.1:6666",
} as const;

export function hasSerper(): boolean {
  return config.serperApiKey.length > 0;
}

/**
 * 所有 yt-dlp 调用共用的参数：忽略用户级配置 + 挂代理。
 *
 * 为什么显式传 --proxy 而不靠 HTTPS_PROXY 环境变量：yt-dlp 确实会读环境变量，
 * 但那样项目里就有两处代理真相，容易出现「网页走了代理、yt-dlp 直连」这种
 * 极难排查的不一致。FETCH_PROXY_URL 保持唯一来源。
 *
 * 这一条对本项目是硬需求而非优化：调用方要访问的是 YouTube，在当前网络下
 * 直连拿不到任何结果。
 */
export function ytdlpCommonArgs(): string[] {
  const args = ["--ignore-config", "--no-warnings"];
  const proxy = config.fetchProxyUrl.trim();
  if (proxy) args.push("--proxy", proxy);
  return args;
}

export function hasLLM(): boolean {
  return config.anthropicApiKey.length > 0;
}

/** yt-dlp 是否真的可执行。结果缓存，避免每次搜索都 fork 一个进程。 */
let ytdlpProbe: Promise<boolean> | undefined;

export function hasYtdlp(): Promise<boolean> {
  ytdlpProbe ??= execFileAsync(config.ytdlpPath, ["--version"], {
    timeout: 5_000,
  })
    .then(() => true)
    .catch(() => false);
  return ytdlpProbe;
}

/**
 * 代理是否可达。
 *
 * 只做 TCP 连通性探测，不去访问外网站点 —— 检查的是「代理本身是否活着」，
 * 不是「某个目标站是否可达」，后者随目标变化，不适合放进健康检查。
 */
export async function checkProxy(): Promise<{ ok: boolean; error?: string }> {
  const url = config.fetchProxyUrl.trim();
  if (!url) return { ok: true }; // 直连模式，无需检查

  return new Promise((resolve) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      resolve({ ok: false, error: `代理地址无法解析：${url}` });
      return;
    }

    const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
    const socket = createConnection({ host: u.hostname, port });
    const done = (err?: Error) => {
      socket.destroy();
      resolve(err ? { ok: false, error: err.message } : { ok: true });
    };
    socket.setTimeout(2_000, () => done(new Error("连接超时")));
    socket.once("connect", () => done());
    socket.once("error", (e) => done(e));
  });
}

/** SearXNG 是否连通。不只是看端口，而是真的发一次 json 查询验证格式已启用。 */
export async function checkSearxng(): Promise<{
  ok: boolean;
  error?: string;
  hint?: string;
}> {
  const url = `${config.searxngUrl.replace(/\/$/, "")}/search?q=test&format=json`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(5_000),
    });
    if (res.status === 403) {
      // 这是最容易踩的坑，单独给出可操作的提示而不是一句 "403"
      return {
        ok: false,
        error: "HTTP 403",
        hint:
          "SearXNG 默认只输出 html 格式。请在 searxng/settings.yml 的 " +
          "search.formats 中加入 json，然后 pnpm searxng:down && pnpm searxng:up。",
      };
    }
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    await res.json();
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: msg,
      hint: "SearXNG 未启动？运行 `pnpm searxng:up`。",
    };
  }
}

/**
 * 当前生效的搜索链路。用于在 UI 上直白地告诉用户「现在走的是哪条路」。
 */
export function describeSearchChain(): string[] {
  const chain: string[] = [];
  if (hasSerper()) chain.push("serper");
  chain.push("searxng");
  return chain;
}
