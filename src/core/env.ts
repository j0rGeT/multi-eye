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
