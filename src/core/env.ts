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
import { shouldProxy } from "@/core/net/domestic";

const execFileAsync = promisify(execFile);

/**
 * 定位 yt-dlp 可执行文件。
 *
 * 光靠默认值 "yt-dlp" 走 PATH 是不够的：uv tool / pip --user 装出来的二进制
 * 落在 ~/.local/bin，这个目录在交互式 shell 里通常已入 PATH，但从 IDE 或
 * launchd 拉起的 dev server 继承不到，于是「终端里能跑、应用里说没装」。
 * 所以按已知位置逐个探测，全不命中再退回 "yt-dlp" 交给 PATH 决定。
 *
 * 顺序是有实测依据的：官方单文件二进制（bin/yt-dlp，PyInstaller onefile）
 * 在本机每次启动要 ~23 秒 —— CPU 只占 3%，全程在等 I/O，而 uv/pip 装的
 * 标准安装只要 0.1 秒。本项目对 yt-dlp 的调用是「一次搜索 + 每条视频一次
 * 字幕」，23 秒的启动开销会让整条链直接不可用，所以单文件二进制只能垫底。
 */
function findYtdlp(): string {
  const candidates = [
    join(homedir(), ".local", "bin", "yt-dlp"),
    "/opt/homebrew/bin/yt-dlp",
    "/usr/local/bin/yt-dlp",
    join(process.cwd(), "bin", "yt-dlp"),
  ];
  return candidates.find((p) => existsSync(p)) ?? "yt-dlp";
}

export const config = {
  searxngUrl: process.env.SEARXNG_URL ?? "http://localhost:8888",
  serperApiKey: process.env.SERPER_API_KEY ?? "",
  /**
   * 可选的 GitHub token。
   *
   * 没有它 GitHub 检索照样能跑，只是未认证的 Search API 每分钟只有 10 次
   * 且按 IP 计 —— 实测经常一上来就已经用光了。配上之后提到 30 次/分。
   *
   * 写进 `.env.local`（已在 .gitignore 里），**绝不进仓库**。
   */
  githubToken: process.env.GITHUB_TOKEN ?? "",
  ytdlpPath: process.env.YTDLP_PATH ?? findYtdlp(),
  /**
   * LLM 构图。走 OpenAI 协议的 /chat/completions，所以任何兼容端点都能接：
   * DeepSeek、OpenAI、通义、本地 vLLM 之间只差 base url 和模型名。
   *
   * 换协议（比如改用 Anthropic 原生 SDK）不是换三个环境变量的事，是要改
   * llm.ts 里的调用形状 —— 那就明说，别假装它是可插拔的。
   */
  llmApiKey: process.env.LLM_API_KEY ?? "",
  llmBaseUrl: (process.env.LLM_BASE_URL ?? "https://api.deepseek.com")
    .replace(/\/+$/, ""),
  llmModel: process.env.LLM_MODEL ?? "deepseek-flash",
  /**
   * 输出上限。必须给得比「答案本身需要的长度」宽很多：
   * deepseek-flash 是推理模型，思维链和正文共享这一份额度，额度耗尽时
   * content 会是空字符串（finish_reason=length），看起来像「模型什么都没说」。
   */
  llmMaxTokens: Number(process.env.LLM_MAX_TOKENS ?? 32_768),
  /** 单次 LLM 请求的超时。默认给足 5 分钟：几十篇长文的抽取本来就是慢活。 */
  llmTimeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 300_000),
  enablePlaywright: process.env.ENABLE_PLAYWRIGHT === "true",

  /*
    ── 搜索条数 ──

    原先这三个数写死在 orchestrate.ts / registry.ts 里（每站 10、youtube 15 等），
    调一下就得改代码。上提到 config 之后仍然保留原值作默认，避免默认行为突变。

    **实测结论（2026-10，本机 SearXNG + bing/duckduckgo/startpage/mojeek 四引擎）**：
    把每站上限从 10 提到 20 **不增加任何网络耗时** —— `limit` 是响应回来之后的
    `.slice()`（见 search/searxng.ts:98），上游请求逐字节相同，三次查询的耗时
    差异（3.0s / 1.4s / 1.2s）纯粹是网络抖动。所以这里不存在「提条数就要等更久」
    的取舍，不需要为了赶时间退回 12。

    但收益是**有上限的**，因为搜多搜少由上游引擎决定：

      | 查询                     | 引擎实际给出 | 旧的 10 条上限丢掉了 |
      |--------------------------|--------------|----------------------|
      | DeepSeek-V4.1-Flash      | 10           | 0 条                 |
      | linux                    | 13           | 3 条                 |
      | python asyncio           | 20           | 10 条                |

    也就是说：用户那个具体查询本来就只有 10 条可拿，**提到 20 对它毫无帮助** ——
    它的问题是「拿到的这 10 条里有 7 条不切题」，那是 P12.3 相关性判定要解决的，
    不是条数问题。提条数只对宽泛主题（能拿到 11~20 条的那类）有效。

    另一条已实测排掉的路线：**多页抓取**。SearXNG 的 `pageno=2/3` 在上面三个查询
    （含 `linux` 这种极常见的词）上一律返回 **0 条**，所以「翻页凑够 40 条」在这套
    引擎组合下走不通，不要再往那个方向试。
  */
  searchPerSiteLimit: Number(process.env.SEARCH_PER_SITE_LIMIT ?? 20),
  /**
   * 链上某条 provider 拿到这么多条就不再往链下游走（短路，见 orchestrate.ts 的
   * `ENOUGH_RESULTS`）。**保持 4 不要动**：它管的是「还要不要多打一次付费 provider」，
   * 调高会让每次搜索都为一点边际覆盖多付一次钱，而且多出来的结果正好是相关性判定
   * 要标的那批噪音。
   */
  searchEnoughResults: Number(process.env.SEARCH_ENOUGH_RESULTS ?? 4),
  searchYoutubeLimit: Number(process.env.SEARCH_YOUTUBE_LIMIT ?? 20),
  searchBilibiliLimit: Number(process.env.SEARCH_BILIBILI_LIMIT ?? 20),
  /**
   * 话题型 provider（HN / GitHub / arXiv / RSS）各自的条数。
   *
   * 这几个不跟 `searchPerSiteLimit` 走，因为它们的「一条」成本差很多：arXiv 与
   * GitHub 走的是官方 API（有速率限制），RSS 是直接拉别人的 feed。混在一个数里
   * 会让调其中一个必然误伤另一个。
   *
   * 当前值与原写死值一致 —— 这一轮只是把它们挪进 config，不改默认行为。
   */
  searchTopicLimit: {
    hackernews: Number(process.env.SEARCH_HN_LIMIT ?? 15),
    github: Number(process.env.SEARCH_GITHUB_LIMIT ?? 10),
    arxiv: Number(process.env.SEARCH_ARXIV_LIMIT ?? 10),
    rss: Number(process.env.SEARCH_RSS_LIMIT ?? 20),
  } as Record<string, number>,

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
   * 只对**境外**站点生效：国内站点（B站/知乎/小红书/百度…）会自动直连 ——
   * 实测从 VPN 出口过去要么超时要么被风控，所以这不是优化而是修错。
   * 判定逻辑见 fetch/agent.ts 的 DOMESTIC_SUFFIXES。
   */
  fetchProxyUrl: process.env.FETCH_PROXY_URL ?? "http://127.0.0.1:6666",
} as const;

