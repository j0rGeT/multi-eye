/**
 * 各类下载目标的执行单元。
 *
 * 四类目标走三条完全不同的路：
 *
 *   article / transcript  内容已经在会话里了（抓取阶段就拿到的正文或字幕），
 *                         所以是纯本地写盘，不联网，永远不会失败
 *   image                 走 HTTP，需要代理、需要续传
 *   media                 交给 yt-dlp，进度只能从它的输出里解析
 *
 * 把它们放在一个接口下是为了让队列那一层不需要知道差异 —— 队列只管
 * 「执行一个任务、收到若干次进度回调、最后得到一个结果」。
 */

import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import type { Document, DownloadKind } from "@/core/types";
import { config, ytdlpCommonArgs } from "@/core/env";
import { httpFetch } from "@/core/fetch/agent";
import { siteLabel } from "@/core/search/sites";

const execFileAsync = promisify(execFile);

export interface TaskPlan {
  kind: DownloadKind;
  /** 相对 assets/ 的路径。images 类指向目录。 */
  outputPath: string;
  /** 预期字节数。未知则为 undefined，前端显示不确定进度条。 */
  bytesTotal?: number;
}

export interface RunContext {
  /** 绝对路径的 assets 目录。 */
  assetsDir: string;
  doc: Document;
  plan: TaskPlan;
  signal?: AbortSignal;
  onProgress: (bytesDone: number, bytesTotal?: number) => void;
}

/**
 * 为一篇资料规划要下载哪些产物。
 *
 * 每次调用返回的是这篇资料的完整产物清单，而不是增量 —— 队列据此去重，
 * 避免重复点下载就多出一份同名文件。
 */
export function planFor(doc: Document, kinds: DownloadKind[]): TaskPlan[] {
  const plans: TaskPlan[] = [];
  const stem = fileStem(doc);

  if (kinds.includes("article")) {
    // 只对有正文的文档建任务。仅拿到摘要的文档，存下来的就是一句话，
    // 那不叫离线资料，只会让人误以为已经备份好了。
    if (hasBody(doc)) {
      plans.push({ kind: "article", outputPath: `${stem}.md`, bytesTotal: undefined });
    }
  }

  if (kinds.includes("transcript") && doc.kind === "video" && doc.text.length > 0) {
    plans.push({ kind: "transcript", outputPath: `${stem}.txt`, bytesTotal: undefined });
  }

  if (kinds.includes("image") && doc.images.length > 0) {
    plans.push({
      kind: "image",
      outputPath: `${stem}.images`,
      bytesTotal: undefined,
    });
  }

  if (kinds.includes("media") && doc.kind === "video") {
    plans.push({ kind: "media", outputPath: `${stem}.media`, bytesTotal: undefined });
  }

  return plans;
}

/** 已抓到正文（而不是退化成搜索摘要）。 */
export function hasBody(doc: Document): boolean {
  return doc.extractMethod !== "raw" && doc.text.length > 0;
}

/**
 * 文件名主干。
 *
 * 用 id 前缀而不是纯标题：标题会重复（实测同一个视频有十来个不同 URL 版本，
 * 标题一模一样），靠标题命名会互相覆盖。id 是 URL 的 hash，天然唯一且稳定。
 * 标题只作为可读部分保留在后面，并对文件系统不安全字符做替换。
 */
export function fileStem(doc: Document): string {
  const title = (doc.title || "untitled")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    // 标题里常见的连续空白与下划线压成一个，否则文件名会长得离谱
    .replace(/[\s_]+/g, " ")
    .trim()
    .slice(0, 60);
  return `${doc.id.slice(0, 8)}-${title || "untitled"}`;
}

/** 执行一个任务。返回实际写入的字节数。 */
export async function runTask(ctx: RunContext): Promise<number> {
  switch (ctx.plan.kind) {
    case "article":
      return writeArticle(ctx);
    case "transcript":
      return writeTranscript(ctx);
    case "image":
      return downloadImages(ctx);
    case "media":
      return downloadMedia(ctx);
  }
}

