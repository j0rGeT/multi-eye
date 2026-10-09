import { NextResponse } from "next/server";
import {
  checkProxy,
  checkSearxng,
  config,
  describeLlmChain,
  describeSearchChain,
  hasLLM,
  hasSerper,
  hasYtdlp,
} from "@/core/env";

// 不导出 runtime：Next 16 里 Edge Runtime 已废弃、'nodejs' 是默认值，
// 文档明确要求移除该导出。force-dynamic 仍有效（未启用 Cache Components）。
export const dynamic = "force-dynamic";

/**
 * 各后端的可用性总览。
 *
 * 这里刻意把「缺失的能力」和「可操作的修复建议」一起返回 —— 这套系统里
 * 大部分故障都是配置问题（SearXNG 没起、json 格式没开、yt-dlp 没装），
 * 直接告诉用户怎么办比抛一个 500 有用得多。
 */
export async function GET() {
  const [searxng, ytdlp, proxy] = await Promise.all([
    checkSearxng(),
    hasYtdlp(),
    checkProxy(),
  ]);

  const checks = [
    {
      id: "searxng",
      label: "SearXNG 搜索",
      required: true,
      ok: searxng.ok,
      detail: searxng.ok ? config.searxngUrl : searxng.error,
      hint: searxng.hint,
    },
    {
      id: "proxy",
      label: "抓取代理",
      required: false,
      ok: proxy.ok,
      detail: config.fetchProxyUrl.trim() || "直连（未配置代理）",
      hint: proxy.ok
        ? "只对境外站点生效，国内站点（B站/知乎/小红书/百度…）自动直连 —— 从境外出口过去要么超时要么被风控。"
        : `代理不可达：${proxy.error}。置空 FETCH_PROXY_URL 可全部直连。`,
    },
    {
      id: "serper",
      label: "Serper API",
      required: false,
      ok: hasSerper(),
      detail: hasSerper() ? "已配置" : "未配置 SERPER_API_KEY",
      hint: "可选。配置后优先于 SearXNG，失败自动降级。",
    },
    {
      id: "ytdlp",
      label: "yt-dlp",
      required: false,
      ok: ytdlp,
      detail: ytdlp ? config.ytdlpPath : "未找到可执行文件",
      hint: "可选。缺失时 YouTube 退化为仅搜索摘要。安装：uv tool install yt-dlp",
    },
    {
      id: "llm",
      label: "LLM 语义构图",
      required: false,
      ok: hasLLM(),
      detail: hasLLM() ? describeLlmChain() : "未配置 LLM_API_KEY",
      hint: "可选。缺失时走本地启发式构图（分词 + TF-IDF + 共现 + Louvain）。",
    },
    {
      id: "playwright",
      label: "Playwright 无头浏览器",
      required: false,
      ok: config.enablePlaywright,
      detail: config.enablePlaywright ? "已启用" : "未启用",
      hint: "可选。用于 JS 空壳站点的正文降级抓取。",
    },
    /*
      ── 主题源（P8.2）──

      这三行**不做主动探测**。

      它们全都是免 key 的公开接口，唯一能让它们整体不可用的本地因素是
      **代理**（HN / arXiv / GitHub 都在境外，见 `fetch/agent.ts` 的域名分流）。
      所以 `ok` 直接跟着 proxy 那一行走：代理挂了三行一起变红，用户一眼就能
      看到根因是同一个，不用逐个去猜哪个源坏了。

      真的去 ping 一遍会让 `/api/health` 多打三个网络请求 —— 这个接口已经
      在打 SearXNG 和代理了，再叠三个就慢到不适合做首屏判据（P9.2 记过
      这个坑）。而**每次搜索实际的成败**，`providerLog` 里本来就逐条记着，
      那才是权威的运行时事实。
    */
    {
      id: "github",
      label: "GitHub 检索",
      required: false,
      ok: proxy.ok,
      detail: !proxy.ok
        ? "代理不可达，境外源将同时失败"
        : config.githubToken
          ? "已配置 GITHUB_TOKEN（30 次/分）"
          : "未认证（10 次/分，按 IP）",
      hint: "可选。未认证时配额 10 次/分钟，超了会返回空结果并在检索日志写明原因，不会让整次搜索失败。",
    },
    {
      id: "hackernews",
      label: "Hacker News 检索",
      required: false,
      ok: proxy.ok,
      detail: proxy.ok ? "Algolia 公开接口，免 key" : "代理不可达，境外源将同时失败",
      hint: "可选。整次搜索只调用一次（主题源），失败不影响主搜索。",
    },
    {
      id: "arxiv",
      label: "arXiv 检索",
      required: false,
      ok: proxy.ok,
      detail: proxy.ok ? "Atom 公开接口，免 key" : "代理不可达，境外源将同时失败",
      hint: "可选。官方要求请求间隔 ≥3 秒，因此与其它主题源串行受控。",
    },
    {
      id: "juejin",
      label: "掘金",
      required: false,
      // 掘金没有直连 provider，完全靠搜索引擎的索引，所以它的可用性跟着 SearXNG
      ok: searxng.ok,
      detail: searxng.ok
        ? "经搜索引擎索引检索（无直连 provider）"
        : "依赖 SearXNG 提供索引",
      hint: "国内站点，直连不走代理。能否搜到取决于上游是否收录，空结果不代表故障。",
    },
  ];

  // 只要必需的 SearXNG 挂了就算不健康；可选项缺失不影响整体可用
  const healthy = checks.filter((c) => c.required).every((c) => c.ok);

  return NextResponse.json({
    healthy,
    searchChain: describeSearchChain(),
    graphBuilder: hasLLM() ? "llm" : "heuristic",
    checks,
  });
}
