#!/usr/bin/env node
/**
 * 把一次会话的拓扑图导出成 SVG，写进 docs/。
 *
 *   node examples/graph-image.mjs <sessionId> [--out docs/topology-example.svg] [--no-docs] [--width 1600]
 *   node examples/graph-image.mjs                 # 不带 id 就列出最近的会话
 *
 * 这是 README 里那张示例图的**来源**。所以它刻意不做任何美化：调用的就是
 * `/api/export/image` 这个生产接口，出来的就是用户点「导出」会拿到的东西。
 * 一张手工润色过的示意图迟早会和产品长得不一样，然后开始骗人。
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = process.env.MUTIEYE_BASE ?? "http://localhost:3000";

function parseArgs(argv) {
  const out = { sessionId: null, out: null, docs: true, width: 1600, seed: 42 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--out") out.out = argv[++i];
    else if (a === "--no-docs") out.docs = false;
    else if (a === "--width") out.width = Number(argv[++i]) || 1600;
    else if (a === "--seed") out.seed = Number(argv[++i]) || 42;
    else if (!a.startsWith("-") && !out.sessionId) out.sessionId = a;
  }
  return out;
}

async function listSessions() {
  const res = await fetch(`${BASE}/api/session`);
  if (!res.ok) throw new Error(`GET /api/session → HTTP ${res.status}`);
  const { sessions } = await res.json();
  if (sessions.length === 0) {
    console.log("还没有任何会话。先跑 `pnpm example` 生成一个。");
    return;
  }
  console.log("最近的会话：\n");
  for (const s of sessions.slice(0, 12)) {
    const hasGraph = s.hasGraph ? "有拓扑" : "无拓扑";
    console.log(`  ${s.id}  ${hasGraph}  ${s.query}`);
  }
  console.log(`\n用法：node examples/graph-image.mjs <sessionId>`);
}

const args = parseArgs(process.argv.slice(2));

if (!args.sessionId) {
  await listSessions();
  process.exit(0);
}

const qs = new URLSearchParams({
  sessionId: args.sessionId,
  format: "svg",
  width: String(args.width),
  seed: String(args.seed),
});
if (!args.docs) qs.set("docs", "0");

const res = await fetch(`${BASE}/api/export/image?${qs}`);
if (!res.ok) {
  // 409 是「会话还没有图」这种正常状态，不是脚本出错，但也没法继续
  let detail = `HTTP ${res.status}`;
  try {
    detail = (await res.json()).error ?? detail;
  } catch {
    /* 响应不是 JSON，就用状态码 */
  }
  console.error(`✗ ${detail}`);
  process.exit(1);
}

const svg = await res.text();

// 数量走响应头，不去 SVG 里数元素 —— 图例色块也是 <rect>，数出来的是错的
const header = (k, dflt = "?") => res.headers.get(k) ?? dflt;
const w = Number(svg.match(/width="(\d+)"/)?.[1] ?? 0);
const h = Number(svg.match(/height="(\d+)"/)?.[1] ?? 0);

const outPath = path.resolve(
  args.out ?? `docs/topology-${args.sessionId}.svg`,
);
await mkdir(path.dirname(outPath), { recursive: true });
await writeFile(outPath, svg, "utf8");

console.log(`✓ ${outPath}`);
console.log(`  ${w}×${h}  ${(svg.length / 1024).toFixed(1)}KB`);
console.log(
  `  ${header("X-Topology-Nodes")} 节点（概念 ${header("X-Topology-Concepts")} · 资料 ${header("X-Topology-Documents")}）· ${header("X-Topology-Edges")} 边`,
);
console.log(
  `\n把它嵌进 README：\n  ![知识拓扑示例](${path.relative(process.cwd(), outPath)})`,
);
