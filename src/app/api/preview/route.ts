import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import type { NextRequest } from "next/server";
import { loadJob } from "@/core/download/queue";
import { assetsDir } from "@/core/store";
import { loadSession } from "@/core/store";

export const dynamic = "force-dynamic";

const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".m4v",
  ".webm",
  ".mkv",
  ".mov",
  ".avi",
  ".ogv",
]);

const CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".ogv": "video/ogg",
};

/**
 * 读取本地已下载的视频，供前端优先播放。
 *
 * 下载层把 yt-dlp 的最终文件放在 `*.media/` 目录里，而任务表只记录目录名，
 * 不记录 yt-dlp 自己决定的扩展名。这里按目录扫描真实文件，避免把下载层的
 * 内部命名约定泄漏到预览组件。
 */
export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get("sessionId")?.trim();
  const docId = req.nextUrl.searchParams.get("docId")?.trim();
  if (!sessionId || !docId) {
    return Response.json({ error: "缺少 sessionId 或 docId", available: false }, { status: 400 });
  }

  const session = await loadSession(sessionId);
  if (!session) {
    return Response.json({ error: "会话不存在", available: false }, { status: 404 });
  }
  if (!session.documents.some((doc) => doc.id === docId)) {
    return Response.json({ error: "资料不存在", available: false }, { status: 404 });
  }

  const job = await loadJob(sessionId);
  const task = job?.tasks.find(
    (item) => item.docId === docId && item.kind === "media" && item.outputPath,
  );
  if (!task?.outputPath) {
    return Response.json({ available: false, reason: "尚未下载视频" }, { status: 404 });
  }

  const base = assetsDir(sessionId);
  const target = resolve(base, task.outputPath);
  if (target !== base && !target.startsWith(`${base}${sep}`)) {
    return Response.json({ error: "非法文件路径", available: false }, { status: 400 });
  }

  const videoPath = await findVideo(target);
  if (!videoPath) {
    return Response.json({ available: false, reason: "视频文件尚未完成" }, { status: 404 });
  }

  // videoPath 来自 assetsDir 下的扫描结果，不是用户输入；忽略标记只是让
  // Turbopack 不把这个动态路径当作「要打包整个项目」的信号。
  const info = await stat(/*turbopackIgnore: true*/ videoPath);
  const extension = extname(videoPath).toLowerCase();
  const contentType = CONTENT_TYPES[extension] ?? "application/octet-stream";
  const range = parseRange(req.headers.get("range"), info.size);

  if (range === "invalid") {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${info.size}` },
    });
  }

  if (range) {
    return new Response(
      createReadStream(videoPath, { start: range.start, end: range.end }) as unknown as BodyInit,
      {
      status: 206,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(range.end - range.start + 1),
        "Content-Range": `bytes ${range.start}-${range.end}/${info.size}`,
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=0, no-cache",
      },
    },
    );
  }

  return new Response(createReadStream(videoPath) as unknown as BodyInit, {
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(info.size),
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=0, no-cache",
    },
  });
}

async function findVideo(target: string): Promise<string | null> {
  try {
    const info = await stat(target);
    if (info.isFile() && VIDEO_EXTENSIONS.has(extname(target).toLowerCase())) {
      return target;
    }
    if (!info.isDirectory()) return null;
    const entries = await readdir(target, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const path = join(target, entry.name);
      if (entry.isFile() && VIDEO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        files.push(path);
      }
    }
    if (files.length === 0) return null;
    files.sort((a, b) => a.localeCompare(b));
    return files[0];
  } catch {
    return null;
  }
}

function parseRange(
  raw: string | null,
  size: number,
): { start: number; end: number } | null | "invalid" {
  if (!raw?.startsWith("bytes=")) return null;
  const match = raw.slice(6).match(/^(\d*)-(\d*)$/);
  if (!match) return "invalid";
  const [, startRaw, endRaw] = match;
  if (!startRaw && !endRaw) return "invalid";
  const start = startRaw ? Number(startRaw) : Math.max(0, size - Number(endRaw));
  const end = endRaw ? Math.min(size - 1, Number(endRaw)) : size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= size) {
    return "invalid";
  }
  return { start, end };
}
