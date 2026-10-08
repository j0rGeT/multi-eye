"use client";

import { useEffect, useState } from "react";

interface Check {
  id: string;
  label: string;
  required: boolean;
  ok: boolean;
  detail: string;
  hint?: string;
}

interface Health {
  healthy: boolean;
  searchChain: string[];
  graphBuilder: string;
  checks: Check[];
}

export default function Home() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch((e) => setError(String(e)));
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          muti-eye
          <span>主题资源拓扑</span>
        </div>
        {health && (
          <span className={health.healthy ? "badge badge-ok" : "badge badge-err"}>
            <span
              className="dot"
              style={{ background: health.healthy ? "var(--ok)" : "var(--err)" }}
            />
            {health.healthy ? "就绪" : "需要配置"}
          </span>
        )}
      </header>

      <main className="main">
        <div className="panel">
          <h2>环境自检</h2>

          {error && <p style={{ color: "var(--err)" }}>无法读取健康状态：{error}</p>}
          {!health && !error && <p className="muted">检测中…</p>}

          {health && (
            <>
              <p className="muted" style={{ marginTop: 0 }}>
                搜索链路：<code className="mono">{health.searchChain.join(" → ")}</code>
                <span className="dim"> · </span>
                构图方式：<code className="mono">{health.graphBuilder}</code>
              </p>

              <div style={{ display: "grid", gap: 10, marginTop: 16 }}>
                {health.checks.map((c) => (
                  <div
                    key={c.id}
                    style={{
                      display: "flex",
                      gap: 12,
                      alignItems: "flex-start",
                      padding: "10px 12px",
                      background: "var(--bg)",
                      border: "1px solid var(--border-subtle)",
                      borderRadius: 6,
                    }}
                  >
                    <span
                      className="dot"
                      style={{
                        background: c.ok ? "var(--ok)" : c.required ? "var(--err)" : "var(--fg-dim)",
                        marginTop: 7,
                      }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <strong style={{ fontWeight: 500 }}>{c.label}</strong>
                        {c.required && <span className="badge">必需</span>}
                        {!c.required && <span className="badge">可选</span>}
                      </div>
                      <div className="muted" style={{ fontSize: 13 }}>
                        {c.detail}
                      </div>
                      {!c.ok && c.hint && (
                        <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>
                          {c.hint}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
