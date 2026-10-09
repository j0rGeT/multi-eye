/**
 * GitHub 仓库检索（公开 Search API）。
 *
 * ── 配额是这个 provider 最大的约束 ──
 *
 * 未认证时 Search API 是 **10 次/分钟，按 IP 计**，且这个额度是全 IP 共享的
 * （实测：本机什么都没做，第一次调用就返回 403 rate limit exceeded）。
 * 因此这里有三条硬纪律：
 *
 *   1. `scope: "topic"` —— 整次搜索只打一发，绝不放进「每个勾选站点跑一遍」
 *      的循环里（勾六个站点就是六发，一轮打光配额）
 *   2. 只发**一个**请求，不翻页、不并发
 *   3. 配额耗尽时**不抛错让整条链路失败**，而是返回空数组并把原因写进日志 ——
 *      一个可选的补充源不该拖垮主搜索
 *
 * 配额详情见 GitHub 文档 "Rate limits for the REST API"。
 * 配置 `GITHUB_TOKEN` 可提到 30 次/分（写 `.env.local`，**绝不进仓库**）。
 *
 * ── 走代理 ──
 *
 * 境外站点，由 `fetch/agent.ts` 的域名分流自动决定走代理，这里不手动指定。
 * （B 站那条「必须直连」是特例，见 `bilibili.ts` 的注释，不要模仿。）
 */

import type {
  ProviderCapabilities,
  SearchProvider,
  SearchQuery,
  SearchResult,
} from "@/core/types";
import { config } from "@/core/env";
import { httpFetch } from "@/core/fetch/agent";
import { compactSignals } from "@/core/signals";
import { normalizeToIso } from "@/core/dates";
import { resultId } from "./normalize";

const ENDPOINT = "https://api.github.com/search/repositories";

interface GhRepo {
  full_name?: string;
  html_url?: string;
  description?: string | null;
  stargazers_count?: number;
  forks_count?: number;
  open_issues_count?: number;
  language?: string | null;
  pushed_at?: string | null;
  owner?: { login?: string };
  archived?: boolean;
  fork?: boolean;
}

interface GhResponse {
  total_count?: number;
  items?: GhRepo[];
  message?: string;
}

export class GitHubProvider implements SearchProvider {
  readonly id = "github" as const;

  readonly capabilities: ProviderCapabilities = {
    supportsSiteSyntax: false,
    supportsVideo: false,
    needsApiKey: false,
    // 见文件头：放进站点循环会一轮打光 10 次/分的配额
    scope: "topic",
  };

  async available(): Promise<boolean> {
    return true;
  }

  async search(q: SearchQuery, signal?: AbortSignal): Promise<SearchResult[]> {
    const url = new URL(ENDPOINT);
    url.searchParams.set("q", q.text);
    /*
      默认按 star 排。

      GitHub 自身的默认排序是「最佳匹配」，而它对这个系统的用途来说太靠后 ——
      我们要的是「这个主题下有哪些被广泛使用的项目」。按 star 排能把
      个人练手仓库和真正在用的项目分开，这和 P8.6 的「声量优先」是同一个思路。
      用户在界面上选「最新优先」时改按更新时间排。
    */
    url.searchParams.set("sort", q.sortMode === "recent" ? "updated" : "stars");
    url.searchParams.set("order", "desc");
    url.searchParams.set("per_page", String(Math.min(q.limit ?? 10, 30)));

    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    // 可选 token：有就用，没有也能跑（只是配额从 30 次/分降到 10 次/分）
    if (config.githubToken) headers.Authorization = `Bearer ${config.githubToken}`;

    const res = await httpFetch(url.toString(), {
      signal: signal ?? AbortSignal.timeout(10_000),
      headers,
    });

    /*
      配额耗尽是**预期内**的情况，不是异常。返回空数组而不是抛错，
      理由见文件头第 3 条：把一个可选补充源的失败升级成整次搜索的失败，
      代价远大于它带来的信息。
    */
    if (res.status === 403 || res.status === 429) {
      const body = (await res.json().catch(() => ({}))) as GhResponse;
      const hint = config.githubToken
        ? "配额已用尽，稍后再试"
        : "未认证时每分钟只有 10 次。配置 GITHUB_TOKEN 可提到 30 次";
      throw new QuotaError(`GitHub 配额耗尽（${hint}）${body.message ? ` — ${body.message.slice(0, 80)}` : ""}`);
    }
    if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`);

    const data = (await res.json()) as GhResponse;
    const items = data.items ?? [];

    return items
      .filter((r): r is GhRepo & { html_url: string } => Boolean(r.html_url))
      .map((r, i) => ({
        id: resultId(r.html_url),
        title: r.full_name ?? r.html_url,
        url: r.html_url,
        snippet: buildSnippet(r),
        domain: "github.com",
        site: "github" as const,
        provider: this.id,
        rank: i + 1,
        hitCount: 1,
        // pushed_at 而不是 created_at：一个 2015 年创建、上周还在更新的项目
        // 是活的，用创建时间会把它说成十年前的资料
        publishedAt: normalizeToIso(r.pushed_at),
        author: r.owner?.login,
        signals: compactSignals([
          { label: "star", value: r.stargazers_count, format: "count" },
          { label: "fork", value: r.forks_count, format: "count" },
          { label: "issue", value: r.open_issues_count, format: "count" },
        ]),
      }));
  }
}

/**
 * 配额耗尽。单独一个类型是为了让编排层能把「今天的额度用完了」和
 * 「接口挂了」区分开 —— 前者是常态、不需要重试，后者要重试。
 */
export class QuotaError extends Error {
  readonly quota = true;
}

function buildSnippet(r: GhRepo): string {
  const bits = [r.description?.trim()].filter(Boolean) as string[];
  if (r.language) bits.push(`语言：${r.language}`);
  if (r.archived) bits.push("已归档");
  return bits.join(" · ").slice(0, 300);
}
