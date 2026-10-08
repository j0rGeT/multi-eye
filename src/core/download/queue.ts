/**
 * 异步下载队列。
 *
 * 设计要求来自几条具体的失败场景，不是泛泛的「异步」：
 *
 *  1. **进程重启不能丢掉进度。** dev server 热重载、机器休眠、手滑重启都会
 *     发生在几十个任务跑了一半的时候。所以每个任务状态变化都落盘到
 *     data/sessions/<id>/tasks.json，重启后能接着跑。
 *
 *  2. **已完成的任务不能重下。** 续跑时先看文件在不在 —— 文件在就是完成了，
 *     不管 tasks.json 里写的是什么。文件系统才是真相，状态文件只是缓存。
 *
 *  3. **单个任务失败不能拖垮整批。** 一篇资料的图挂了，其余几十个照跑，
 *     失败原因记在任务上，用户能单独重试。
 *
 *  4. **并发要可控。** 默认 3：再多会同时压几个站点的 CDN，容易触发限流，
 *     反而更慢。
 */

import { EventEmitter } from "node:events";
import { readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pLimit from "p-limit";
import { nanoid } from "nanoid";
import type {
  Document,
  DownloadJob,
  DownloadKind,
  DownloadTask,
  ProgressEvent,
} from "@/core/types";
import { assetsDir, ensureSessionDirs, sessionDir } from "@/core/store";
import { DONE_MARKER, PartialError, planFor, runTask } from "./kinds";

/** 同时在跑的任务数。见文件头第 4 条。 */
export const DEFAULT_CONCURRENCY = 3;
const MAX_CONCURRENCY = 8;

export function clampConcurrency(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n)) return DEFAULT_CONCURRENCY;
  return Math.min(MAX_CONCURRENCY, Math.max(1, Math.round(n)));
}

// ─────────────────────────── 运行时注册表 ───────────────────────────

interface Live {
  job: DownloadJob;
  docById: Map<string, Document>;
  kinds: DownloadKind[];
  emitter: EventEmitter;
  abort: AbortController;
  /** 暂停/取消请求。runner 在每个任务之间检查它。 */
  stop?: "pause" | "cancel";
  running: boolean;
  /** 串行化落盘，避免几个任务同时改同一个文件。 */
  saveChain: Promise<void>;
}

/**
 * 进行中的任务只放在内存里。
 *
 * 刻意不做成多进程共享（那是分布式，本项目明确不做），但同一进程内的
 * 多个 SSE 订阅者共享同一份状态 —— 用户开两个标签页看同一个任务，
 * 两边应该看到一样的进度。
 */
const live = new Map<string, Live>();

export function getLiveJob(jobId: string): DownloadJob | undefined {
  return live.get(jobId)?.job;
}

export function listLiveJobs(sessionId: string): DownloadJob[] {
  return [...live.values()]
    .filter((l) => l.job.sessionId === sessionId)
    .map((l) => l.job);
}

/** 订阅某个任务的事件流。返回退订函数。 */
export function subscribe(jobId: string, fn: (e: ProgressEvent) => void): () => void {
  const l = live.get(jobId);
  if (!l) return () => {};
  l.emitter.on("event", fn);
  return () => l.emitter.off("event", fn);
}

/**
 * 去掉 at 之后的事件类型。
 *
 * 不能直接写 `Omit<ProgressEvent, "at">`：ProgressEvent 是判别联合，
 * Omit 会把它塌缩成所有成员共有字段的交集（只剩 type），于是每个带 job/task
 * 的调用都报错。要先分发到联合的每个成员上再各自 Omit。
 */
type WithoutAt<T> = T extends unknown ? Omit<T, "at"> : never;
type EmittableEvent = WithoutAt<ProgressEvent>;

function emit(l: Live, e: EmittableEvent): void {
  l.emitter.emit("event", { ...e, at: new Date().toISOString() } as ProgressEvent);
}

