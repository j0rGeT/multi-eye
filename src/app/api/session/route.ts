import type { NextRequest } from "next/server";
import { listSessions, loadSession, saveSession } from "@/core/store";
import type { SessionViewState } from "@/core/types";

// 不导出 runtime：Next 16 里 'nodejs' 已是默认值（Edge 废弃），文档要求移除该导出。
export const dynamic = "force-dynamic";

/** 位置表的上限。一份 500 节点的图也就 15KB 左右，超出这个量级说明请求不正常。 */
const MAX_POSITIONS = 2000;
/** 坐标绝对值上限。力导向不可能跑到这个数，超出说明是伪造的数据。 */
const MAX_COORD = 1e6;
const MAX_PINNED = 2000;

/**
 * 校验前端回传的界面状态。
 *
 * 这个接口会写进 session.json，而 session.json 是导出报告和续跑下载的依据 ——
 * 一个形状不对的 viewState 混进去，下次 loadSession 就会在别处炸。所以这里
 * **只接受认识的字段**，其余一律丢弃，并且逐项做范围检查。
 */
function sanitizeViewState(raw: unknown): SessionViewState | null {
  if (!raw || typeof raw !== "object") return null;
  const src = raw as Record<string, unknown>;
  const out: SessionViewState = {};

  if (src.positions && typeof src.positions === "object") {
    const positions: Record<string, { x: number; y: number }> = {};
    let n = 0;
    for (const [id, v] of Object.entries(src.positions as Record<string, unknown>)) {
      if (n >= MAX_POSITIONS) break;
      if (!v || typeof v !== "object") continue;
      const { x, y } = v as { x?: unknown; y?: unknown };
      if (typeof x !== "number" || typeof y !== "number") continue;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (Math.abs(x) > MAX_COORD || Math.abs(y) > MAX_COORD) continue;
      positions[id] = { x, y };
      n += 1;
    }
    out.positions = positions;
  }

  if (Array.isArray(src.pinned)) {
    out.pinned = src.pinned
      .filter((id): id is string => typeof id === "string" && id.length < 200)
      .slice(0, MAX_PINNED);
  }

  if (typeof src.showDocuments === "boolean") {
    out.showDocuments = src.showDocuments;
  }

  return out;
}

/**
 * 读取会话。
 *
 *   GET /api/session?id=X   取回整份会话（主题、结果、正文、图）
 *   GET /api/session        列出最近的会话
 *
 * 存在的理由只有一个：**刷新页面之后要能接着用**。搜索、抓取、构图、下载的
 * 产物本来就在服务端，下载任务更是自己跑自己的、与浏览器无关；但页面状态
 * 只活在内存里，刷新一次就全没了 —— 于是「异步下载」变成「别关这个标签页」。
 * 这个接口让前端在挂载时把会话重新读回来。
 */
export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id")?.trim();

  if (!id) {
    return Response.json(
      { sessions: await listSessions() },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const session = await loadSession(id);
  if (!session) {
    return Response.json({ error: `会话不存在：${id}` }, { status: 404 });
  }

  return Response.json({ session }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * 保存图上的界面状态。
 *
 *   POST /api/session   { sessionId, viewState }
 *
 * 前端在位置变化后 debounce 800ms 发一次。**只合并 viewState 这一个字段** ——
 * 调用方是渲染图的那一端，它手上没有正文和下载任务，让它整份覆盖会把服务端
 * 的产物抹掉。
 *
 * 已知的窄窗口：load → merge → save 之间如果恰好有另一个写操作（抓取或构图
 * 落盘），这次的位置会丢。单机单人工具、800ms 才写一次，这个概率可以接受；
 * 丢了的表现是「回到上次布局」，不是数据损坏。
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const { sessionId, viewState } = (body ?? {}) as {
    sessionId?: unknown;
    viewState?: unknown;
  };

  if (typeof sessionId !== "string" || !sessionId.trim()) {
    return Response.json({ error: "缺少 sessionId" }, { status: 400 });
  }

  const clean = sanitizeViewState(viewState);
  if (!clean) {
    return Response.json({ error: "viewState 形状不对" }, { status: 400 });
  }

  const session = await loadSession(sessionId.trim());
  if (!session) {
    return Response.json({ error: `会话不存在：${sessionId}` }, { status: 404 });
  }

  session.viewState = { ...session.viewState, ...clean };
  await saveSession(session);

  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