// ─────────────────────────── article / transcript ───────────────────────────

/**
 * 正文存成 Markdown。
 *
 * 前面加一段元信息而不是直接把正文倒出来：这份文件脱离本工具之后仍然要能
 * 用 —— 半年后打开它，得知道它是从哪来的、什么时候抓的、原文什么样。
 */
async function writeArticle(ctx: RunContext): Promise<number> {
  const { doc, assetsDir, plan } = ctx;
  const body = doc.markdown?.trim() || doc.text;
  const meta = [
    "---",
    `title: ${JSON.stringify(doc.title)}`,
    `source: ${doc.url}`,
    `site: ${siteLabel(doc.site)}`,
    ...(doc.author ? [`author: ${JSON.stringify(doc.author)}`] : []),
    ...(doc.publishedAt ? [`published: ${JSON.stringify(doc.publishedAt)}`] : []),
    `fetched: ${doc.fetchedAt}`,
    `words: ${doc.wordCount}`,
  ];
  if (doc.error) meta.push(`extractNote: ${JSON.stringify(doc.error)}`);
  meta.push("---");

  const content = `${meta.join("\n")}\n\n# ${doc.title}\n\n${body}\n`;
  return writeAtomic(join(assetsDir, plan.outputPath), content, ctx);
}

async function writeTranscript(ctx: RunContext): Promise<number> {
  const { doc, assetsDir, plan } = ctx;
  const header =
    `# ${doc.title}\n` +
    `# 来源：${doc.url}\n` +
    `# 抓取：${doc.fetchedAt}（${doc.extractMethod}）\n\n`;
  return writeAtomic(join(assetsDir, plan.outputPath), header + doc.text, ctx);
}

/**
 * 原子写。
 *
 * 先写 .part 再改名：中途失败留下的是 .part，而 .part 会被下次运行当作
 * 「要续传的中间态」。如果直接写目标文件，一个写了一半的 .md 看起来和
 * 完整文件没有区别，用户不会发现内容被截断了。
 */
