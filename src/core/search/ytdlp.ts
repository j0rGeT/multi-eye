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
          publishedAt: parseYtdlpDate(e.upload_date),
          thumbnail:
            e.thumbnails?.at(-1)?.url ?? `https://i.ytimg.com/vi/${e.id}/mqdefault.jpg`,
          durationSec: e.duration ?? undefined,
        };
      });
  }
}

/** yt-dlp 的 upload_date 是 YYYYMMDD 紧凑格式。 */
function parseYtdlpDate(raw?: string | null): string | undefined {
  if (!raw || raw.length !== 8) return undefined;
  const y = raw.slice(0, 4);
  const m = raw.slice(4, 6);
  const d = raw.slice(6, 8);
  const date = new Date(`${y}-${m}-${d}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
