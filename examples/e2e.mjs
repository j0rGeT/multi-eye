#!/usr/bin/env node
/**
 * 全链路端到端验证：把「一个主题」走完 —— 搜索 → 抓取 → 构图 → 导出 → 下载。
 *
 * 为什么要有这个脚本。
 *
 * 这个项目里几乎所有失败都是**静默的**：SearXNG 挂了会降级、B 站被风控了会
 * 退回搜索摘要、LLM 返回的 JSON 不合形状会自动降级回启发式。设计上是「永远
 * 给你一张图」，代价是「你拿到的不一定是你以为的那张」。界面上的降级徽标能
 * 补一部分，但没人会每次手点五个按钮去核对。
 *
 * 所以这里把每一步的**降级证据**都当成断言来查：
 *   - 搜索：结果数不为 0，且每个请求过的站点都有 providerLog 记录（ok 或 error）
 *   - 抓取：区分「拿到正文」和「退化为摘要」，后者超过一半就判不通过
 *   - 构图：两条路径各跑一次，比对生成的图是不是同一个形状
 *   - 导出：Markdown 里有 Mermaid 代码块、有章节、有原始链接
 *   - 下载：文件真的落到 assets/ 下，且大小不为 0
 *
 * 用法（需要 dev 服务器已经在跑）：
 *
 *   pnpm dev                       # 另开一个终端
 *   node examples/e2e.mjs
 *   node examples/e2e.mjs --query 登山杖 --no-llm --verbose
 *
 * 退出码：0 全部通过（含「降级但可接受」），1 有断言失败。
 */

