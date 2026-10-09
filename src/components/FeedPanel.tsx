"use client";

/**
 * RSS 订阅管理。
 *
 * 自成一个组件、自己管自己的数据 —— 订阅表跟「本次搜索」没有关系，
 * 它是**长期配置**，没必要把它塞进 `page.tsx` 的会话状态里跟着一起
 * 保存/恢复。它只跟 `/api/feeds` 说话。
 *
 * ── 界面上必须先说清楚的那句话 ──
 *
 * 「订阅源不能按任意主题搜」。这是它和其他源的根本差别，也是用户最容易
 * 误解的地方：RSS 的契约就是「订阅什么给什么」，它没有搜索接口。
 * 不写这句，用户搜不到就会以为这个源坏了。
 */

import { useCallback, useEffect, useState } from "react";

interface Feed {
  title: string;
  url: string;
  enabled: boolean;
}

interface FeedsResponse {
  feeds: Feed[];
  defaults: Feed[];
  fromFile: boolean;
  error?: string;
  path: string;
}

interface ProbeResult {
  ok: boolean;
  count?: number;
  latest?: string;
  sample?: string[];
  error?: string;
}

export default function FeedPanel() {
  const [open, setOpen] = useState(false);
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [meta, setMeta] = useState<{ fromFile: boolean; error?: string; path: string } | null>(null);
  const [draft, setDraft] = useState("");
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/feeds");
      const data = (await res.json()) as FeedsResponse;
      setFeeds(data.feeds);
      setMeta({ fromFile: data.fromFile, error: data.error, path: data.path });
    } catch {
      // 读不到就当空表：这里出问题不该把整个搜索面板带崩
      setFeeds([]);
    }
  }, []);

  /*
    只在挂载时读一次。

    **不能把 `meta` 放进依赖数组** —— `load()` 自己会 `setMeta`，
    那样就成 自增循环：load → setMeta → effect 再跑 → load …
    （展开状态下尤其明显，会一直重复请求）。

    折叠时也要读，因为芯片上要显示「N/M 启用」；展开时再刷一次，
    是为了拿到外部手改 `feeds.json` 后的最新状态。
  */
  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    async (next: Feed[]) => {
      setSaving(true);
      // 乐观更新：先改界面，写失败再回滚。订阅表是本地文件，失败很罕见，
      // 卡一下再变反而更让人困惑
      const prev = feeds;
      setFeeds(next);
      try {
        const res = await fetch("/api/feeds", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ feeds: next }),
        });
        if (!res.ok) {
          const d = (await res.json()) as { error?: string };
          setMeta((m) => ({ ...(m ?? { fromFile: true, path: "" }), error: d.error }));
          setFeeds(prev);
        } else {
          setMeta((m) => (m ? { ...m, fromFile: true, error: undefined } : m));
        }
      } catch (err) {
        setMeta((m) => ({
          ...(m ?? { fromFile: true, path: "" }),
          error: err instanceof Error ? err.message : String(err),
        }));
        setFeeds(prev);
      } finally {
        setSaving(false);
      }
    },
    [feeds],
  );

  const enabledCount = feeds.filter((f) => f.enabled).length;

  /** 试抓一条。加之前先确认它真的能解析 —— 见 /api/feeds 路由的说明。 */
  const runProbe = useCallback(async (url: string) => {
    if (!url.trim()) return;
    setBusy(true);
    setProbe(null);
    try {
      const res = await fetch(`/api/feeds?probe=${encodeURIComponent(url.trim())}`);
      setProbe((await res.json()) as ProbeResult);
    } catch (err) {
      setProbe({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <div style={{ marginTop: 12, borderTop: "1px solid var(--border-subtle)", paddingTop: 10 }}>
      <button
        className="badge"
        onClick={() => {
          // 展开时重新读一遍：用户可能刚在外面手改过 feeds.json
          if (!open) void load();
          setOpen((v) => !v);
        }}
        style={{
          cursor: "pointer",
          color: open ? "var(--accent)" : "var(--fg-dim)",
          borderColor: open ? "#1f6feb66" : "var(--border)",
          background: open ? "#1f6feb15" : "transparent",
        }}
      >
        RSS 订阅 {enabledCount}/{feeds.length} 启用 {open ? "▾" : "▸"}
      </button>

      {open && (
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
          {/*
            这句话是这个面板存在的理由。RSS 没有搜索接口，「搜不到」不代表
            坏了 —— 它只会把订阅表里恰好命中关键词的条目捞出来。
          */}
          <p className="dim" style={{ fontSize: 11, margin: 0, lineHeight: 1.6 }}>
            订阅源<strong>不能按任意主题搜</strong> —— 它只从你订阅的站点里，
            捞出恰好命中关键词的条目。它的用处是补搜索引擎的时差：
            文章从发布到被索引常要几天，而 RSS 是发布即到。
            空结果通常说明订阅列表里没有相关站点，不代表源有故障。
          </p>

          {meta?.error && (
            <p style={{ fontSize: 11, margin: 0, color: "var(--warn, #d29922)" }}>
              ⚠ {meta.error}
            </p>
          )}
          {meta && !meta.fromFile && (
            <p className="dim" style={{ fontSize: 11, margin: 0 }}>
              正在使用内置默认订阅。增删任意一条就会写入 {meta.path}。
            </p>
          )}

          {/* ── 订阅列表 ── */}
          {feeds.length === 0 && (
            <p className="dim" style={{ fontSize: 11, margin: 0 }}>还没有订阅。</p>
          )}
          {feeds.map((f, i) => (
            <div
              key={f.url}
              style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11 }}
            >
              <input
                type="checkbox"
                checked={f.enabled}
                disabled={saving}
                onChange={() =>
                  void save(feeds.map((x, j) => (j === i ? { ...x, enabled: !x.enabled } : x)))
                }
                title={f.enabled ? "停用这条订阅" : "启用这条订阅"}
              />
              <span style={{ minWidth: 0, flex: 1 }}>
                <span style={{ opacity: f.enabled ? 1 : 0.5 }}>{f.title}</span>
                <span className="dim" style={{ marginLeft: 6 }}>{f.url}</span>
              </span>
              <button
                className="btn"
                style={{ padding: "1px 6px", fontSize: 11 }}
                disabled={busy}
                onClick={() => void runProbe(f.url)}
              >
                测试
              </button>
              <button
                className="btn"
                style={{ padding: "1px 6px", fontSize: 11 }}
                disabled={saving}
                onClick={() => void save(feeds.filter((_, j) => j !== i))}
                title="移除这条订阅"
              >
                ✕
              </button>
            </div>
          ))}

          {/* ── 新增 ── */}
          <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
            <input
              className="input"
              style={{ flex: 1, minWidth: 0, fontSize: 11 }}
              placeholder="订阅 URL，例如 https://example.com/feed"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void runProbe(draft);
              }}
            />
            <button
              className="btn"
              disabled={busy || !draft.trim()}
              onClick={() => void runProbe(draft)}
            >
              {busy ? "测试中…" : "测试"}
            </button>
            <button
              className="btn btn-primary"
              disabled={saving || !draft.trim()}
              onClick={() => {
                const url = draft.trim();
                if (!feeds.some((f) => f.url === url)) {
                  void save([...feeds, { title: url, url, enabled: true }]);
                }
                setDraft("");
                setProbe(null);
              }}
            >
              添加
            </button>
          </div>

          {probe && (
            <div
              style={{
                fontSize: 11,
                padding: "6px 8px",
                borderRadius: 4,
                lineHeight: 1.6,
                background: probe.ok ? "#1f6feb15" : "#f8514920",
              }}
            >
              {probe.ok ? (
                <>
                  ✓ 能解析，拿到 <strong>{probe.count}</strong> 条
                  {probe.latest && `，最新 ${probe.latest.slice(0, 10)}`}
                  {probe.sample && probe.sample.length > 0 && (
                    <div className="dim">例：{probe.sample[0]}</div>
                  )}
                  {probe.count === 0 && (
                    <div className="dim">
                      能解析但当前没有条目 —— 站点可能是低频更新的。
                    </div>
                  )}
                </>
              ) : (
                <>✗ {probe.error}（这个地址当前不能作为订阅使用）</>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