async function writeAtomic(
  dest: string,
  content: string,
  ctx: RunContext,
): Promise<number> {
  await mkdir(dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  await writeFile(tmp, content, "utf8");
  ctx.signal?.throwIfAborted();
  await rename(tmp, dest);
  const bytes = Buffer.byteLength(content, "utf8");
  ctx.onProgress(bytes, bytes);
  return bytes;
}

// ─────────────────────────── image ───────────────────────────

/**
 * 图片批量下载。
 *
 * 单张失败不中断整批：一篇资料往往有十几张图，其中一两张是站点的占位图或
 * 已失效的 CDN 链接，为此把整批判失败、让用户重下全部，代价不对等。
 * 最后返回成功张数写进 task 的 error 字段（若有失败），但状态仍是 done。
 */
async function downloadImages(ctx: RunContext): Promise<number> {
  const { doc, assetsDir, plan } = ctx;
  const dir = join(assetsDir, plan.outputPath);
  await mkdir(dir, { recursive: true });

  const images = doc.images.slice(0, MAX_IMAGES);
  let done = 0;
  let bytes = 0;
  const failed: string[] = [];

  for (const [i, img] of images.entries()) {
    ctx.signal?.throwIfAborted();
    const ext = extFromUrl(img.url) || ".jpg";
    const name = `${String(i + 1).padStart(2, "0")}${ext}`;
    // turbopackIgnore：这里的路径来自运行时的资料标题，打包器的 fs 追踪
    // 静态分析不出来就会把整个项目打进产物。见 next build 的提示。
    const dest = join(/*turbopackIgnore: true*/ dir, name);
    try {
      const n = await withRetry(
        () =>
          downloadToFile(img.url, dest, {
            signal: ctx.signal,
            onProgress: (b) => ctx.onProgress(bytes + b, undefined),
          }),
        ctx.signal,
      );
      bytes += n;
      done++;
    } catch (err) {
      if (ctx.signal?.aborted) throw err;
      failed.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (done === 0) {
    // 一张都没下来就不写标记：这个目录还不是一份可用的产物，重试时要重跑
    throw new Error(
      `全部 ${images.length} 张图片下载失败：${failed[0] ?? "未知原因"}`,
    );
  }
  await writeDoneMarker(dir, { kind: "image", count: done, bytes });
  if (failed.length > 0) {
    // 不抛异常 —— 有成功的就交付。把失败明细留下，让用户自己判断要不要重试。
    ctx.onProgress(bytes, bytes);
    throw new PartialError(
      `${done}/${images.length} 张成功，${failed.length} 张失败`,
      bytes,
    );
  }

  ctx.onProgress(bytes, bytes);
  return bytes;
}

/** 一篇资料最多下多少张图。图片是附属产物，不该让单个任务跑上几分钟。 */
const MAX_IMAGES = 30;

/**
 * 停滞判定：每满一个 60 秒的窗口，若这段时间收到的字节少于 8 KB 就掐断。
 *
 * 为什么判据不是「多少秒没有收到任何字节」（undici 的 bodyTimeout 就是那个
 * 语义）：那样对**涓流**无能为力 —— 每几十秒来几百字节的连接会不断重置计时。
 * 实测有个图片任务以约 275 B/s 的速度爬了 38 分钟，进度条一直转却没有尽头。
 * 所以判据落在吞吐上，而不是间隔上。
 *
 * 8 KB/60s（约 136 B/s）低于任何还能算「在下」的速度，不会误杀慢速但真实的
 * 大文件。掐断后交给 withRetry 重试，已下载的部分由 .part 续传接上。
 */
const STALL_WINDOW_MS = 60_000;
const STALL_MIN_BYTES = 8 * 1024;

/**
 * 目录型产物的完工标记（image / media）。
 *
 * 单文件产物用 .part 表达「下没下完」，目录型产物没有对应的东西：中断留下的是
 * 一个「里面有文件的目录」，只按「有没有文件」判断的话，半截的批次会被当成
 * 已完成 —— 续跑时直接跳过，用户以为下好了，其实少了一半图。
 */
export const DONE_MARKER = ".done";

async function writeDoneMarker(
  dir: string,
  info: Record<string, number | string>,
): Promise<void> {
  await writeFile(
    join(dir, DONE_MARKER),
    JSON.stringify({ ...info, at: new Date().toISOString() }),
    "utf8",
  ).catch(() => {}); // 标记写不进去只影响续跑的判断，不该让已经下好的东西判失败
}

/**
 * 重试几次瞬时故障。
 *
 * 实测走本地代理时约 5% 的图片请求会在建立隧道时握手超时，同一个 URL 紧接着
 * 重试就成功。为一次握手抖动把整张图记成失败，用户重下时才发现它其实能下，
 * 代价不对等。
 *
 * 与断点续传天然配合：上一次已经写进 .part 的字节会被下一次带着 Range 接着下，
 * 重试不会把已下完的部分丢掉。
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  signal: AbortSignal | undefined,
  times = 3,
): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= times; attempt++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      // 取消/暂停要立刻停手，重试是给网络抖动的，不是给用户意图的
      if (signal?.aborted) break;
      if (attempt < times) await sleep(300 * attempt, signal);
    }
  }
  throw last;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * 部分成功。带着已写入的字节数抛出，队列会把它记成 done 并附上说明，
 * 而不是 failed —— 文件确实在那里，标成失败会让用户重复下载。
 */
export class PartialError extends Error {
  readonly bytes: number;
  readonly partial = true;
  constructor(message: string, bytes: number) {
    super(message);
    this.name = "PartialError";
    this.bytes = bytes;
  }
}

// ─────────────────────────── media（yt-dlp）───────────────────────────

/**
 * 视频/音频下载，交给 yt-dlp。
 *
 * 用 `-o` 指定输出模板并让它自己决定扩展名：写死 .mp4 会在目标是纯音频或
 * 需要合并音视频轨时出错，而 yt-dlp 的 `%(ext)s` 就是为这件事设计的。
 *
 * 上限设在 2GB：这是个人调研工具，一个视频动辄几个 G 会占满磁盘，
 * 而超过这个体量的场景（长直播回放）本来也不适合用这种方式留档。
 */
const MEDIA_MAX_BYTES = 2 * 1024 * 1024 * 1024;

async function downloadMedia(ctx: RunContext): Promise<number> {
  const { doc, assetsDir, plan } = ctx;
  const dir = join(assetsDir, plan.outputPath);
  await mkdir(dir, { recursive: true });

  const args = [
    ...ytdlpCommonArgs(),
    // 续传：yt-dlp 会接着 .part 文件下，与 HTTP 那条路的 Range 是同一目的
    "--continue",
    "--progress",
    // 让进度按 \r 之外也换行输出，否则要等一整行更新完才拿得到
    "--newline",
    "--max-filesize",
    String(MEDIA_MAX_BYTES),
    "-o",
    join(dir, "%(title).60s.%(ext)s"),
    "--print",
    "after_move:filepath",
    doc.url,
  ];

  const child = execFile(config.ytdlpPath, args, {
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30 * 60_000,
  });

  const onAbort = () => child.kill("SIGTERM");
  ctx.signal?.addEventListener("abort", onAbort, { once: true });

  let bytes = 0;
  let total: number | undefined;
  let outputPath = "";

  child.stdout?.on("data", (buf: Buffer) => {
    for (const line of buf.toString().split("\n")) {
      const t = parseYtdlpProgress(line);
      if (t) {
        if (t.total) total = t.total;
        if (t.done) bytes = t.done;
        ctx.onProgress(bytes, total);
      }
      // --print after_move:filepath 会把最终路径单独打一行
      if (line.startsWith("/")) outputPath = line.trim();
    }
  });

  try {
    await new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`yt-dlp 退出码 ${code}`));
      });
    });
  } finally {
    ctx.signal?.removeEventListener("abort", onAbort);
  }

  if (ctx.signal?.aborted) throw new Error("已取消");

  // 文件大小以磁盘为准：yt-dlp 报的是下载量，而合并音视频轨之后
  // 实际文件更大，用前者的数字会让用户以为文件不完整
  if (outputPath) {
    try {
      const s = await stat(/*turbopackIgnore: true*/ outputPath);
      bytes = s.size;
    } catch {
      // 拿不到就用解析出来的值
    }
  }

  await writeDoneMarker(dir, { kind: "media", bytes });
  ctx.onProgress(bytes, bytes);
  return bytes;
}

