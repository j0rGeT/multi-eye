#!/usr/bin/env node
/**
 * 把一次会话的产物用文本打出来 —— 不用开浏览器就能看构图结果。
 *
 * 用途是排查，而不是展示。`e2e.mjs` 告诉你「图建出来了」，这个脚本告诉你
 * 「图建成了什么样」：哪几簇、每簇里权重最高的是哪些词、有多少节点其实是
 * 孤立词（degree=1 的节点超过一定比例，通常意味着语料太少或太散）。
 *
 *   node examples/show.mjs <sessionId>              # 拓扑
 *   node examples/show.mjs <sessionId> --report     # 导出的 Markdown 前 N 行
 *   node examples/show.mjs <sessionId> --docs       # 逐篇看抓取质量
 *   node examples/show.mjs                          # 列出最近的会话
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SESSIONS = join(ROOT, "data", "sessions");

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const sessionId = argv.find((a) => !a.startsWith("--"));

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
};

/** 按显示宽度补位 —— 中文占两列，用 string.length 对不齐。 */
function pad(s, n) {
  const width = [...s].reduce((w, ch) => w + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(ch) ? 2 : 1), 0);
  return s + " ".repeat(Math.max(0, n - width));
}

async function loadSession(id) {
  const file = join(SESSIONS, id, "session.json");
  if (!existsSync(file)) {
    console.error(`找不到会话：${file}`);
    process.exit(1);
  }
  return JSON.parse(await readFile(file, "utf8"));
}

async function listSessions() {
  if (!existsSync(SESSIONS)) {
    console.log("还没有任何会话。先跑一次：node examples/e2e.mjs");
    return;
  }
  const ids = await readdir(SESSIONS);
  const rows = [];
  for (const id of ids) {
    const file = join(SESSIONS, id, "session.json");
    if (!existsSync(file)) continue;
    const s = JSON.parse(await readFile(file, "utf8"));
    const g = s.graph;
    rows.push({
      id,
      query: s.topic?.query ?? "?",
      results: s.results?.length ?? 0,
      docs: s.documents?.length ?? 0,
      graph: g ? `${g.nodes.length}节点/${g.clusters.length}簇 · ${g.stats.generatedBy}` : "—",
      at: s.topic?.updatedAt?.slice(0, 19).replace("T", " ") ?? "",
    });
  }
  rows.sort((a, b) => b.at.localeCompare(a.at));

  console.log(C.bold("\n最近的会话\n"));
  for (const r of rows.slice(0, 20)) {
    console.log(
      `  ${C.cyan(r.id)}  ${pad(r.query, 18)} ${C.dim(`${String(r.results).padStart(3)} 结果  ${String(r.docs).padStart(3)} 正文`)}  ${pad(r.graph, 22)} ${C.dim(r.at)}`,
    );
  }
  console.log(C.dim("\n  node examples/show.mjs <sessionId>  看拓扑\n"));
}

