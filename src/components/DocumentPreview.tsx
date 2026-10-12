"use client";

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Document } from "@/core/types";
import { docKind } from "@/core/kind";
import { formatDate } from "@/core/time";

export interface DocumentPreviewProps {
  document: Document;
  /** 当前会话 id。用于先找已下载的本地视频。 */
  sessionId?: string;
  onClose: () => void;
}

/**
 * 资料预览：文章渲染 Markdown；视频**优先播放本地已下载的文件**。
 *
 * 这个面板读的是抓取后已经落盘的 `Document`，不重新请求原文，所以即使原站
 * 已经下线，用户仍然能查看这次抓到的内容。
 *
 * 视频的规则（按用户要求）：
 *   - 下载完成 → 直接播本地文件（不经过平台播放器，也不会有广告/登录墙）
 *   - 还没下载 → 跳转到视频原地址；同时**每 3 秒查一次**，下载一完成就
 *     自动切成本地播放 —— 用户开着预览去点下载，不必关掉再重开。
 */
export default function DocumentPreview({
  document,
  sessionId,
  onClose,
}: DocumentPreviewProps) {
  const [source, setSource] = useState(false);
  const kind = docKind(document);
  const markdown = document.markdown?.trim() || document.text.trim();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "rgb(0 0 0 / 72%)",
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={document.title || "资料预览"}
        style={{
          width: "min(980px, 100%)",
          maxHeight: "min(90vh, 900px)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          boxShadow: "0 24px 80px rgb(0 0 0 / 45%)",
        }}
      >
        <header
          style={{
            display: "flex",
            gap: 12,
            alignItems: "flex-start",
            padding: "14px 16px",
            borderBottom: "1px solid var(--border-subtle)",
          }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 600, lineHeight: 1.35 }}>
              {document.title || document.url}
            </div>
            <div className="dim" style={{ fontSize: 11, marginTop: 4 }}>
              {document.site} · {document.wordCount} 字
              {document.publishedAt && ` · ${formatDate(document.publishedAt)}`}
            </div>
          </div>
          <a
            className="btn"
            href={document.url}
            target="_blank"
            rel="noreferrer"
            style={{ whiteSpace: "nowrap" }}
          >
            打开原文
          </a>
          <button className="btn" onClick={onClose} aria-label="关闭预览">
            关闭
          </button>
        </header>

        <div style={{ overflow: "auto", padding: "16px 20px 24px" }}>
          {kind === "video" && (
            <VideoPreview
              document={document}
              sessionId={sessionId}
            />
          )}

          {markdown && (
            <div style={{ marginTop: kind === "video" ? 16 : 0 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 10,
                  marginBottom: 10,
                }}
              >
                <span className="dim" style={{ fontSize: 11 }}>
                  {kind === "video" ? "视频简介 / 字幕" : "Markdown 预览"}
                </span>
                <button
                  className="badge"
                  onClick={() => setSource((value) => !value)}
                  style={{ cursor: "pointer" }}
                >
                  {source ? "渲染预览" : "查看 Markdown"}
                </button>
              </div>

              {source ? (
                <pre
                  className="mono"
                  style={{
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    margin: 0,
                    fontSize: 12,
                    lineHeight: 1.6,
                  }}
                >
                  {markdown}
                </pre>
              ) : (
                <div className="markdown-preview">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {markdown}
                  </ReactMarkdown>
                </div>
              )}
            </div>
          )}

          {!markdown && (
            <p className="dim" style={{ fontSize: 13 }}>
              {document.error ?? "这次抓取没有拿到可预览的正文。"}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

function VideoPreview({
  document,
  sessionId,
}: {
  document: Document;
  sessionId?: string;
}) {
  const [localState, setLocalState] = useState<"checking" | "pending" | "ready">(
    sessionId ? "checking" : "pending",
  );

  useEffect(() => {
    if (!sessionId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const url = `/api/preview?sessionId=${encodeURIComponent(sessionId)}&docId=${encodeURIComponent(document.id)}`;

    const check = async () => {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!active) return;
        if (res.ok) {
          setLocalState("ready");
          return;
        }
        // 还没下载 —— 留在「跳原地址」这一档，但继续轮询：
        // 用户很可能正开着预览去点下载，完成的瞬间这里就该自己切过去。
        setLocalState((prev) => (prev === "checking" ? "pending" : prev));
      } catch {
        if (!active) return;
        setLocalState((prev) => (prev === "checking" ? "pending" : prev));
      }
      if (active) timer = setTimeout(() => void check(), 3_000);
    };
    void check();

    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [document.id, sessionId]);

  if (localState === "checking") {
    return (
      <p className="dim" style={{ fontSize: 13, margin: 0 }}>
        正在检查本地是否已下载这个视频…
      </p>
    );
  }

  if (localState === "ready") {
    return (
      <div>
        <div className="dim" style={{ fontSize: 11, marginBottom: 6 }}>
          本地已下载视频
        </div>
        <video
          controls
          playsInline
          preload="metadata"
          poster={document.thumbnail}
          src={`/api/preview?sessionId=${encodeURIComponent(sessionId ?? "")}&docId=${encodeURIComponent(document.id)}`}
          style={{
            display: "block",
            width: "100%",
            maxHeight: 520,
            borderRadius: 6,
            background: "#000",
          }}
        >
          您的浏览器不支持视频播放。
        </video>
      </div>
    );
  }

  if (localState === "pending") {
    return (
      <div>
        <a
          href={document.url}
          target="_blank"
          rel="noreferrer"
          style={{ display: "block", position: "relative" }}
        >
          {document.thumbnail ? (
            <img
              src={document.thumbnail}
              alt={document.title}
              style={{
                display: "block",
                width: "100%",
                maxHeight: 420,
                objectFit: "cover",
                borderRadius: 6,
                background: "#000",
              }}
            />
          ) : (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: "100%",
                aspectRatio: "16 / 9",
                borderRadius: 6,
                background: "#000",
                color: "#8b949e",
                fontSize: 13,
              }}
            >
              本地尚未下载
            </div>
          )}
          <span
            style={{
              position: "absolute",
              inset: "50% auto auto 50%",
              transform: "translate(-50%, -50%)",
              padding: "8px 14px",
              borderRadius: 999,
              background: "rgb(0 0 0 / 72%)",
              color: "#fff",
              fontSize: 13,
            }}
          >
            打开原视频
          </span>
        </a>
        <p className="dim" style={{ fontSize: 12, margin: "8px 0 0" }}>
          本地还没有下载这个视频，点击上方跳转到原地址。在下方下载面板勾选
          「视频」开始下载后，这里会自动切换成直接播放本地文件，无需重新打开。
        </p>
      </div>
    );
  }

  // 本地已下载 —— 直接播文件，不经过平台播放器
  return (
    <div>
      <div className="dim" style={{ fontSize: 11, marginBottom: 6 }}>
        本地已下载 · 直接播放
      </div>
      <video
        controls
        playsInline
        preload="metadata"
        poster={document.thumbnail}
        src={`/api/preview?sessionId=${encodeURIComponent(sessionId ?? "")}&docId=${encodeURIComponent(document.id)}`}
        style={{
          display: "block",
          width: "100%",
          maxHeight: 520,
          borderRadius: 6,
          background: "#000",
        }}
      >
        您的浏览器不支持视频播放。
      </video>
    </div>
  );
}
