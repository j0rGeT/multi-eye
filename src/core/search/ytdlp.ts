/**
 * yt-dlp 搜索提供方（YouTube 专用，免 API key）。
 *
 * 单独做 YouTube 是因为搜索引擎给的视频结果质量很差 —— 只有标题和一句摘要。
 * yt-dlp 能直接拿到播放量、时长、频道名、封面，这些是判断资料价值的关键信号，
 * 也是拓扑里节点权重的良好输入。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  ProviderCapabilities,
  SearchProvider,
  SearchQuery,
  SearchResult,
} from "@/core/types";
import { config, hasYtdlp, ytdlpCommonArgs } from "@/core/env";
import { resultId } from "./normalize";
import { normalizeToIso } from "@/core/dates";
import { compactSignals } from "@/core/signals";

const execFileAsync = promisify(execFile);

interface YtdlpEntry {
  id?: string;
  title?: string;
  url?: string;
  duration?: number | null;
  view_count?: number | null;
  channel?: string;
  uploader?: string;
  upload_date?: string | null;
  thumbnails?: { url: string; width?: number }[];
  description?: string | null;
  /** --flat-playlist 时部分字段为 null，用 ie_key 兜底判断可用性 */
  ie_key?: string;
}

interface YtdlpPlaylist {
  entries?: YtdlpEntry[];
}

export class YtDlpProvider implements SearchProvider {
  readonly id = "ytdlp" as const;

  readonly capabilities: ProviderCapabilities = {
    // yt-dlp 只能在 YouTube 内搜索，无法接受 site: 语法
    supportsSiteSyntax: false,
    supportsVideo: true,
    needsApiKey: false,
  };

  async available(): Promise<boolean> {
    return hasYtdlp();
  }

  async search(q: SearchQuery, signal?: AbortSignal): Promise<SearchResult[]> {
    if (!(await hasYtdlp())) {
      throw new Error(`未找到 yt-dlp 可执行文件（YTDLP_PATH=${config.ytdlpPath}）`);
    }

    // site 限定了不是 YouTube 的站点时直接跳过 —— 不该拿 YouTube 结果充数
    if (q.site && q.site !== "youtube" && q.site !== "web") return [];

    const limit = Math.min(q.limit ?? 10, 30);

    // 必须用参数数组，绝不拼 shell 字符串：查询词来自用户输入，拼接会有注入风险
    const args = [
      ...ytdlpCommonArgs(),
      "--dump-single-json",
      "--flat-playlist",
      `ytsearch${limit}:${q.text}`,
    ];

    const { stdout } = await execFileAsync(config.ytdlpPath, args, {
      timeout: 60_000,
      maxBuffer: 32 * 1024 * 1024,
      signal,
    });

    const data = JSON.parse(stdout) as YtdlpPlaylist;
    const entries = data.entries ?? [];

    return entries
      .filter((e): e is YtdlpEntry & { id: string } => Boolean(e.id))
      .map((e, i) => {
        const url = `https://www.youtube.com/watch?v=${e.id}`;
        return {
          id: resultId(url),
          title: (e.title ?? "").trim() || e.id,
          url,
          snippet: (e.description ?? "").slice(0, 300).trim(),
          domain: "youtube.com",
          site: "youtube" as const,
          provider: this.id,
          rank: i + 1,
          hitCount: 1,
          author: e.channel ?? e.uploader,
          /*
            `--flat-playlist` 下 `upload_date` 恒为 null —— 实测过，YouTube 的
            搜索结果 JSON 里根本没有这个字段，`timestamp` / `release_timestamp`
            也同样是 null。想在这里拿到日期，唯一的办法是去掉 `--flat-playlist`
            让 yt-dlp 逐个视频做完整抽取，10 个视频要跑几分钟。

            所以搜索阶段这里老实返回 undefined，日期留给抓取阶段补
            （`fetch/youtube.ts` 那时本来就要对单个视频跑一次 yt-dlp，
            顺手带上 `--write-info-json` 即可，零额外请求）。
          */
          publishedAt: normalizeToIso(e.upload_date),
          thumbnail:
            e.thumbnails?.at(-1)?.url ?? `https://i.ytimg.com/vi/${e.id}/mqdefault.jpg`,
          durationSec: e.duration ?? undefined,
          // 播放量在 flat 模式下是可用的，而它正是判断一个视频值不值得看的主要依据
          signals: compactSignals([
            { label: "播放", value: e.view_count, format: "count" },
          ]),
        };
      });
  }
}
