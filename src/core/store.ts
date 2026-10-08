/**
 * 会话持久化。
 *
 * 刻意用文件系统而非数据库：这是单机个人工具，一个主题一个目录，
 * 用户可以直接打开翻看、手动删除、丢进 git 备份。没有迁移和运维成本。
 */

import { mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import type { Session, Topic } from "./types";

const DATA_DIR = path.join(process.cwd(), "data");
const SESSIONS_DIR = path.join(DATA_DIR, "sessions");

export function sessionDir(id: string): string {
  return path.join(SESSIONS_DIR, id);
}

export function assetsDir(id: string): string {
  return path.join(sessionDir(id), "assets");
}

export async function ensureSessionDirs(id: string): Promise<void> {
  await mkdir(assetsDir(id), { recursive: true });
}

export function newTopicId(): string {
  return nanoid(10);
}

export async function saveSession(session: Session): Promise<void> {
  const dir = sessionDir(session.topic.id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "session.json"),
    JSON.stringify(session, null, 2),
    "utf8",
  );
}

export async function loadSession(id: string): Promise<Session | null> {
  const file = path.join(sessionDir(id), "session.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(await readFile(file, "utf8")) as Session;
  } catch {
    // 损坏的快照不该让整个列表页挂掉
    return null;
  }
}

export interface SessionSummary {
  id: string;
  query: string;
  sites: string[];
  updatedAt: string;
  resultCount: number;
  hasGraph: boolean;
}

export async function listSessions(): Promise<SessionSummary[]> {
  if (!existsSync(SESSIONS_DIR)) return [];
  const entries = await readdir(SESSIONS_DIR, { withFileTypes: true });
  const out: SessionSummary[] = [];

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const s = await loadSession(e.name);
    if (!s) continue;
    out.push({
      id: s.topic.id,
      query: s.topic.query,
      sites: s.topic.sites,
      updatedAt: s.topic.updatedAt,
      resultCount: s.results.length,
      hasGraph: Boolean(s.graph),
    });
  }

  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function deleteSession(id: string): Promise<void> {
  await rm(sessionDir(id), { recursive: true, force: true });
}

export function touchTopic(topic: Topic): Topic {
  return { ...topic, updatedAt: new Date().toISOString() };
}

/** 报告与下载产物的落盘路径。 */
export function reportPath(id: string): string {
  return path.join(sessionDir(id), "report.md");
}

export async function writeReport(id: string, markdown: string): Promise<string> {
  const p = reportPath(id);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, markdown, "utf8");
  return p;
}

export async function readReport(id: string): Promise<string | null> {
  const p = reportPath(id);
  if (!existsSync(p)) return null;
  return readFile(p, "utf8");
}

export { DATA_DIR, SESSIONS_DIR };