// ─────────────────────────── 持久化 ───────────────────────────

function jobFile(sessionId: string): string {
  return join(sessionDir(sessionId), "tasks.json");
}

/** 落盘。失败只记不抛：状态文件写不进去，不该让下载本身停下来。 */
function persist(l: Live): void {
  const snapshot = JSON.parse(JSON.stringify(l.job)) as DownloadJob;
  l.saveChain = l.saveChain
    .then(() => writeFile(jobFile(l.job.sessionId), JSON.stringify(snapshot, null, 2), "utf8"))
    .catch(() => {});
}

export async function loadJob(sessionId: string): Promise<DownloadJob | null> {
  try {
    return JSON.parse(await readFile(jobFile(sessionId), "utf8")) as DownloadJob;
  } catch {
    return null;
  }
}

// ─────────────────────────── 建任务 ───────────────────────────

export interface CreateJobInput {
  sessionId: string;
  documents: Document[];
  /** 只下这些文档；省略则全部。 */
  docIds?: string[];
  kinds: DownloadKind[];
  concurrency?: number;
}

/**
 * 把磁盘上的任务重新装进运行时注册表。
 *
 * 这是「进程重启后能续跑」真正落地的地方。tasks.json 里有任务的定义，
 * 运行一个任务还需要两样东西：资料本体（在 session.json 里）和事件总线
 * （只在内存里）。前者重新读，后者重新建。
 *
 * 任务类型从已有任务里反推，而不是让调用方再传一遍 —— 用户点「继续」时
 * 不该需要重新声明上次选了哪些类型。
 */
export function adoptJob(job: DownloadJob, documents: Document[]): DownloadJob {
  const existing = live.get(job.id);
  if (existing) return existing.job;

  const docById = new Map(documents.map((d) => [d.id, d]));
  const kinds = [...new Set(job.tasks.map((t) => t.kind))];

  const l: Live = {
    job,
    docById,
    kinds,
    emitter: new EventEmitter(),
    abort: new AbortController(),
    running: false,
    saveChain: Promise.resolve(),
  };
  l.emitter.setMaxListeners(50);
  live.set(job.id, l);
  return job;
}

/** 运行时是否已经装着这个任务。 */
export function isAdopted(jobId: string): boolean {
  return live.has(jobId);
}

export function createJob(input: CreateJobInput): { job: DownloadJob; live: Live } {
  const concurrency = clampConcurrency(input.concurrency);
  const wanted = input.docIds ? new Set(input.docIds) : null;
  const docs = wanted
    ? input.documents.filter((d) => wanted.has(d.id))
    : input.documents;

  const jobId = nanoid(10);
  const tasks: DownloadTask[] = [];
  const docById = new Map<string, Document>();

  for (const doc of docs) {
    // planFor 只在这篇资料确实有可下载的产物时才返回条目 ——
    // 一条「仅摘要」的文档不会因为用户勾了 article 就凭空产生一个任务
    for (const plan of planFor(doc, input.kinds)) {
      docById.set(doc.id, doc);
      tasks.push({
        id: nanoid(8),
        jobId,
        sessionId: input.sessionId,
        docId: doc.id,
        url: doc.url,
        kind: plan.kind,
        status: "queued",
        bytesDone: 0,
        attempts: 0,
        outputPath: plan.outputPath,
      });
    }
  }

  const now = new Date().toISOString();
  const job: DownloadJob = {
    id: jobId,
    sessionId: input.sessionId,
    status: "queued",
    tasks,
    concurrency,
    createdAt: now,
    updatedAt: now,
  };

  const l: Live = {
    job,
    docById,
    kinds: input.kinds,
    emitter: new EventEmitter(),
    abort: new AbortController(),
    running: false,
    saveChain: Promise.resolve(),
  };
  // 每个 SSE 订阅者一个监听器，几十个任务时很容易超默认的 10 个上限
  l.emitter.setMaxListeners(50);

  live.set(jobId, l);
  return { job, live: l };
}