/**
 * 解析 yt-dlp 的进度行。
 *
 * 形如：
 *   [download]  42.3% of   12.34MiB at  1.20MiB/s ETA 00:09
 *   [download] 100% of   12.34MiB in 00:10
 *
 * 只解析百分比和总量，不做更细的推断 —— 输出格式随版本变，多解析一项就多
 * 一个会静默失效的地方。解析不出来就只是没有进度更新，不影响下载本身。
 */
export function parseYtdlpProgress(
  line: string,
): { done?: number; total?: number } | null {
  if (!line.startsWith("[download]")) return null;
  const totalM = line.match(/of\s+~?\s*([\d.]+)(KiB|MiB|GiB|B)/);
  if (!totalM) return null;
  const total = toBytes(Number(totalM[1]), totalM[2]);
  const pctM = line.match(/([\d.]+)%/);
  if (!pctM) return { total };
  return { total, done: Math.round((Number(pctM[1]) / 100) * total) };
}

function toBytes(n: number, unit: string): number {
  const mul =
    unit === "GiB" ? 1024 ** 3
    : unit === "MiB" ? 1024 ** 2
    : unit === "KiB" ? 1024
    : 1;
  return Math.round(n * mul);
}

// ─────────────────────────── HTTP 下载与续传 ───────────────────────────

