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
import { BODY_GRADE_LABELS, bodyGrade, qualitySummary } from "@/core/quality";
import { docKind } from "@/core/kind";

interface Props {
  sessionId: string | null;
  documents: Document[];
  /**
   * 重新抓这几条结果（传的是 `SearchResult.id`，与 `Document.id` 同值）。
   *
   * 服务端对显式给出的 `resultIds` **原样尊重**，不再做相关性筛选 —— 这是
   * 「只重抓失败和低质的」和「手动勾选几条疑似跑题的补抓」共用的那条恢复路径。
   */
  onRefetch?: (resultIds: string[]) => void;
  /** 抓取是否在进行中。用于禁用按钮 —— 抓取与抓取不能并发。 */
  refetching?: boolean;
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

export default function DownloadPanel({
  sessionId,
  documents,
  onRefetch,
  refetching = false,
}: Props) {
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
          // 先就地改状态。服务端要等在跑的任务收手之后才推出最终状态，那是
          // 几秒之后的事；这几秒里按钮该显示「已暂停」而不是「已中断」。
          // 流不收：权威的终态由服务端的 job 事件推过来（paused/canceled 都
          // 在我们的收流判据里，事件到了会自己关）。
          const next = action === "pause" ? "paused" : "canceled";
          setJob((prev) => (prev ? { ...prev, status: next } : prev));
          if (!streamRef.current) setLive(false);
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

      {/*
        质量分布 + 打包入口。

        放在「选项」**上面**是刻意的：用户得在勾选之前就知道这一批里到底
        有多少篇是完整正文 —— 否则等下载完才发现包很小，那已经晚了。
        计数用的是 `qualitySummary`，与服务端打包的判据同源（同一份
        `quality.ts`），所以这里的数字和 ZIP 里的文件数必然一致。
      */}
      <QualityLine documents={documents} />
      <PackButton sessionId={sessionId} documents={documents} />
      <RefetchButton documents={documents} onRefetch={onRefetch} busy={refetching} />

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

      {/* 勾了类型却没有可下的东西。不解释的话，用户只会看到按钮是灰的 */}
      {selectable === 0 && (
        <p className="muted" style={{ fontSize: 11, margin: "8px 0 0" }}>
          这批资料没有可下载的产物 —— 一篇都没抓到正文。回到上面重新抓取，或换一批资料。
        </p>
      )}

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

/**
 * 这一批资料的质量分布。
 *
 * 只讲「我们拿到了多少正文」，不讲「内容好不好」—— 后者这个工具给不出，
 * 硬给一个分数就是伪精度（见 `quality.ts` 模块头注释）。文案必须把这条
 * 边界说清楚，否则「优质」会被读成「可信」。
 */
function QualityLine({ documents }: { documents: Document[] }) {
  const q = useMemo(() => qualitySummary(documents), [documents]);
  if (q.total === 0) return null;

  const pct = Math.round((q.packable / q.total) * 100);

  return (
    <div
      style={{
        fontSize: 12,
        margin: "0 0 10px",
        padding: "8px 10px",
        background: "var(--bg)",
        border: "1px solid var(--border-subtle)",
        borderRadius: 6,
      }}
    >
      <div>
        <strong>优质 {q.packable} 篇</strong>
        <span className="dim">
          （占 {pct}%） · {BODY_GRADE_LABELS.thin} {q.counts.thin} 篇 ·{" "}
          {BODY_GRADE_LABELS.snippet} {q.counts.snippet} 篇 · 共 {q.total} 篇
        </span>
      </div>
      {/*
        正文完整、只是跑题的那几篇单独说一句。

        不说的话，用户会看到「正文完整 16 篇、优质 14 篇」这种对不上的数 ——
        然后去怀疑抓取坏了。这几篇的正文其实好好的，是判定结果，不是故障。
      */}
      {q.excludedIrrelevant > 0 && (
        <div className="dim" style={{ fontSize: 11, marginTop: 4 }}>
          另有 {q.excludedIrrelevant} 篇正文完整、但疑似与主题不相关，因此没进包
          —— 它们不是抓取失败，原因逐条写在包内「未收录.md」里。
        </div>
      )}
      <div className="dim" style={{ fontSize: 11, marginTop: 4 }}>
        优质 = 正文 ≥300 字、抓取无错，且未被判为疑似跑题。这只说明**拿到了正文、
        也像是你要找的东西**，不说明内容对不对 —— 本工具不做事实核查。没进包的资料
        不会被丢弃，会逐条列在包内的「未收录.md」里。
      </div>
    </div>
  );
}

/**
 * 打包下载。
 *
 * 用普通 `<a href>` 而不是 fetch + Blob：这个路由带了 `Content-Disposition`，
 * 浏览器自己就会弹保存框。走 fetch 反而要把几十 MB 在内存里绕一圈，
 * 而且失败时（409/413）拿到的是一个 JSON，用户看到的会是一个白页。
 * 沿用导出报告（`page.tsx`）已经验证过的那条路。
 */
function PackButton({
  sessionId,
  documents,
}: {
  sessionId: string | null;
  documents: Document[];
}) {
  const q = useMemo(() => qualitySummary(documents), [documents]);
  // 判据必须跟服务端打包用的 `isPackageWorthy` 是同一个 —— 这里数的是
  // `q.packable`，不是 `q.counts.full`。两者差着「疑似跑题」那一档：
  // 用 full 数会让按钮说「16 篇」而包里只有 14 个正文文件（P11 的不变量）。
  const empty = q.packable === 0;

  return (
    <div style={{ marginBottom: 12 }}>
      <a
        className="btn btn-primary"
        style={{
          fontSize: 12,
          display: "inline-block",
          textDecoration: "none",
          opacity: empty ? 0.5 : 1,
          pointerEvents: empty ? "none" : "auto",
        }}
        href={`/api/package?sessionId=${encodeURIComponent(sessionId ?? "")}`}
        title={
          empty
            ? "这一批里没有一篇同时满足「正文完整」和「不是疑似跑题」，包里会只有报告和未收录清单"
            : "报告 + 每篇优质资料的 Markdown + 字幕；配图需要先跑一次下载"
        }
      >
        打包下载 ZIP（{q.packable} 篇优质）
      </a>
      <div className="dim" style={{ fontSize: 11, marginTop: 5 }}>
        正文与报告**不需要**先跑下载，直接打包；配图和字幕要先跑一次上面的下载才有。
      </div>
    </div>
  );
}

/**
 * 「只重抓失败和低质的」。
 *
 * 为什么值得单独一个按钮：抓取是这套流程里最慢也最贵的一步（几十秒到几分钟、
 * 几十次外部请求）。一批 40 条里抓到 22 篇完整正文之后，剩下的 18 篇往往还有
 * 救 —— 站点抽风、那次超时、当时没配代理。为了这 18 篇把 40 条重跑一遍，
 * 等于把已经拿到的东西再买一次。
 *
 * 只列**文档**，不列「搜到但没抓过」的结果：那些的重抓入口是上方的
 * 「抓取正文」，两条路径各管一段，混在一起就说不清按钮按下去会发生什么。
 *
 * 判据是 `bodyGrade(doc) !== "full"`，与 `QualityLine` 里那句「优质 N 篇」
 * 同源（同一个 `quality.ts`），所以「重抓 18 篇」与「优质 22 篇 / 共 40 篇」
 * 加得起来。
 */
function RefetchButton({
  documents,
  onRefetch,
  busy,
}: {
  documents: Document[];
  onRefetch?: (resultIds: string[]) => void;
  busy: boolean;
}) {
  const ids = useMemo(
    () => documents.filter((d) => bodyGrade(d) !== "full").map((d) => d.id),
    [documents],
  );

  // 没有可重抓的就整块不出现 —— 一个恒为「0 篇」的按钮只会占位置
  if (!onRefetch || ids.length === 0) return null;

  return (
    <div style={{ marginBottom: 12 }}>
      <button
        className="btn"
        style={{ fontSize: 12 }}
        disabled={busy}
        onClick={() => onRefetch(ids)}
        title={
          "把这 " +
          ids.length +
          " 篇重新抓一次（正文不足 300 字、或抓取时报了错）。" +
          "已经拿到完整正文的那些不会被重跑 —— 也可以在上面勾选具体站点再点「抓取正文」。"
        }
      >
        {busy ? "重抓中…" : `只重抓失败和低质的（${ids.length} 篇）`}
      </button>
      <div className="dim" style={{ fontSize: 11, marginTop: 5 }}>
        抓不到往往不是代码问题（知乎 403、站点风控、没配代理）。重抓之前先看一眼
        结果列表里那几篇的失败原因，命中的话重抓也不会有变化。
      </div>
    </div>
  );
}

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
    transcript: docs.filter((d) => docKind(d) === "video" && d.text.length > 0).length,
    image: docs.filter((d) => d.images.length > 0).length,
    media: docs.filter((d) => docKind(d) === "video").length,
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