export function hasSerper(): boolean {
  return config.serperApiKey.length > 0;
}

/**
 * 所有 yt-dlp 调用共用的参数：忽略用户级配置 + **按目标站点**决定挂不挂代理。
 *
 * `target` 是这次要访问的那个 URL，必传 —— 参数按域名分流是这里唯一容易搞错、
 * 又只有在真跑一次时才暴露的地方。
 *
 * ── 为什么必须显式传 `--proxy ""`，而不是「国内站点就不传 `--proxy`」──
 *
 * 实测（2026-10）：本机 macOS 的系统级 HTTPS 代理指向 127.0.0.1:6666，而
 * yt-dlp 的代理来源不止环境变量 —— `urllib.request.getproxies()` 会去读系统
 * 代理设置。于是**即使 `--ignore-config`、即使 `env -u https_proxy`，
 * Proxy map 里照样有 http/https/socks 三条**，B站照样被塞进境外出口：
 *
 *   yt-dlp <B站视频>                    → ERROR: _ssl.c:1011: handshake timed out
 *   yt-dlp --proxy "" <同一个视频>       → 正常拿到标题与时长
 *
 * 所以国内目标必须**显式清空**代理，光是不加这个参数是不够的。这与
 * `fetch/agent.ts` 给 HTTP 层做的是同一件事（见 `core/net/domestic.ts`），
 * 只是 yt-dlp 这条链此前漏了。
 *
 * ── 为什么显式传代理地址而不靠环境变量 ──
 *
 * 那样项目里就有两处代理真相，容易出现「网页走了代理、yt-dlp 直连」这种极难
 * 排查的不一致。FETCH_PROXY_URL 保持唯一来源。
 */
export function ytdlpCommonArgs(target: string): string[] {
  const args = ["--ignore-config", "--no-warnings"];
  const proxy = config.fetchProxyUrl.trim();
  if (!proxy) return args;
  // 空串是「明确不要代理」，与「没传这个参数」不是一回事 —— 见上面的实测
  args.push("--proxy", shouldProxy(target) ? proxy : "");
  return args;
}

/**
 * **只给 YouTube 用**的额外参数：换一个播放器端点，绕过机器人墙。
 *
 * 实现与实测记录在 `core/ytdlp-args.ts` —— 那边是零 import 的叶子模块，
 * 所以 e2e 能直接引它做回归。这里只是转发，让三个调用点继续从 env 取。
 */
export { ytdlpYoutubeArgs } from "@/core/ytdlp-args";

export function hasLLM(): boolean {
  return config.llmApiKey.length > 0;
}

/**
 * LLM 走的是哪条链路。给健康检查和界面上的一行说明用。
 *
 * 调用本身**不经过 FETCH_PROXY_URL**。那条代理是为抓取准备的：目标站点在
 * 墙外，本机得从境外出口出去。LLM 端点（DeepSeek）在境内，把 API 请求塞进
 * 同一个境外出口只会更慢、更容易被判成异常流量 —— 两件事的网络需求正好相反，
 * 所以 llm.ts 用全局 fetch 直连，而不是 httpFetch。
 */
export function describeLlmChain(): string {
  return `${config.llmModel} @ ${config.llmBaseUrl}`;
}

/**
 * yt-dlp 是否真的可执行。结果缓存，避免每次搜索都 fork 一个进程。
 *
 * 超时给到 30 秒而不是几秒：单文件二进制的启动开销可以到 23 秒（见 findYtdlp
 * 的注释），用短超时会把一个能用的二进制判成「未安装」，而用户从报错里看不出
 * 真正的原因。探测结果被缓存，所以这笔开销整个进程只付一次。
 */
let ytdlpProbe: Promise<boolean> | undefined;

export function hasYtdlp(): Promise<boolean> {
  ytdlpProbe ??= execFileAsync(config.ytdlpPath, ["--version"], {
    timeout: 30_000,
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