/**
 * 带续传的文件下载。
 *
 * 断点续传的实现：已存在 .part 文件时带 `Range: bytes=<已下载>-` 重发，
 * 服务端回 206 就接着写，回 200 说明它不支持 Range，那就从头来过（必须先
 * 截断，否则会把新内容追加在旧内容后面，得到一个损坏的文件）。
 */
export async function downloadToFile(
  url: string,
  dest: string,
  opts: {
    signal?: AbortSignal;
    onProgress?: (bytes: number, total?: number) => void;
    headers?: Record<string, string>;
  } = {},
): Promise<number> {
  await mkdir(dirname(dest), { recursive: true });
  const part = `${dest}.part`;

  let have = 0;
  try {
    have = (await stat(part)).size;
  } catch {
    have = 0;
  }

  const headers: Record<string, string> = {
    // 没有 Referer 时 B 站等站点的图床会直接 403
    Referer: originOf(url),
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    ...(have > 0 ? { Range: `bytes=${have}-` } : {}),
    ...opts.headers,
  };

  // 本地控制器：既听外部的取消，也听下面的停滞看门狗。
  // 直接透传 opts.signal 的话，看门狗就没法掐断请求 —— signal 只能由持有者
  // abort。
  const local = new AbortController();
  const onOuterAbort = () => local.abort();
  opts.signal?.addEventListener("abort", onOuterAbort, { once: true });

  let windowStart = Date.now();
  let windowBytes = 0;
  const watchdog = setInterval(() => {
    if (Date.now() - windowStart < STALL_WINDOW_MS) return;
    if (windowBytes < STALL_MIN_BYTES) local.abort();
    windowStart = Date.now();
    windowBytes = 0;
  }, 5_000);

  try {
    const res = await httpFetch(url, {
      headers,
      signal: local.signal,
      redirect: "follow",
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const resumed = res.status === 206;
    if (have > 0 && !resumed) {
      have = 0;
      await unlink(part).catch(() => {});
    }

    const lenHeader = res.headers.get("content-length");
    const total = lenHeader ? have + Number(lenHeader) : undefined;

    if (!res.body) throw new Error("响应没有内容");

    // 从收到响应头开始重新计窗。建连慢（代理握手）和传输慢是两回事，
    // 前者已经由 connectTimeout 管，不该算进吞吐的账上。
    windowStart = Date.now();
    windowBytes = 0;

    let written = have;
    const stream = createWriteStream(part, { flags: resumed ? "a" : "w" });

    const source = Readable.fromWeb(res.body as never);
    source.on("data", (chunk: Buffer) => {
      written += chunk.length;
      windowBytes += chunk.length;
      opts.onProgress?.(written, total);
    });

    try {
      await pipeline(source, stream);
    } catch (err) {
      // 外部没取消，是我们自己掐的 —— 那就是停滞，报清楚原因，
      // 否则用户只看到一句 "The operation was aborted"
      if (!opts.signal?.aborted && local.signal.aborted) {
        throw new Error(
          `速度过低已中断：${STALL_WINDOW_MS / 1000} 秒内不足 ${STALL_MIN_BYTES / 1024} KB`,
        );
      }
      throw err;
    }

    opts.signal?.throwIfAborted();
    await rename(part, dest);
    return written;
  } finally {
    clearInterval(watchdog);
    opts.signal?.removeEventListener("abort", onOuterAbort);
  }
}

/** 取 URL 的 origin，用作 Referer。解析失败时给空串（不设这个头）。 */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/** 从 URL 推断图片扩展名。查表而不是直接用后缀。 */
function extFromUrl(url: string): string | null {
  try {
    const ext = extname(basename(new URL(url).pathname)).toLowerCase();
    return /^\.(jpe?g|png|gif|webp|avif|bmp)$/.test(ext) ? ext : null;
  } catch {
    return null;
  }
}
