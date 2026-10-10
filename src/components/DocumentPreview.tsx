"use client";

import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Document } from "@/core/types";
import { docKind } from "@/core/kind";
import { formatDate } from "@/core/time";

export interface DocumentPreviewProps {
  document: Document;
  onClose: () => void;
}

/**
 * 资料预览：文章渲染 Markdown，视频内嵌播放器。
 *
 * 这个面板读的是抓取后已经落盘的 `Document`，不重新请求原文，所以即使原站
 * 已经下线，用户仍然能查看这次抓到的内容。视频优先使用平台官方播放器；
 * 其它站点没有安全的内嵌地址时，保留封面与原文链接，不伪造一个“正在播放”。
 */
export default function DocumentPreview({
  document,
  onClose,
}: DocumentPreviewProps) {
  const [source, setSource] = useState(false);
  const kind = docKind(document);
  const markdown = document.markdown?.trim() || document.text.trim();
  const embedUrl = useMemo(() => videoEmbedUrl(document.url), [document.url]);

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
            <VideoPreview document={document} embedUrl={embedUrl} />
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
  embedUrl,
}: {
  document: Document;
  embedUrl: string | null;
}) {
  if (embedUrl) {
    return (
      <iframe
        title={document.title || "视频预览"}
        src={embedUrl}
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
        style={{
          display: "block",
          width: "100%",
          aspectRatio: "16 / 9",
          border: 0,
          borderRadius: 6,
          background: "#000",
        }}
      />
    );
  }

  if (document.thumbnail) {
    return (
      <a
        href={document.url}
        target="_blank"
        rel="noreferrer"
        style={{ display: "block", position: "relative" }}
      >
        <img
          src={document.thumbnail}
          alt={document.title}
          style={{
            display: "block",
            width: "100%",
            maxHeight: 360,
            objectFit: "cover",
            borderRadius: 6,
            background: "#000",
          }}
        />
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
          打开视频
        </span>
      </a>
    );
  }

  return (
    <p className="dim" style={{ fontSize: 12, margin: 0 }}>
      该站点不提供可安全内嵌的播放器，请通过“打开原文”观看视频。
    </p>
  );
}

/** YouTube 与 B 站给出官方 embed 地址；其它站点交给原文链接。 */
function videoEmbedUrl(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (/(^|\.)youtube\.com$/.test(url.hostname) || url.hostname === "youtu.be") {
    const id =
      url.hostname === "youtu.be"
        ? url.pathname.slice(1)
        : url.searchParams.get("v") ||
          url.pathname.match(/\/(?:shorts|embed)\/([^/]+)/)?.[1];
    return id ? `https://www.youtube.com/embed/${encodeURIComponent(id)}` : null;
  }

  if (/(^|\.)bilibili\.com$/.test(url.hostname)) {
    const bvid = url.searchParams.get("bvid");
    const aid = url.searchParams.get("aid");
    const pathId = url.pathname.match(/\/video\/(BV[^/]+)/)?.[1];
    const id = bvid ?? pathId;
    if (id) {
      return `https://player.bilibili.com/player.html?bvid=${encodeURIComponent(id)}&autoplay=0&high_quality=1`;
    }
    if (aid) {
      return `https://player.bilibili.com/player.html?aid=${encodeURIComponent(aid)}&autoplay=0&high_quality=1`;
    }
  }

  return null;
}
