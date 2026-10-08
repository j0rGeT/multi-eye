"use client";

/**
 * 资料下载面板。
 *
 * 后端的队列是「建任务立刻返回、进度走 SSE」的形态，面板必须配合这一点：
 * 点下载之后不能等 POST 返回才显示进度（那可能要等半小时），而是拿到任务
 * 快照就立刻订阅它的流。
 *
 * 另一个必须处理的形态是**上次没跑完的任务**。tasks.json 会让一个被杀掉的
 * 任务永远停在 running，光看状态字段分不出「在跑」和「上次死了」。所以
 * 服务端额外给了 live 标记（见 ProgressEvent 的注释），面板据此把这种任务
 * 显示成「上次中断」，并把按钮换成「继续」而不是「暂停」。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Document,
  DownloadJob,
  DownloadKind,
  DownloadTask,
  ProgressEvent,
  TaskStatus,
} from "@/core/types";
import { getSse } from "@/components/postSse";

interface Props {
  sessionId: string | null;
  documents: Document[];
}

const KIND_LABEL: Record<DownloadKind, string> = {
  article: "正文",
  transcript: "字幕",
  image: "配图",
  media: "视频",
};

const KIND_HINT: Record<DownloadKind, string> = {
  article: "已抓到正文的资料存成 Markdown",
  transcript: "视频的字幕/口播稿存成纯文本",
  image: "正文配图打包进同名目录",
  media: "整段视频，交给 yt-dlp，最慢也最占空间",
};

const ALL_KINDS: DownloadKind[] = ["article", "transcript", "image", "media"];

/** 列表最多渲染多少行。几百个任务全画出来会明显卡顿，也没人看得过来。 */
const MAX_ROWS = 200;