// ─────────────────────────── 执行 ───────────────────────────

/**
 * 跑一个任务队列。
 *
 * 已完成的任务会被跳过 —— 判据是「产物文件是否存在于磁盘」，而不是
 * tasks.json 里记的状态。理由见文件头第 2 条：状态文件可能因为上次异常
 * 退出而停留在 running，但文件在不在是确定的。
 */
export async function runJob(jobId: string): Promise<void> {
  const l = live.get(jobId);
  if (!l || l.running) return;

  l.running = true;
  l.job.status = "running";
  l.stop = undefined;
  // 必须换一个干净的 AbortController。暂停和取消都是靠 abort() 掐断在跑的任务的，
  // 那个 signal 一旦 abort 就永远保持 aborted —— 沿用它会让「继续」之后每个
  // 任务一进去就被判成已取消，整批瞬间全灭。
  l.abort = new AbortController();
  emit(l, { type: "job", job: l.job });

  await ensureSessionDirs(l.job.sessionId);
  const dir = assetsDir(l.job.sessionId);
  const limit = pLimit(l.job.concurrency);

  const pending = l.job.tasks.filter(
    (t) => t.status === "queued" || t.status === "running" || t.status === "paused",
  );

  await Promise.all(
    pending.map((task) =>
      limit(async () => {
        if (l.stop === "cancel") {
          finish(l, task, "canceled");
          return;
        }
        // 暂停：留在 paused，等 resume
        if (l.stop === "pause") {
          task.status = "paused";
          emit(l, { type: "task", task });
          persist(l);
          return;
        }
        await runOne(l, task, dir);
      }),
    ),
  );

  l.running = false;
  l.job.updatedAt = new Date().toISOString();

  if (l.stop === "pause") l.job.status = "paused";
  else if (l.stop === "cancel") l.job.status = "canceled";
  else l.job.status = jobOutcome(l.job);

  persist(l);
  emit(l, { type: "job", job: l.job });
  // 保留在注册表里，好让刷新页面后的 GET 还能读到这份快照
}

async function runOne(l: Live, task: DownloadTask, dir: string): Promise<void> {
  const doc = l.docById.get(task.docId);
  if (!doc) {
    finish(l, task, "failed", "会话里找不到这篇资料");
    return;
  }

  // 暂停态重启时，产物已经在磁盘上的任务不必重下
  if (await artifactExists(dir, task)) {
    // 磁盘上有东西但状态不是 done：上次写完没来得及记状态。以磁盘为准。
    task.status = "done";
    task.bytesDone = (await sizeOf(dir, task)) ?? task.bytesDone;
    task.bytesTotal = task.bytesDone;
    finish(l, task, "done");
    return;
  }

  task.status = "running";
  task.startedAt = new Date().toISOString();
  task.attempts++;
  emit(l, { type: "task", task });
  persist(l);

  try {
    const bytes = await runTask({
      assetsDir: dir,
      doc,
      plan: {
        kind: task.kind,
        outputPath: task.outputPath ?? "",
      },
      signal: l.abort.signal,
      onProgress: (done, total) => {
        task.bytesDone = done;
        if (total !== undefined) task.bytesTotal = total;
        // 进度不落盘：几十个任务每秒几十次写 JSON 会明显拖慢整体，
        // 而进度是易失信息，丢了下次跑一遍就有
        emit(l, { type: "task", task });
      },
    });
    task.bytesDone = bytes;
    finish(l, task, "done");
  } catch (err) {
    // 被中断的任务要看是哪种中断。暂停说是 canceled 会让用户以为这批不下了 ——
    // 而它下一步就是被「继续」捡回来重跑。两者的区别只在对人怎么讲。
    if (l.stop === "pause") {
      finish(l, task, "paused");
      return;
    }
    if (l.abort.signal.aborted || l.stop === "cancel") {
      finish(l, task, "canceled");
      return;
    }
    // 部分成功：文件确实落盘了，标成失败会让用户重复下载
    if (err instanceof PartialError) {
      task.bytesDone = err.bytes;
      finish(l, task, "done", err.message);
      return;
    }
    finish(l, task, "failed", err instanceof Error ? err.message : String(err));
  }
}