function showGraph(s) {
  const g = s.graph;
  if (!g) {
    console.log(C.yellow("这次会话还没构图。先跑：node examples/e2e.mjs\n"));
    return;
  }

  const st = g.stats;
  console.log(C.bold(`\n拓扑 · 「${g.topic.query}」`));
  console.log(
    C.dim(
      `  ${st.generatedBy} · ${st.nodeCount} 节点 / ${st.edgeCount} 边 / ${st.clusterCount} 簇` +
        ` · ${st.docCount} 篇语料 · ${st.durationMs}ms` +
        (st.llmFallbackReason ? `\n  ⚠ LLM 降级原因：${st.llmFallbackReason}` : ""),
    ),
  );

  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const sorted = [...g.clusters].sort((a, b) => b.size - a.size);

  for (const c of sorted) {
    console.log(`\n  ${C.cyan("◉")} ${C.bold(c.label)} ${C.dim(`(${c.size} 节点 / ${c.docIds.length} 篇)`)}`);
    if (c.summary) console.log(`    ${C.dim(c.summary)}`);

    const nodes = c.nodeIds
      .map((id) => byId.get(id))
      .filter(Boolean)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 10);

    for (const n of nodes) {
      // 边按 kind 分类展示：relation 是 LLM 给的带谓词的边，比共现更有信息量
      const edges = g.edges
        .filter((e) => e.source === n.id || e.target === n.id)
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 4)
        .map((e) => {
          const other = byId.get(e.source === n.id ? e.target : e.source);
          const mark = e.kind === "relation" ? "→" : "~";
          return `${mark}${other?.label ?? "?"}${e.label ? C.dim(`(${e.label})`) : ""}`;
        })
        .join(" ");

      console.log(
        `      ${pad(n.label, 16)} ${C.dim(`w=${n.weight.toFixed(1)} deg=${n.degree} ${n.kind}`)} ${C.dim(edges)}`,
      );
    }
  }

  // 孤立词比例：语料太少或主题太散时这个数会飙高，是「图看起来很大其实是散的」
  // 的量化信号
  const isolated = g.nodes.filter((n) => n.degree <= 1).length;
  const ratio = isolated / g.nodes.length;
  console.log(
    `\n  ${ratio > 0.5 ? C.yellow("⚠") : C.green("✓")} 孤立节点（degree ≤ 1）${isolated}/${g.nodes.length} = ${(ratio * 100).toFixed(0)}%`,
  );
  if (ratio > 0.5) {
    console.log(C.dim("    超过一半 —— 通常是语料太少或主题太散，把 resolution 调低一点能缓解"));
  }

  // 直接可粘贴的 Mermaid 源码，想手看拓扑时不必先导出报告
  if (flags.has("--mermaid")) {
    console.log(C.dim("\n── Mermaid ──\n"));
    console.log("```mermaid");
    console.log("graph LR");
    for (const n of g.nodes.slice(0, 40)) {
      console.log(`  ${n.id.replace(/[^\w]/g, "_")}["${n.label}"]`);
    }
    for (const e of g.edges.filter((e) => e.kind === "relation").slice(0, 60)) {
      console.log(
        `  ${e.source.replace(/[^\w]/g, "_")} -->|${e.label ?? ""}| ${e.target.replace(/[^\w]/g, "_")}`,
      );
    }
    console.log("```");
  }
}

function showDocs(s) {
  console.log(C.bold(`\n抓取结果 · 「${s.topic?.query}」`));
  const docs = s.documents ?? [];
  console.log(C.dim(`  ${docs.length} 篇\n`));

  for (const d of docs) {
    const flag = d.extractMethod === "raw" ? C.yellow("降级") : C.green("正文");
    console.log(
      `  ${flag} ${pad(d.extractMethod, 16)} ${C.dim(`w=${String(d.wordCount).padStart(5)} ${String(d.extractMs).padStart(6)}ms`)} ${pad(d.title.slice(0, 40), 42)}`,
    );
    console.log(`       ${C.dim(d.url)}`);
    if (d.error) console.log(`       ${C.yellow("! " + d.error)}`);
    if (flags.has("--verbose")) {
      console.log(C.dim(`       ${d.text.slice(0, 200).replace(/\n/g, " ")}`));
    }
  }

  const by = {};
  for (const d of docs) by[d.extractMethod] = (by[d.extractMethod] ?? 0) + 1;
  console.log(`\n  ${C.dim(Object.entries(by).map(([k, v]) => `${k}×${v}`).join("  "))}\n`);
}

async function showReport(s, id) {
  const file = join(SESSIONS, id, "report.md");
  if (!existsSync(file)) {
    console.log(C.yellow("这次会话还没导出报告。先在界面上点导出，或跑 examples/e2e.mjs\n"));
    return;
  }
  const md = await readFile(file, "utf8");
  const size = (await stat(file)).size;
  const head = flags.has("--all") ? md : md.split("\n").slice(0, 60).join("\n");
  console.log(C.bold(`\n${file.replace(ROOT, ".")}  ${C.dim(`(${size} B, ${md.split("\n").length} 行)`)}\n`));
  console.log(head);
  if (!flags.has("--all")) console.log(C.dim(`\n  …（--all 看全文，${md.split("\n").length} 行）`));
}

// ─────────────────────────── 入口 ───────────────────────────

if (!sessionId) {
  await listSessions();
} else {
  const s = await loadSession(sessionId);
  if (flags.has("--report")) await showReport(s, sessionId);
  else if (flags.has("--docs")) showDocs(s);
  else showGraph(s);
}