export default function DownloadPanel({ sessionId, documents }: Props) {
  const [kinds, setKinds] = useState<DownloadKind[]>(["article", "transcript"]);
  const [concurrency, setConcurrency] = useState(3);
  const [job, setJob] = useState<DownloadJob | null>(null);
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "active" | "failed">("all");

  const streamRef = useRef<AbortController | null>(null);

  const closeStream = useCallback(() => {
    streamRef.current?.abort();
    streamRef.current = null;
  }, []);

  const openStream = useCallback(
    (sid: string, jobId: string) => {
      closeStream();
      const ac = new AbortController();
      streamRef.current = ac;

      const qs = `sessionId=${encodeURIComponent(sid)}&jobId=${encodeURIComponent(jobId)}&stream=1`;
      getSse<ProgressEvent>(
        `/api/download?${qs}`,
        (e) => {
          switch (e.type) {
            case "snapshot":
              setJob(e.job);
              setLive(e.live);
              // live=false 说明任务死在上次进程里，后面不会再有事件
              if (!e.live || isSettled(e.job.status)) closeStream();
              break;
            case "job":
              setJob(e.job);
              if (isSettled(e.job.status)) closeStream();
              break;
            case "task":
              // 只换这一条：整份 tasks 重渲染会让几十行同时闪一下
              setJob((prev) =>
                prev
                  ? {
                      ...prev,
                      tasks: prev.tasks.map((t) =>
                        t.id === e.task.id ? e.task : t,
                      ),
                    }
                  : prev,
              );
              break;
            case "error":
              setError(e.message);
              closeStream();
              break;
          }
        },
        ac.signal,
      )
        .catch((err) => {
          // abort 是正常的收流方式，不是错误
          if (!ac.signal.aborted) setError(errText(err));
        })
        .finally(() => {
          if (streamRef.current === ac) streamRef.current = null;
        });
    },
    [closeStream],
  );

  // 换会话就换一批任务。之前的任务属于别的主题，留着只会误导。
  useEffect(() => {
    closeStream();
    setJob(null);
    setLive(false);
    setError(null);
    setNotice(null);
    setFilter("all");
    if (!sessionId) return;

    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/download?sessionId=${encodeURIComponent(sessionId)}`,
        );
        if (!res.ok) return; // 404 = 这个会话还没下过东西
        const data = (await res.json()) as {
          job: DownloadJob | null;
          live: boolean;
        };
        if (cancelled || !data.job) return;
        setJob(data.job);
        setLive(data.live);
        // 接着上次没跑完的看 —— 刷新页面不该丢掉正在进行中的任务
        if (data.live && !isSettled(data.job.status)) {
          openStream(sessionId, data.job.id);
        }
      } catch {
        // 读不到历史任务不是错误，当作「还没下过」处理
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sessionId, openStream, closeStream]);

  useEffect(() => closeStream, [closeStream]);

  /** 每类产物实际能建出多少任务。 */
  const counts = useMemo(() => countAvailable(documents), [documents]);

  const stats = useMemo(() => summarize(job), [job]);

  const toggleKind = useCallback((k: DownloadKind) => {
    setKinds((prev) =>
      prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k],
    );
  }, []);

  const act = useCallback(
    async (action: "start" | "resume" | "retry" | "pause" | "cancel") => {
      if (!sessionId || busy) return;
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const body: Record<string, unknown> = { sessionId, action };
        if (action === "start") {
          body.kinds = kinds;
          body.concurrency = concurrency;
        } else {
          if (!job) return;
          body.jobId = job.id;
        }

        const res = await fetch("/api/download", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = (await res.json()) as {
          job?: DownloadJob;
          error?: string;
          note?: string;
          resumed?: number;
        };

        if (!res.ok) {
          // 409 在这里是「没有可下的东西」，属于状态而不是故障，
          // 但仍然要原样说出来，否则用户不知道为什么点了没反应
          setError(data.error ?? `HTTP ${res.status}`);
          return;
        }

        if (data.note) setNotice(data.note);
        if (!data.job) return;
        setJob(data.job);

        if (action === "pause" || action === "cancel") {
          // 这两个动作之后不会再有事件，主动收流，免得连着等待心跳
          setLive(false);
          closeStream();
          return;
        }
        if (isSettled(data.job.status)) {
          setLive(false);
          return;
        }
        openStream(sessionId, data.job.id);
      } catch (err) {
        setError(errText(err));
      } finally {
        setBusy(false);
      }
    },
    [sessionId, busy, kinds, concurrency, job, openStream, closeStream],
  );

  if (!sessionId) {
    return (
      <div className="panel" style={{ padding: 14 }}>
        <h2>资料下载</h2>
        <p className="dim" style={{ fontSize: 12, margin: 0 }}>
          先搜索一个主题，抓到的资料可以在这里离线留存到本地。
        </p>
      </div>
    );
  }

  const selectable = ALL_KINDS.reduce((n, k) => n + counts[k], 0);
  const running = job?.status === "running" && live;
  const stale = job?.status === "running" && !live;

  const rows = job
    ? job.tasks.filter((t) => {
        if (filter === "active") {
          return t.status === "running" || t.status === "queued";
        }
        if (filter === "failed") return t.status === "failed";
        return true;
      })
    : [];
  const shown = rows.slice(0, MAX_ROWS);
  const titleOf = titleMap(documents);

  return (
    <div className="panel" style={{ padding: 14 }}>
      <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>
        资料下载
        {job && (
          <span className={`badge ${statusBadge(job.status, live)}`}>
            {statusLabel(job.status, live)}
          </span>
        )}
      </h2>

      {/* ── 选项 ── */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {ALL_KINDS.map((k) => {
          const n = counts[k];
          return (
            <label
              key={k}
              title={KIND_HINT[k]}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 12,
                opacity: n === 0 ? 0.45 : 1,
                cursor: n === 0 ? "not-allowed" : "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={kinds.includes(k)}
                disabled={n === 0}
                onChange={() => toggleKind(k)}
                style={{ margin: 0 }}
              />
              <span style={{ minWidth: 32 }}>{KIND_LABEL[k]}</span>
              <span className="dim">{n} 篇可下</span>
            </label>
          );
        })}

        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 12,
            marginTop: 2,
          }}
          title="并发太高会同时压几个站点的 CDN，容易触发限流，反而更慢"
        >
          <span style={{ minWidth: 32 }}>并发</span>
          <select
            className="input"
            value={concurrency}
            onChange={(e) => setConcurrency(Number(e.target.value))}
            style={{ padding: "2px 6px", fontSize: 12, width: 64 }}
          >
            {[1, 2, 3, 4, 6, 8].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <span className="dim">同时下载数</span>
        </label>
      </div>

      {/* ── 按钮 ── */}
      <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
        <button
          className="btn btn-primary"
          style={{ fontSize: 12 }}
          disabled={busy || running || kinds.length === 0 || selectable === 0}
          onClick={() => act("start")}
          title={
            job
              ? "已经下过的文件会被跳过，只补缺的"
              : "把这批资料存到 data/sessions/<id>/assets/"
          }
        >
          开始下载
        </button>

        {running && (
          <>
            <button
              className="btn"
              style={{ fontSize: 12 }}
              disabled={busy}
              onClick={() => act("pause")}
            >
              暂停
            </button>
            <button
              className="btn"
              style={{ fontSize: 12 }}
              disabled={busy}
              onClick={() => act("cancel")}
            >
              取消
            </button>
          </>
        )}

        {job && !running && (stats.remaining > 0 || stale || stats.canceled > 0) && (
          <button
            className="btn"
            style={{ fontSize: 12 }}
            disabled={busy}
            onClick={() => act("resume")}
            title="接着跑没做完的，已经在磁盘上的不会重下"
          >
            {stale ? "继续（上次中断）" : "继续"}
          </button>
        )}

        {stats.failed > 0 && (
          <button
            className="btn"
            style={{ fontSize: 12 }}
            disabled={busy}
            onClick={() => act("retry")}
          >
            重试失败 {stats.failed}
          </button>
        )}
      </div>

      {/* ── 总体进度 ── */}
      {job && (
        <div style={{ marginTop: 12 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: 11,
              marginBottom: 4,
            }}
          >
            <span className="muted">
              {stats.done}/{stats.total} 完成
              {stats.failed > 0 && (
                <span style={{ color: "var(--err)" }}> · {stats.failed} 失败</span>
              )}
            </span>
            <span className="dim mono">{formatBytes(stats.bytes)}</span>
          </div>
          <div className="bar">
            <div
              className="bar-fill"
              style={{
                width: `${stats.total ? (stats.done / stats.total) * 100 : 0}%`,
              }}
            />
            {stats.failed > 0 && (
              <div
                className="bar-fill bar-fill-err"
                style={{
                  width: `${(stats.failed / stats.total) * 100}%`,
                  left: `${(stats.done / stats.total) * 100}%`,
                }}
              />
            )}
          </div>

          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            {(
              [
                ["all", "全部"],
                ["active", "进行中"],
                ["failed", "失败"],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                className="btn"
                style={{
                  fontSize: 11,
                  padding: "1px 8px",
                  borderColor: filter === k ? "var(--accent-dim)" : undefined,
                  color: filter === k ? "var(--accent)" : undefined,
                }}
                onClick={() => setFilter(k)}
              >
                {label}
                {k === "failed" && stats.failed > 0 ? ` ${stats.failed}` : ""}
              </button>
            ))}
          </div>

          <div className="tasklist">
            {shown.length === 0 && (
              <p className="dim" style={{ fontSize: 11, margin: 0 }}>
                {filter === "all" ? "还没有任务" : "没有符合条件的任务"}
              </p>
            )}
            {shown.map((t) => (
              <TaskRow key={t.id} task={t} title={titleOf.get(t.docId)} />
            ))}
            {rows.length > shown.length && (
              <p className="dim" style={{ fontSize: 11, margin: "4px 0 0" }}>
                还有 {rows.length - shown.length} 条未显示
              </p>
            )}
          </div>

          <p className="dim" style={{ fontSize: 11, margin: "8px 0 0" }}>
            落盘位置：
            <span className="mono">data/sessions/{sessionId}/assets/</span>
          </p>
        </div>
      )}

      {notice && (
        <p className="muted" style={{ fontSize: 11, margin: "8px 0 0" }}>
          {notice}
        </p>
      )}
      {error && (
        <p style={{ fontSize: 11, margin: "8px 0 0", color: "var(--err)" }}>
          {error}
        </p>
      )}

      <p className="dim" style={{ fontSize: 11, margin: "10px 0 0" }}>
        只有抓到正文的资料会产生文件，仅摘要的不会。部分站点的「正文」可能夹带
        页面推荐位，留存后建议自行核对。
      </p>
    </div>
  );
}

// ─────────────────────────── 子组件 ───────────────────────────

function TaskRow({ task, title }: { task: DownloadTask; title?: string }) {
  const pct =
    task.bytesTotal && task.bytesTotal > 0
      ? Math.min(100, (task.bytesDone / task.bytesTotal) * 100)
      : null;

  return (
    <div className="taskrow">
      <span className={`dot ${statusDot(task.status)}`} />
      <span className="taskrow-main">
        <span className="taskrow-title" title={task.error || task.url}>
          {title ?? shortUrl(task.url)}
        </span>
        <span className="taskrow-meta">
          {KIND_LABEL[task.kind]}
          {task.status === "done" && task.bytesDone > 0 && (
            <> · {formatBytes(task.bytesDone)}</>
          )}
          {task.attempts > 1 && <> · 第 {task.attempts} 次</>}
          {task.status === "failed" && task.error && (
            <span style={{ color: "var(--err)" }}> · {truncate(task.error, 60)}</span>
          )}
          {/* 图片批量下载是「部分成功」：文件在，但有一两张没下来 */}
          {task.status === "done" && task.error && (
            <span className="dim"> · {truncate(task.error, 60)}</span>
          )}
        </span>
        {task.status === "running" && (
          <span className="taskrow-bar">
            <span
              className={pct === null ? "bar-indet" : "bar-fill"}
              style={pct === null ? undefined : { width: `${pct}%` }}
            />
          </span>
        )}
      </span>
    </div>
  );
}

// ─────────────────────────── 纯函数 ───────────────────────────

/**
 * 各类产物实际能建出多少个任务。
 *
 * 这是 `src/core/download/kinds.ts` 里 planFor 的客户端镜像。不能直接引用
 * 那个模块 —— 它 import 了 node:child_process，进不了浏览器包。两边判据
 * 必须保持一致，改了其中一边要同步改另一边。
 */
function countAvailable(docs: Document[]): Record<DownloadKind, number> {
  return {
    article: docs.filter((d) => d.extractMethod !== "raw" && d.text.length > 0)
      .length,
    transcript: docs.filter((d) => d.kind === "video" && d.text.length > 0).length,
    image: docs.filter((d) => d.images.length > 0).length,
    media: docs.filter((d) => d.kind === "video").length,
  };
}

function summarize(job: DownloadJob | null) {
  const tasks = job?.tasks ?? [];
  const n = (s: TaskStatus) => tasks.filter((t) => t.status === s).length;
  const done = n("done");
  const failed = n("failed");
  const canceled = n("canceled");
  const queued = n("queued");
  const paused = n("paused");
  return {
    total: tasks.length,
    done,
    failed,
    canceled,
    queued,
    paused,
    // 重跑时还会被捡起来的：队列里的 + 暂停的 + 取消的 + 上次被杀掉的
    remaining: queued + paused + (job?.status === "running" ? n("running") : 0),
    bytes: tasks.reduce((sum, t) => sum + (t.bytesDone || 0), 0),
  };
}

/**
 * 任务是否已经不会再产生事件。
 *
 * paused 也算：暂停之后跑批的循环就退出了，只有用户再点继续才会有新事件。
 * （它不在服务端的 isTerminal 里 —— 那一边的判据是「这批活儿有结论了吗」。）
 */
function isSettled(status: DownloadJob["status"]): boolean {
  return (
    status === "done" ||
    status === "failed" ||
    status === "canceled" ||
    status === "partial" ||
    status === "paused"
  );
}

function statusLabel(status: DownloadJob["status"], live: boolean): string {
  if (status === "running" && !live) return "已中断";
  return (
    {
      queued: "排队中",
      running: "下载中",
      paused: "已暂停",
      done: "已完成",
      partial: "部分完成",
      failed: "全部失败",
      canceled: "已取消",
    } satisfies Record<DownloadJob["status"], string>
  )[status];
}

function statusBadge(status: DownloadJob["status"], live: boolean): string {
  if (status === "running" && !live) return "badge-warn";
  if (status === "done") return "badge-ok";
  if (status === "partial") return "badge-warn";
  if (status === "failed") return "badge-err";
  return "";
}

function statusDot(status: TaskStatus): string {
  return (
    {
      queued: "",
      running: "",
      paused: "",
      done: "dot-ok",
      failed: "dot-err",
      canceled: "dot-dim",
    } satisfies Record<TaskStatus, string>
  )[status];
}

function titleMap(docs: Document[]): Map<string, string> {
  return new Map(docs.map((d) => [d.id, d.title || shortUrl(d.url)]));
}

function shortUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function formatBytes(n: number): string {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