function finish(
  l: Live,
  task: DownloadTask,
  status: DownloadTask["status"],
  error?: string,
): void {
  task.status = status;
  task.error = error;
  if (status === "done" || status === "failed" || status === "canceled") {
    task.finishedAt = new Date().toISOString();
  }
  emit(l, { type: "task", task });
  persist(l);
}

/**
 * 产物是否已经在磁盘上。
 *
 * image / media 的 outputPath 是目录，判据是**完工标记**而不是「目录里有文件」：
 * 中断留下的是一个「里面有文件的目录」，按后者判断会把半截的批次当成已完成，
 * 续跑时直接跳过。标记的含义见 kinds.ts 的 DONE_MARKER。
 */
async function artifactExists(dir: string, task: DownloadTask): Promise<boolean> {
  if (!task.outputPath) return false;
  const p = join(dir, task.outputPath);
  try {
    const s = await stat(p);
    if (s.isFile()) return s.size > 0;
    if (s.isDirectory()) {
      await stat(join(p, DONE_MARKER));
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

async function sizeOf(dir: string, task: DownloadTask): Promise<number | undefined> {
  if (!task.outputPath) return undefined;
  try {
    const s = await stat(join(dir, task.outputPath));
    return s.isFile() ? s.size : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 整批的最终状态。
 *
 * 有成功也有失败时报 partial 而不是 failed —— 「71 篇里 3 篇没下来」和
 * 「一篇都没下来」是两件完全不同的事，用同一个词表示会让人误判要不要重试。
 */
function jobOutcome(job: DownloadJob): DownloadJob["status"] {
  const done = job.tasks.filter((t) => t.status === "done").length;
  const failed = job.tasks.filter((t) => t.status === "failed").length;
  if (failed === 0) return "done";
  if (done === 0) return "failed";
  return "partial";
}

// ─────────────────────────── 控制 ───────────────────────────

export function pauseJob(jobId: string): boolean {
  const l = live.get(jobId);
  if (!l || !l.running) return false;
  l.stop = "pause";
  l.abort.abort();
  return true;
}

export function cancelJob(jobId: string): boolean {
  const l = live.get(jobId);
  if (!l) return false;
  l.stop = "cancel";
  l.abort.abort();
  l.job.tasks.forEach((t) => {
    if (t.status === "queued") t.status = "canceled";
  });
  return true;
}

/**
 * 把任务恢复成可重跑的队列。
 *
 * 失败的、暂停的、以及上次被杀掉的 running 都会被重置回 queued；
 * 已完成的保持不动（执行时会再按磁盘确认一遍）。
 */
export function resetForRetry(job: DownloadJob, onlyFailed = false): number {
  let n = 0;
  for (const t of job.tasks) {
    const should =
      t.status === "running" ||
      t.status === "paused" ||
      (onlyFailed ? t.status === "failed" : t.status === "failed" || t.status === "canceled");
    if (!should) continue;
    t.status = "queued";
    t.error = undefined;
    t.startedAt = undefined;
    t.finishedAt = undefined;
    n++;
  }
  return n;
}

/** 清理会话目录下的下载残留（.part）。用户主动清理时调用。 */
export async function purgePartFiles(sessionId: string): Promise<number> {
  let removed = 0;
  await walk(assetsDir(sessionId), async (p) => {
    if (!p.endsWith(".part")) return;
    await unlink(p).catch(() => {});
    removed++;
  });
  return removed;
}

async function walk(dir: string, fn: (p: string) => Promise<void>): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // 目录不存在就是没有残留
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, fn);
    else await fn(p);
  }
}