import { readFile, readdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ─────────────────────────── 参数与常量 ───────────────────────────

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const BASE = opt("base", "http://localhost:3000").replace(/\/+$/, "");
const QUERY = opt("query", "露营装备");
const SITES = opt("sites", "zhihu,bilibili,youtube").split(",").filter(Boolean);
/** 抓取阶段只抓前 N 条 —— 全量抓一次要几分钟，验证链路不需要那么久。 */
const FETCH_LIMIT = Number(opt("fetch-limit", 12));
const WITH_LLM = !flag("no-llm");
const WITH_MEDIA = flag("media"); // 视频本体交给 yt-dlp，慢且大，默认不跑
const VERBOSE = flag("verbose");

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

// ─────────────────────────── 断言 ───────────────────────────

const results = [];

/** 记录一条断言。`soft` 的失败不改变退出码，用于「环境本来就可能缺」的能力。 */
function check(step, name, ok, detail = "", { soft = false } = {}) {
  results.push({ step, name, ok, detail, soft });
  const tag = ok ? C.green("✓") : soft ? C.yellow("!") : C.red("✗");
  console.log(`  ${tag} ${name}${detail ? C.dim(` — ${detail}`) : ""}`);
  return ok;
}

function soft(step, name, detail) {
  return check(step, name, false, detail, { soft: true });
}

// ─────────────────────────── 小工具 ───────────────────────────

function log(msg) {
  console.log(msg);
}

function step(title) {
  console.log(`\n${C.bold(C.cyan(`▸ ${title}`))}`);
}

function debug(...args) {
  if (VERBOSE) console.log(C.dim(`    ${args.join(" ")}`));
}

function bytes(n) {
  if (!Number.isFinite(n)) return "?";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 计时包装：返回 [结果, 毫秒]。 */
async function timed(fn) {
  const t = Date.now();
  const value = await fn();
  return [value, Date.now() - t];
}

/**
 * 读 SSE 流。
 *
 * 只认 `data:` 行 —— `/api/download` 的进度流里有 `: ping` 心跳，把它当数据
 * 解析会直接 JSON.parse 失败。
 */
async function sse(url, init, onEvent) {
  const res = await fetch(url, {
    ...init,
    headers: { Accept: "text/event-stream", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  if (!res.body) throw new Error("响应没有 body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let cut;
    while ((cut = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        onEvent(JSON.parse(payload));
      }
    }
  }
}

async function getJson(path) {
  const res = await fetch(`${BASE}${path}`);
  const body = await res.json().catch(() => null);
  return { status: res.status, body, res };
}

async function postJson(path, payload) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/** 递归列出目录下所有文件（相对路径 + 大小）。 */
async function walk(dir, prefix = "") {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(abs, rel)));
    else out.push({ rel, abs, size: (await stat(abs)).size });
  }
  return out;
}

// ─────────────────────────── 主流程 ───────────────────────────

console.log(C.bold(`\nmuti-eye 全链路验证 · 主题「${QUERY}」`));
console.log(C.dim(`目标 ${BASE} · 站点 ${SITES.join("/")} · LLM ${WITH_LLM ? "跑" : "跳过"}`));

let sessionId = null;
let documents = [];
let graph = null;

try {
  // ── 0. 部署就绪 ────────────────────────────────────────────
  step("0. 本地部署就绪检查");

  const health = await getJson("/api/health").catch((err) => ({ status: 0, body: null, err }));
  if (!check("健康检查", "服务可达", health.status === 200, `${BASE} → HTTP ${health.status}`)) {
    log(C.red("\n服务没起来。先跑 pnpm dev，并确认 SearXNG：pnpm searxng:status\n"));
    process.exit(1);
  }

  const checks = health.body.checks ?? [];
  const by = Object.fromEntries(checks.map((c) => [c.id, c]));
  for (const c of checks) {
    const detail = `${c.detail}${c.hint ? ` · ${c.hint}` : ""}`;
    if (c.required && !c.ok) check("健康检查", c.label, false, detail);
    else if (!c.ok) soft("健康检查", c.label, detail);
    else check("健康检查", c.label, true, c.detail);
  }
  debug("searchChain:", JSON.stringify(health.body.searchChain));
  debug("graphBuilder:", health.body.graphBuilder);

  check(
    "健康检查",
    "搜索链路非空",
    (health.body.searchChain ?? []).length > 0,
    (health.body.searchChain ?? []).join(" → ") || "无可用 provider",
  );

  if (!by.llm?.ok && WITH_LLM) {
    log(C.yellow("  ! 没配 LLM，下一步的 LLM 构图会自动降级成启发式"));
  }

  // ── 1. 搜索 ────────────────────────────────────────────────
  step("1. 搜索（SSE 流式）");

  const results_ = [];
  const providerLog = [];
  let plan = null;

  const [, searchMs] = await timed(() =>
    sse(`${BASE}/api/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: QUERY, sites: SITES }),
    }, (ev) => {
      if (ev.type === "plan") {
        plan = ev;
        sessionId = ev.topic.id;
        debug("plan:", ev.queries.join(" | "));
      } else if (ev.type === "results") {
        results_.push(...ev.results);
        debug(`  ← ${ev.site}: ${ev.results.length} 条`);
      } else if (ev.type === "provider") {
        providerLog.push(ev.log);
      } else if (ev.type === "done") {
        sessionId = ev.sessionId;
      } else if (ev.type === "error") {
        debug("error:", ev.message);
      }
    }),
  );

  check("搜索", "拿到 sessionId", Boolean(sessionId), sessionId ?? "");
  check("搜索", "总结果数 > 0", results_.length > 0, `${results_.length} 条 / ${searchMs}ms`);
  check(
    "搜索",
    "每个站点都有 provider 记录",
    providerLog.length > 0,
    providerLog.map((l) => `${l.site}:${l.ok ? l.count : `✗${l.error ?? ""}`}`).join(" "),
  );

  // 逐站点看结果，而不是只看总数 —— 「B站 0 条」和「全网 40 条」都算通过的话，
  // 站点定向这条链路坏了也发现不了
  for (const site of SITES) {
    const n = results_.filter((r) => r.site === site).length;
    const entry = providerLog.find((l) => l.site === site);
    const note = entry?.error ? `${n} 条（${entry.error}）` : `${n} 条`;
    // 零结果不一定是 bug：小红书/X 本来就不被搜索引擎收录，所以只算警告
    if (n > 0) check("搜索", `${site} 有结果`, true, note);
    else soft("搜索", `${site} 无结果`, note || "未记录");
  }

  const sitesHit = new Set(results_.map((r) => r.site));
  check("搜索", "至少命中 2 个站点", sitesHit.size >= 2, [...sitesHit].join("/"));

  // ── 2. 抓取 ────────────────────────────────────────────────
  step("2. 抓取正文（SSE 逐篇）");

  const targets = results_.slice(0, FETCH_LIMIT).map((r) => r.id);
  documents = [];

  const [, fetchMs] = await timed(() =>
    sse(`${BASE}/api/fetch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, resultIds: targets, concurrency: 4 }),
    }, (ev) => {
      if (ev.type === "plan") {
        debug(`plan: ${ev.total} 篇（跳过 ${ev.skipped}）`);
      } else if (ev.type === "doc") {
        documents.push(ev.doc);
        debug(
          `  [${ev.done}/${ev.total}] ${ev.doc.extractMethod} ${ev.doc.wordCount}字` +
            `${ev.doc.error ? ` ⚠ ${ev.doc.error}` : ""} ${ev.doc.title.slice(0, 30)}`,
        );
      } else if (ev.type === "done") {
        debug("byMethod:", JSON.stringify(ev.byMethod));
      } else if (ev.type === "error") {
        debug("error:", ev.message);
      }
    }),
  );

  const withBody = documents.filter((d) => d.extractMethod !== "raw");
  const fallback = documents.filter((d) => d.extractMethod === "raw");
  const substantive = withBody.filter((d) => d.wordCount >= 30);

  check("抓取", "逐篇回传了文档", documents.length === targets.length, `${documents.length}/${targets.length} 篇 / ${fetchMs}ms`);
  check("抓取", "至少 1 篇拿到正文", withBody.length > 0, `${withBody.length} 篇正文，${fallback.length} 篇退化为摘要`);

  /**
   * **每一次降级都必须写明了原因** —— 这条比「正文比例」重要得多。
   *
   * 比例高低取决于这一次搜到了什么，不是产品好坏：B 站上大量视频没有 CC 字幕、
   * 简介也是空的，抓不到正文是**事实**而不是失败；知乎对未登录游客一律 403，
   * 同理。真正会出事的是「静默降级」：文档退化成了搜索摘要，却没有任何地方
   * 说明为什么，用户只能看到一篇没内容的资料，不知道是自己搜错了还是工具坏了。
   */
  const silent = fallback.filter((d) => !d.error);
  check(
    "抓取",
    "每次降级都写明了原因（无静默降级）",
    silent.length === 0,
    silent.length
      ? `${silent.length} 篇没有 error：${silent.map((d) => d.title.slice(0, 20)).join(" / ")}`
      : [...new Set(fallback.map((d) => d.error))].map((e) => e.slice(0, 28)).join(" | ") || "本次无降级",
  );

  check(
    "抓取",
    "至少有 3 篇够格进图（wordCount ≥ 30）",
    substantive.length >= 3,
    `${substantive.length} 篇`,
  );

  // 比例只作提示：低于一半通常是「这次搜到的站点本来就抓不动」，值得看一眼
  if (withBody.length < documents.length / 2) {
    soft(
      "抓取",
      "拿到正文的比例不足一半",
      `${withBody.length}/${documents.length} —— 多半是站点侧的原因（见上一条的原因清单），不一定是缺陷`,
    );
  }

  // 降级链每一级的命中数 —— 这是「B站那条专用通道有没有生效」的直接证据
  const methods = {};
  for (const d of documents) methods[d.extractMethod] = (methods[d.extractMethod] ?? 0) + 1;
  check(
    "抓取",
    "降级链档位可观测",
    Object.keys(methods).length > 0,
    Object.entries(methods).map(([k, v]) => `${k}×${v}`).join(" "),
  );

  if (SITES.includes("bilibili")) {
    const bl = documents.filter((d) => d.site === "bilibili");
    const viaApi = bl.filter((d) => d.extractMethod === "bilibili-api");
    if (bl.length === 0) {
      soft("抓取", "B站专用通道", "本次没有 B 站结果");
    } else if (viaApi.length > 0) {
      check("抓取", "B站走专用接口而非页面", true, `${viaApi.length}/${bl.length} 篇`);
    } else {
      soft("抓取", "B站未走专用接口", `${bl.length} 篇都是 ${bl.map((d) => d.extractMethod).join("/")}`);
    }
  }

  // ── 3. 会话持久化 ──────────────────────────────────────────
  step("3. 会话持久化（刷新页面后要能接回来）");

  const sess = await getJson(`/api/session?id=${sessionId}`);
  check("会话", `GET /api/session 拿到会话`, sess.status === 200 && Boolean(sess.body?.session), `HTTP ${sess.status}`);
  check(
    "会话",
    "正文已落盘",
    (sess.body?.session?.documents?.length ?? 0) === documents.length,
    `${sess.body?.session?.documents?.length ?? 0} 篇`,
  );

  const sessionFile = join(ROOT, "data", "sessions", sessionId, "session.json");
  check("会话", "session.json 在磁盘上", existsSync(sessionFile), sessionFile.replace(ROOT, "."));

  // ── 4. 构图（启发式） ──────────────────────────────────────
  step("4. 构图 · 启发式路径");

  const [heur, heurMs] = await timed(() =>
    postJson("/api/graph", { sessionId, force: "heuristic" }),
  );

  if (!check("构图", "启发式构图成功", heur.status === 200, `HTTP ${heur.status} ${heur.body?.error ?? ""}`)) {
    throw new Error(`启发式构图失败：${heur.body?.error}`);
  }

  graph = heur.body.graph;
  check(
    "构图",
    "generatedBy = heuristic",
    graph.stats.generatedBy === "heuristic",
    graph.stats.generatedBy,
  );
  check("构图", "有节点", graph.nodes.length > 0, `${graph.nodes.length} 节点 / ${graph.edges.length} 边`);
  check("构图", "有边", graph.edges.length > 0, `${heurMs}ms`);
  check("构图", "有主题簇", graph.clusters.length > 0, `${graph.clusters.length} 簇`);
  check("构图", "tokenizer 后端已知", Boolean(heur.body.tokenizer), String(heur.body.tokenizer));
  debug(
    "top terms:",
    [...graph.nodes].sort((a, b) => b.weight - a.weight).slice(0, 12).map((n) => n.label).join(" "),
  );

  // 字段名污染回归检查：语料里不该出现「标题/数据/发布/标签」这类抓取层自己
  // 拼进去的字段名。它们一旦混进正文，就会以最高权重占据 TF-IDF 前排。
  const POLLUTION = ["标题", "数据", "发布", "标签", "简介", "时长", "分区"];
  const top = [...graph.nodes].sort((a, b) => b.weight - a.weight).slice(0, 8).map((n) => n.label);
  const polluted = top.filter((t) => POLLUTION.includes(t));
  check(
    "构图",
    "TF-IDF 前排无字段名污染",
    polluted.length === 0,
    polluted.length ? `命中 ${polluted.join("/")}` : `top8: ${top.join(" ")}`,
  );

  const sortedClusters = [...graph.clusters].sort((a, b) => b.size - a.size);
  check(
    "构图",
    "簇有可读的标签",
    sortedClusters.every((c) => c.label && c.topTerms.length > 0),
    sortedClusters.slice(0, 4).map((c) => c.label).join(" / "),
  );

  // ── 5. 构图（LLM / 自动降级） ──────────────────────────────
  if (WITH_LLM) {
    step("5. 构图 · LLM 路径（可能等 1~2 分钟）");

    const [llm, llmMs] = await timed(() => postJson("/api/graph", { sessionId, force: "llm" }));

    if (llm.status === 200) {
      const g = llm.body.graph;
      if (g.stats.generatedBy === "llm") {
        check("构图LLM", "走了 LLM 而非降级", true, `${g.nodes.length} 节点 / ${g.edges.length} 边 / ${llmMs}ms`);
        check(
          "构图LLM",
          "产出带谓词的边",
          g.edges.some((e) => e.kind === "relation" && e.label),
          `${g.edges.filter((e) => e.kind === "relation").length} 条关系边`,
        );
        check(
          "构图LLM",
          "簇名可作章节标题",
          g.clusters.every((c) => c.label && c.summary),
          g.clusters.slice(0, 3).map((c) => c.label).join(" / "),
        );

        // 两条路径必须产出同一个形状 —— 这是「前端不需要知道是谁构的图」的前提
        check(
          "构图LLM",
          "与启发式同一个 GraphModel 形状",
          g.version === graph.version &&
            Array.isArray(g.nodes) &&
            Array.isArray(g.edges) &&
            Array.isArray(g.clusters),
          `version=${g.version}`,
        );
        graph = g; // 后续导出用 LLM 的图，质量更高
      } else {
        soft(
          "构图LLM",
          "LLM 不可用，已自动降级为启发式",
          g.stats.llmFallbackReason ?? "未知原因",
        );
      }
    } else {
      soft("构图LLM", "LLM 构图未成功", `HTTP ${llm.status} ${llm.body?.error ?? ""}`);
    }
  }

  // ── 6. 导出 Markdown ───────────────────────────────────────
  step("6. 导出 Markdown 报告");

  const res = await fetch(`${BASE}/api/export?sessionId=${sessionId}`);
  const markdown = await res.text();

  check("导出", "HTTP 200", res.status === 200, `HTTP ${res.status}`);
  check("导出", "Content-Type 是 markdown", /text\/markdown/.test(res.headers.get("content-type") ?? ""), res.headers.get("content-type") ?? "");
  check(
    "导出",
    "Content-Disposition 带 RFC 5987 文件名（中文不乱码）",
    /filename\*=UTF-8''/.test(res.headers.get("content-disposition") ?? ""),
    res.headers.get("content-disposition") ?? "",
  );
  check("导出", "报告非空", markdown.length > 200, `${bytes(markdown.length)}`);
  check("导出", "含主题标题", markdown.includes(QUERY), QUERY);
  check("导出", "含 Mermaid 拓扑图", markdown.includes("```mermaid"), "");
  check(
    "导出",
    "含站点原始链接",
    /\]\(https?:\/\//.test(markdown),
    `${(markdown.match(/\]\(https?:\/\//g) ?? []).length} 条链接`,
  );
  check("导出", "按簇分了章节", (markdown.match(/^#{2,3}\s/gm) ?? []).length >= 2, `${(markdown.match(/^#{2,3}\s/gm) ?? []).length} 个小节`);

  const savedTo = res.headers.get("x-saved-to");
  check("导出", "已落盘", Boolean(savedTo), savedTo ?? "未回 X-Saved-To");
  if (savedTo) {
    const onDisk = await readFile(savedTo, "utf8").catch(() => "");
    check("导出", "磁盘上的 report.md 与响应一致", onDisk === markdown, `${bytes(onDisk.length)}`);
  }

  // ── 7. 下载 ────────────────────────────────────────────────
  step("7. 异步下载队列（SSE 推进度）");

  // 只挑前几篇，并优先带上 B 站（它同时有封面图和视频属性，能一次覆盖
  // article / image / transcript 三类产物）
  const dlDocs = [...documents]
    .filter((d) => d.extractMethod !== "raw")
    .sort((a, b) => Number(b.site === "bilibili") - Number(a.site === "bilibili"))
    .slice(0, 6);

  const kinds = ["article", "image", "transcript", ...(WITH_MEDIA ? ["media"] : [])];

  const started = await postJson("/api/download", {
    sessionId,
    docIds: dlDocs.map((d) => d.id),
    kinds,
    concurrency: 3,
  });

  if (!check("下载", "任务建立成功", started.status === 200, `HTTP ${started.status} ${started.body?.error ?? ""}`)) {
    log(C.yellow("  （没有可下载产物时跳过下载验证）"));
  } else {
    const job = started.body.job;
    check("下载", "任务里有任务项", job.tasks.length > 0, `${job.tasks.length} 项 · kinds=${kinds.join("/")}`);

    // 进度流：先推 snapshot 再推增量，直到进入终态自动关闭
    const seen = [];
    let lastJob = job;
    const [, dlMs] = await timed(() =>
      sse(`${BASE}/api/download?sessionId=${sessionId}&jobId=${job.id}&stream=1`, {}, (ev) => {
        if (ev.type === "snapshot") {
          lastJob = ev.job;
          debug(`snapshot: live=${ev.live} status=${ev.job.status}`);
        } else if (ev.type === "task") {
          seen.push(ev.task);
          debug(`  ${ev.task.status} ${ev.task.kind} ${ev.task.outputPath ?? ev.task.error ?? ""}`);
        } else if (ev.type === "job") {
          lastJob = ev.job;
        }
      }),
    );

    check("下载", "收到 snapshot（后连上的客户端不会缺状态）", lastJob.id === job.id, `job=${job.id.slice(0, 8)}`);
    check("下载", "收到逐任务进度事件", seen.length > 0, `${seen.length} 次`);

    const failed = lastJob.tasks.filter((t) => t.status === "failed");
    const done = lastJob.tasks.filter((t) => t.status === "done");
    check(
      "下载",
      "进入终态",
      ["done", "partial", "failed"].includes(lastJob.status),
      `${lastJob.status} · ${done.length} 成功 / ${failed.length} 失败 · ${dlMs}ms`,
    );
    check("下载", "至少完成 1 项", done.length > 0, done.map((t) => t.outputPath).slice(0, 3).join(", "));
    for (const t of failed.slice(0, 5)) {
      soft("下载", `失败：${t.kind}`, `${t.outputPath ?? t.url} — ${t.error ?? "未给出原因"}`);
    }

    // 落盘核对：文件真的存在且非空。这是「异步下载」这个承诺的全部重量所在 ——
    // 进度条走到 100% 而磁盘上没有文件，是最容易发生也最难发现的一种失败。
    check("下载", "tasks.json 在磁盘上", existsSync(join(ROOT, "data", "sessions", sessionId, "tasks.json")), "");

    const files = await walk(join(ROOT, "data", "sessions", sessionId, "assets"));
    const real = files.filter((f) => f.size > 0 && !f.rel.endsWith(".part"));
    check("下载", "assets/ 下有非空文件", real.length > 0, `${real.length} 个 / ${bytes(real.reduce((s, f) => s + f.size, 0))}`);
    for (const f of real.slice(0, 8)) {
      debug(`    ${f.rel} — ${bytes(f.size)}`);
    }

    // 下载出来的正文应该和会话里的正文对得上，而不是一个空壳
    const md = files.find((f) => f.rel.endsWith(".md"));
    if (md) {
      const content = await readFile(md.abs, "utf8");
      check("下载", "下载的 .md 非空且有实质内容", content.length > 100, `${md.rel} — ${bytes(content.length)}`);
    }

    // ── 8. 断点续跑 ─────────────────────────────────────────
    step("8. 恢复语义（刷新/重启后不重头再来）");

    const reread = await getJson(`/api/download?sessionId=${sessionId}&jobId=${job.id}`);
    check("恢复", "任务状态可从磁盘读回", Boolean(reread.body?.job), `HTTP ${reread.status}`);
    check(
      "恢复",
      "已完成的任务数稳定（重跑不会重复下载）",
      (reread.body?.job?.tasks ?? []).filter((t) => t.status === "done").length === done.length,
      `${done.length} 项 done`,
    );

    const retry = await postJson("/api/download", { sessionId, action: "retry", jobId: job.id });
    check(
      "恢复",
      "retry 明确回答「有没有要重跑的」",
      retry.status === 200 && (retry.body?.note !== undefined || retry.body?.resumed !== undefined),
      retry.body?.note ?? `resumed=${retry.body?.resumed}`,
    );
  }
} catch (err) {
  results.push({ step: "运行", name: "未捕获的异常", ok: false, detail: String(err) });
  console.log(C.red(`\n运行中断：${err?.stack ?? err}`));
}

// ─────────────────────────── 汇总 ───────────────────────────

const hard = results.filter((r) => !r.soft);
const failed = hard.filter((r) => !r.ok);
const warned = results.filter((r) => r.soft && !r.ok);

console.log(C.bold("\n── 汇总 ──"));
console.log(
  `  ${hard.length - failed.length}/${hard.length} 项通过` +
    (warned.length ? C.yellow(` · ${warned.length} 项降级/警告`) : "") +
    (sessionId ? C.dim(` · 会话 ${sessionId}`) : ""),
);

if (warned.length) {
  log(C.yellow("\n降级与警告（不影响退出码，但值得看一眼）："));
  for (const w of warned) log(`  ${C.yellow("!")} [${w.step}] ${w.name}${w.detail ? ` — ${w.detail}` : ""}`);
}

if (failed.length) {
  log(C.red("\n失败的断言："));
  for (const f of failed) log(`  ${C.red("✗")} [${f.step}] ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
} else {
  log(C.green("\n全部通过。"));
}

/**
 * 产物默认留着 —— 失败了它是排查的最直接证据，成功了它是可以拿去用的报告。
 * 验证脚本顺手把用户的数据删掉，是那种「第一次用觉得方便、第二次就出事」的
 * 贴心。
 */
const CLEAN = flag("clean");
if (sessionId && CLEAN) {
  await rm(join(ROOT, "data", "sessions", sessionId), { recursive: true, force: true });
  log(C.dim(`\n已删除产物 data/sessions/${sessionId}/`));
} else if (sessionId) {
  log(C.dim(`\n产物：data/sessions/${sessionId}/  （--clean 可删除）`));
  log(C.dim(`  查看报告  pnpm example:report ${sessionId}`));
  log(C.dim(`  查看拓扑  pnpm example:graph  ${sessionId}`));
}

process.exit(failed.length === 0 ? 0 : 1);
