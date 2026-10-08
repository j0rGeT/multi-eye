import type { NextRequest } from "next/server";
import type { DownloadJob, DownloadKind, ProgressEvent } from "@/core/types";
import { loadSession } from "@/core/store";
import {
  adoptJob,
  cancelJob,
  clampConcurrency,
  createJob,
  getLiveJob,
  isAdopted,
  loadJob,
  pauseJob,
  resetForRetry,
  runJob,
  subscribe,
} from "@/core/download/queue";

// 不导出 runtime：Next 16 里 'nodejs' 已是默认值（Edge 废弃），文档要求移除该导出。
export const dynamic = "force-dynamic";
export const maxDuration = 800;

/**
 * 下载任务的建立与控制。
 *
 * 为什么建任务与看进度分成两个接口：一批几十个任务、含视频时可能跑半小时。
 * 把 POST 一直挂着等它跑完，中间任何一个代理超时都会让客户端以为任务失败，
 * 而服务端其实还在跑。所以 POST 立即返回任务快照，进度走 GET 的 SSE。
 */

interface DownloadBody {
  sessionId?: string;
  /** 只下这些资料；省略则下全部。 */
  docIds?: string[];
  /** 省略则只要正文。 */
  kinds?: DownloadKind[];
  concurrency?: number;
  action?: "start" | "resume" | "retry" | "pause" | "cancel";
  /** pause/cancel/resume 时指定目标任务。 */
  jobId?: string;
}

const DEFAULT_KINDS: DownloadKind[] = ["article"];
const ALL_KINDS: DownloadKind[] = ["article", "transcript", "image", "media"];

export async function POST(req: NextRequest) {
  let body: DownloadBody;
  try {
    body = (await req.json()) as DownloadBody;
  } catch {
    return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const sessionId = body.sessionId?.trim();
  if (!sessionId) {
    return Response.json({ error: "缺少 sessionId" }, { status: 400 });
  }

  const action = body.action ?? "start";

  // ── 控制类动作：不需要会话正文，只需要找到任务 ──
  if (action === "pause" || action === "cancel") {
    const job = body.jobId ? getLiveJob(body.jobId) : undefined;
    if (!job) {
      return Response.json({ error: "该任务不在运行中" }, { status: 404 });
    }
    const ok = action === "pause" ? pauseJob(job.id) : cancelJob(job.id);
    return Response.json({
      ok,
      job: getLiveJob(job.id) ?? job,
      note: ok ? undefined : "任务已经不在运行状态",
    });
  }

  const session = await loadSession(sessionId);
  if (!session) {
    return Response.json({ error: `会话不存在：${sessionId}` }, { status: 404 });
  }

  if (session.documents.length === 0) {
    return Response.json(
      { error: "该会话还没有抓取任何资料，没有可下载的内容" },
      { status: 409 },
    );
  }

  // ── resume / retry：复用已有任务，只把要重跑的重置回队列 ──
  if (action === "resume" || action === "retry") {
    const existing = body.jobId ? getLiveJob(body.jobId) : undefined;
    if (existing && existing.status === "running") {
      return Response.json({ job: existing, note: "任务已在运行中" });
    }

    // 内存里没有就尝试从磁盘恢复 —— 这正是「进程重启后能续跑」的入口
    const job = existing ?? (await loadJob(sessionId));
    if (!job) {
      return Response.json(
        { error: "没有可恢复的任务，请先建立下载" },
        { status: 404 },
      );
    }

    // 来自上一次进程的任务需要先装回运行时（重建事件总线与资料索引），
    // 否则它跑不起来也推不了进度
    if (!existing) adoptJob(job, session.documents);

    const n = resetForRetry(job, action === "retry");
    if (n === 0) {
      return Response.json({
        job: getLiveJob(job.id) ?? job,
        note: action === "retry" ? "没有失败的任务" : "没有需要继续的任务",
      });
    }

    void runJob(job.id).catch(() => {});
    return Response.json({ job: getLiveJob(job.id) ?? job, resumed: n });
  }

  // ── start ──
  const kinds = (body.kinds?.length ? body.kinds : DEFAULT_KINDS).filter((k) =>
    ALL_KINDS.includes(k),
  );
  if (kinds.length === 0) {
    return Response.json({ error: "没有可识别的下载类型" }, { status: 400 });
  }

  const { job } = createJob({
    sessionId,
    documents: session.documents,
    docIds: body.docIds,
    kinds,
    concurrency: clampConcurrency(body.concurrency),
  });

  if (job.tasks.length === 0) {
    return Response.json(
      {
        error:
          "选中的资料没有任何可下载的产物。只有拿到正文的资料才能存成文件 —— 仅摘要的资料不产生文件。",
      },
      { status: 409 },
    );
  }

  // 不 await：一批任务可能跑半小时，路由要立刻把任务快照交出去
  void runJob(job.id).catch(() => {});

  return Response.json({ job });
}

/**
 * 读取任务状态。
 *
 *   ?sessionId=X            返回该会话最近一个任务的快照
 *   ?sessionId=X&jobId=Y    指定任务
 *   ?sessionId=X&stream=1   SSE 推送进度，任务进入终态后自动关闭
 *
 * stream 模式会先推一次 snapshot 再推增量：客户端可能在任务跑了一半才连上，
 * 只有增量的话它会缺掉之前的全部状态。
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const sessionId = params.get("sessionId")?.trim();
  if (!sessionId) {
    return Response.json({ error: "缺少 sessionId" }, { status: 400 });
  }

  const jobId = params.get("jobId")?.trim();
  const job = jobId
    ? getLiveJob(jobId) ?? (await loadJob(sessionId))
    : (await loadJob(sessionId));

  // live 区分「在跑」和「磁盘上留下的 last-known state」。见 ProgressEvent 的注释。
  const live = job ? isAdopted(job.id) : false;

  if (params.get("stream") !== "1") {
    return Response.json({ job, live }, { headers: { "Cache-Control": "no-store" } });
  }

  if (!job) {
    return Response.json({ error: "该会话还没有下载任务" }, { status: 404 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (e: ProgressEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          closed = true; // 客户端已经走了
        }
      };

      const initial: ProgressEvent = {
        type: "snapshot",
        job,
        live,
        at: new Date().toISOString(),
      };
      send(initial);

      // 死任务（进程重启留下的）和终态任务都没有后续事件可推，
      // 挂着一个只有心跳的空流会让前端一直显示「下载中」
      if (isTerminal(job.status) || !live) {
        controller.close();
        return;
      }

      const unsubscribe = subscribe(job.id, (e) => {
        send(e);
        if (e.type === "job" && isTerminal(e.job.status)) {
          cleanup();
          controller.close();
        }
      });

      // 心跳。中间的代理会在连接空闲约 60 秒后掐断，而一批视频下载里
      // 两次事件之间超过一分钟是常事。
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          cleanup();
        }
      }, 15_000);

      function cleanup() {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
      }

      req.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // 已经关了
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      // 有些反向代理会缓冲响应，那样 SSE 就变成一次性吐出了
      "X-Accel-Buffering": "no",
    },
  });
}

function isTerminal(status: DownloadJob["status"]): boolean {
  return (
    status === "done" ||
    status === "failed" ||
    status === "canceled" ||
    status === "partial"
  );
}
