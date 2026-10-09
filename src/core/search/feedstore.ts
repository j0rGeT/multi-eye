/**
 * RSS 订阅表的读写。
 *
 * 沿用项目里已有的「模板入库 + 实例 gitignore」惯例（`searxng/settings.yml`
 * 就是这么做的）：
 *
 *   - `config/feeds.example.json` —— **提交进 git**，是一份能用的默认订阅
 *   - `config/feeds.json`         —— 用户实际在用的那份，**已 gitignore**
 *
 * 这样用户改了订阅不会污染仓库，新克隆下来也能直接跑（代码里内置一份默认）。
 *
 * ── 为什么内置默认而不只依赖 example 文件 ──
 *
 * `feeds.json` 不存在时不能让 RSS 这条源直接哑掉 —— 那样「默认订阅能用」
 * 这件事就依赖用户先手动拷贝一次文件，而界面上的增删又会去写 feeds.json。
 * 内置一份默认，读取时按「feeds.json → 内置默认」的次序回退，任何状态下
 * 都有一条可用的订阅表。
 *
 * ── 文件损坏当空表降级 ──
 *
 * 用户手改 JSON 写坏一个逗号是很常见的事。这时候**不要**抛错让整次搜索挂掉，
 * 也不要把损坏的表当成「用户取消了所有订阅」默默覆盖掉 —— 前者太脆，
 * 后者会吃掉用户的数据。做法是：解析失败就回退到默认订阅并把原因带出去，
 * 让界面能提示「你的 feeds.json 读不了，现在用的是默认订阅」。
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

export interface Feed {
  /** 展示名。报告和日志里用它标识来源。 */
  title: string;
  url: string;
  /** 停用的订阅保留在表里但不参与抓取。 */
  enabled: boolean;
}

const CONFIG_DIR = path.join(process.cwd(), "config");
const FEEDS_PATH = path.join(CONFIG_DIR, "feeds.json");

/**
 * 内置默认订阅。
 *
 * ── 这几条是**实测筛出来的**，不是照着名气挑的 ──
 *
 * 筛选标准是「返回 200 **且能解析出条目**」。第二条才是关键：RSS 有个很坑的
 * 失败模式 —— 站点下线了 RSS 但保留了路由，或者前端改成了 SPA，请求照样
 * 返回 200，内容却是一整页 HTML 外壳。
 *
 * 实测记录（2026-10）：
 *   - `36kr.com/feed`   → 200，但正文是 `<!DOCTYPE html>`，**0 条目**
 *   - `juejin.cn/rss`   → 200，非 XML（站内接口要签名头，见 sites.ts）
 *   - `zhihu.com/rss`   → 200，非 XML
 *   - `jiqizhixin.com/rss` → 302
 *
 * 所以计划里写的「36氪」换成了下面这批**真的能解析出条目**的源。
 * 一条解析不出东西的订阅比没有更糟：它会让用户以为这个站没更新。
 */
export const DEFAULT_FEEDS: Feed[] = [
  { title: "少数派", url: "https://sspai.com/feed", enabled: true },
  { title: "V2EX", url: "https://www.v2ex.com/index.xml", enabled: true },
  { title: "InfoQ 中文", url: "https://www.infoq.cn/feed", enabled: true },
  { title: "博客园", url: "https://feed.cnblogs.com/blog/sitehome/rss", enabled: true },
  { title: "开源中国", url: "https://www.oschina.net/news/rss", enabled: true },
  { title: "阮一峰的网络日志", url: "https://www.ruanyifeng.com/blog/atom.xml", enabled: true },
];

export interface FeedLoadResult {
  feeds: Feed[];
  /** 真实的 feeds.json 是否存在。不存在时界面该提示「尚未自定义」。 */
  fromFile: boolean;
  /** 读取失败的原因。有值就说明回退到了内置默认。 */
  error?: string;
}

/** 校验一条来路不明的订阅项（可能来自手改的 JSON，或界面上贴的 URL）。 */
function coerceFeed(raw: unknown): Feed | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const url = typeof o.url === "string" ? o.url.trim() : "";
  if (!url) return null;
  // 只收 http(s)：`file://` 能让这个接口变成任意本地文件读取器
  if (!/^https?:\/\//i.test(url)) return null;
  return {
    url,
    title:
      typeof o.title === "string" && o.title.trim() ? o.title.trim() : url,
    // 缺省视为启用：用户手工加一条进来，意图显然是「用它」
    enabled: o.enabled !== false,
  };
}

export async function loadFeeds(): Promise<FeedLoadResult> {
  if (!existsSync(FEEDS_PATH)) {
    return { feeds: DEFAULT_FEEDS, fromFile: false };
  }
  try {
    const raw = JSON.parse(await readFile(FEEDS_PATH, "utf8")) as unknown;
    const list = Array.isArray(raw) ? raw : (raw as { feeds?: unknown })?.feeds;
    if (!Array.isArray(list)) {
      return {
        feeds: DEFAULT_FEEDS,
        fromFile: true,
        error: "feeds.json 的结构不是数组，已回退到默认订阅",
      };
    }
    const feeds = list.map(coerceFeed).filter((f): f is Feed => f !== null);
    if (feeds.length === 0) {
      return {
        feeds: DEFAULT_FEEDS,
        fromFile: true,
        error: "feeds.json 里没有一条合法的订阅，已回退到默认订阅",
      };
    }
    return { feeds, fromFile: true };
  } catch (err) {
    return {
      feeds: DEFAULT_FEEDS,
      fromFile: true,
      error: `feeds.json 解析失败（${
        err instanceof Error ? err.message : String(err)
      }），已回退到默认订阅`,
    };
  }
}

/** 写回订阅表。返回写入结果，供路由决定回什么状态码。 */
export async function saveFeeds(feeds: Feed[]): Promise<{ ok: boolean; error?: string }> {
  const cleaned = feeds.map(coerceFeed).filter((f): f is Feed => f !== null);
  if (cleaned.length !== feeds.length) {
    return { ok: false, error: "有订阅项的 URL 不是合法的 http(s) 地址" };
  }
  try {
    await mkdir(CONFIG_DIR, { recursive: true });
    await writeFile(FEEDS_PATH, JSON.stringify(cleaned, null, 2), "utf8");
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** feeds.json 的路径，供界面提示「配置文件在哪」。 */
export function feedsPath(): string {
  return FEEDS_PATH;
}
