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

import { createHash } from "node:crypto";
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
/*
  默认站点与应用自己的 DEFAULT_SITES 对齐（含 web）。

  这里原本只跑 zhihu,bilibili,youtube 三家，理由是「专挑最难的」。但三家都是
  反爬重灾区：知乎游客 403、B站冷门视频没有字幕也没有简介，抓取阶段按
  FETCH_LIMIT 取前 12 条很可能一条正文都拿不到 —— 于是构图 409、脚本中断，
  后面导出和下载两步根本没跑到。这条链路的失败原因每次都不一样，全看当天
  上游给了什么，作为回归门禁不可用。

  加上 web 之后，反爬那三家**照测不误**（下面的站点断言一条没删），
  同时保证抓取阶段一定有料，门禁的成败只反映代码而不是当天的搜索结果。
*/
const SITES = opt("sites", "zhihu,bilibili,youtube,web").split(",").filter(Boolean);
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

/**
 * 列出 ZIP 里的条目名。
 *
 * 自己解而不是引个依赖：这个脚本是「零依赖、能直接 node 跑」的 —— 那是它
 * 能在任何环境里当验收入口的前提。为了一条断言引入解压库不划算。
 *
 * 走**中央目录**而不是扫本地文件头：本地头里可能带 data descriptor（长度写
 * 成 0，真值在后面），扫下去会错位。中央目录是权威的、长度字段是准的。
 */
async function listZipEntries(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const dec = new TextDecoder("utf-8");

  // 从尾部往回找 EOCD（0x06054b50）。注释区最长 64KB，所以只扫这么多。
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("不是合法的 ZIP：找不到 EOCD");

  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const names = [];

  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break; // 中央目录头签名
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    names.push(dec.decode(buf.subarray(p + 46, p + 46 + nameLen)));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

/**
 * 按站点轮流取前 `limit` 条，保持每组内部的原有顺序。
 *
 * 输入已经是融合排序过的列表，所以每组的组内顺序就是「该站点里最该抓的」；
 * 这里只改**组间**的交错方式。结果数量不足时自然截断，不需要补齐。
 */
function interleaveBySite(results, limit) {
  const groups = new Map();
  for (const r of results) {
    const list = groups.get(r.site);
    if (list) list.push(r);
    else groups.set(r.site, [r]);
  }

  const queues = [...groups.values()];
  const out = [];
  for (let i = 0; out.length < limit && i < results.length; i += 1) {
    for (const q of queues) {
      if (i < q.length && out.length < limit) out.push(q[i]);
    }
  }
  return out;
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

  /*
    Playwright 的三态必须能从健康检查里读出来。

    以前只有一个布尔值，于是「用户自己关掉的」和「开着但没装」在界面上一模一样，
    都是一句「未启用」—— 而这两件事该让用户做的事完全不同（前者不用管，后者要么
    装、要么忽略）。所以这里钉的是**措辞**：未安装时必须说「未安装」。

    断言写成「state → 该说的那句话」的配对表，而不是「detail 里得有『未安装』」：
    后者只在**没装**的机器上成立，而这条测试要在三种状态的机器上都跑得通 ——
    它一装上 playwright 就自己红了（本轮实测：装上去之后这条报「已启用（模式：…）」）。
    真正的意图从来不是「必须出现未安装」，而是**三个状态各有各的说法、且说法与
    `state` 对得上**；写成配对表才是这个意图，而且比原来更强 —— 以后谁把两个
    状态合并成一句话，这里立刻就红。
  */
  if (by.playwright) {
    const d = String(by.playwright.detail ?? "");
    const state = by.playwright.state;
    const WORDING = {
      off: "已关闭",
      "not-installed": "未安装",
      ready: "已启用",
    };
    check(
      "健康检查",
      "Playwright 三态可读（关掉 / 没装 / 已启用 分别可辨）",
      d.includes("模式：") || d.includes("PLAYWRIGHT_MODE=off"),
      d,
    );
    check(
      "健康检查",
      "state 与文案对得上（state=ready 就不能说「未启用」）",
      Boolean(state) && WORDING[state] !== undefined && d.includes(WORDING[state]),
      `state=${state} want=「${WORDING[state] ?? "（未知 state）"}」 got=${d}`,
    );
  }

  // ── 1. 搜索 ────────────────────────────────────────────────
  step("1. 搜索（SSE 流式）");

  const results_ = [];
  const providerLog = [];
  let plan = null;
  let relevanceEvent = null;
  let reachedDone = false;

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
      } else if (ev.type === "relevance") {
        relevanceEvent = ev;
        debug(`relevance: ${Object.keys(ev.verdicts).length} 条判定`);
      } else if (ev.type === "done") {
        sessionId = ev.sessionId;
        reachedDone = true;
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

  /*
    查询分析（P12.2）。

    只断言**可观测的**部分：分析结果确实随 `plan` 事件到了，原话被逐字保留，
    且站点数对得上。至于「预览串 == 实际发出的串」—— 那是服务端内部两处
    引用同一份 `plan` 的必然结果，从外部看不到 provider 真正发出的 request，
    所以不在这里假装验证（它由 `route.ts` 里唯一的扇出点保证）。
  */
  check("搜索", "收到查询分析", Boolean(plan?.plan), plan?.plan?.source ?? "无");
  check(
    "搜索",
    "分析保留了用户原话",
    plan?.plan?.raw === QUERY,
    `raw=${JSON.stringify(plan?.plan?.raw)}`,
  );
  check(
    "搜索",
    "预览查询串与站点数一致",
    plan?.queries?.length === SITES.length,
    `${plan?.queries?.length ?? 0}/${SITES.length}`,
  );
  if (plan?.plan?.source === "lexical") {
    // 没配 LLM 时必须**逐字保行为**：一个站点都不许被改写
    check(
      "搜索",
      "未配置 LLM 时不改写任何查询",
      Object.keys(plan.plan.variants ?? {}).length === 0,
      JSON.stringify(plan.plan.variants),
    );
  }

  /*
    相关性判定（P12.3）。断言「每条结果都拿到了一份判定」——
    漏掉的话界面只是少了徽章，不会报错，所以必须在这里钉住。

    **不断言「标出了几条」**：那是数据决定的，不是代码决定的。
    写死一个数字会让这条断言在换了搜索词之后无谓地变红。
  */
  // 判定走的是**独立的 relevance 事件**，不在 `results` 事件里 ——
  // 所以要拿 id 去 verdicts 里对，而不是读 `ev.results[].relevance`
  const verdicts = relevanceEvent?.verdicts ?? {};
  const judged = results_.filter((r) => verdicts[r.id]).length;
  check(
    "搜索",
    "每条结果都拿到了切题判定",
    results_.length > 0 && judged === results_.length,
    `${judged}/${results_.length}`,
  );
  check(
    "搜索",
    "收到了独立的 relevance 事件",
    reachedDone && relevanceEvent,
    relevanceEvent ? `${Object.keys(relevanceEvent.verdicts).length} 条判定` : "没收到",
  );

  // ── 2. 抓取 ────────────────────────────────────────────────
  step("2. 抓取正文（SSE 逐篇）");

  /*
    取前 N 条时必须**按站点轮流取**，不能直接 slice。

    直接 slice 的后果实测过：融合列表按（印证数 → 源内排名）排，而源内排名
    跨来源大量撞号，于是前 12 条很容易被同一个站点整段吃掉 —— 表现就是
    「12 条里 11 条是 B站视频」，而 B站视频天然没有正文（标题 + 标签 + 一句
    简介），抓取阶段于是全军覆没、构图 409、脚本中断。

    轮流取保证每个站点都拿到配额，抓取阶段因此总有几条真正有正文的资料。
    这不只是让测试稳定 —— 它模拟的正是真实用法：用户看的是一份**混合**语料，
    而不是某一个源的回音壁。
  */
  const targets = interleaveBySite(results_, FETCH_LIMIT).map((r) => r.id);
  documents = [];
  let fetchPlan = null;
  let fetchDone = null;

  const [, fetchMs] = await timed(() =>
    sse(`${BASE}/api/fetch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, resultIds: targets, concurrency: 4 }),
    }, (ev) => {
      if (ev.type === "plan") {
        fetchPlan = ev;
        debug(`plan: ${ev.total} 篇（跳过 ${ev.skipped}）`);
      } else if (ev.type === "doc") {
        documents.push(ev.doc);
        debug(
          `  [${ev.done}/${ev.total}] ${ev.doc.extractMethod} ${ev.doc.wordCount}字` +
            `${ev.doc.error ? ` ⚠ ${ev.doc.error}` : ""} ${ev.doc.title.slice(0, 30)}`,
        );
      } else if (ev.type === "done") {
        fetchDone = ev;
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

  /*
    无头浏览器那一级的用量必须是个**数字**，不能是「有/无」。

    界面上要显示「其中 N 篇经无头浏览器渲染」，而配上 `PLAYWRIGHT_MAX_PAGES_PER_RUN`
    的配额之后，N 还可能小于「本该走浏览器的篇数」—— 两个数都得能读到，
    否则用户没法判断「是不是配额卡住了」。
  */
  check(
    "抓取",
    "done 事件报了无头浏览器的用量（byMethod.playwright 是数字）",
    typeof fetchDone?.byMethod?.playwright === "number",
    `playwright=${fetchDone?.byMethod?.playwright}`,
  );

  /*
    显式点名 `resultIds` 时**不做相关性过滤**（P12.4）。

    这一步是有意这么设计的：那条路径就是「手动恢复」——用户自己勾了这几条，
    他的意图优先于任何自动判断。所以这里既检查字段确实报了数，也检查
    「点名即豁免」这条语义没有被后来的改动悄悄绕过。
  */
  check(
    "抓取",
    "plan 事件带 skippedIrrelevant（排除传导可观测）",
    typeof fetchPlan?.skippedIrrelevant === "number",
    `skippedIrrelevant=${fetchPlan?.skippedIrrelevant}`,
  );
  check(
    "抓取",
    "显式点名 resultIds 时不筛相关性（手动恢复路径）",
    fetchPlan?.skippedIrrelevant === 0,
    `点名 ${targets.length} 条，跳过 ${fetchPlan?.skippedIrrelevant} 条 —— 点名路径应为 0`,
  );

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

  /*
    「站点抓取局限」只在**本次真的搜到过**受限站点时才出现 —— 这一轮的 e2e
    查询在一个只有几个站点的集合上跑，命不中很正常，所以是 soft：
    它要防的是「这一节被重构掉了」，不是「这一次没触发」。

    顺带钉一句相反的：这一节出现时，它必须带「不是故障」这个结论。少了这半句，
    它就只是一张重复了「站点分布」的表，白占位置。
  */
  const limitationIdx = markdown.indexOf("## 站点抓取局限");
  check(
    "导出",
    "「站点抓取局限」若出现必须带结论（本轮没搜到受限站点则视为通过）",
    limitationIdx === -1 || /不是故障/.test(markdown.slice(limitationIdx, limitationIdx + 1200)),
    limitationIdx === -1 ? "本轮未触发" : "已出现且带「不是故障」",
  );

  const savedTo = res.headers.get("x-saved-to");
  check("导出", "已落盘", Boolean(savedTo), savedTo ?? "未回 X-Saved-To");
  if (savedTo) {
    const onDisk = await readFile(savedTo, "utf8").catch(() => "");
    check("导出", "磁盘上的 report.md 与响应一致", onDisk === markdown, `${bytes(onDisk.length)}`);
  }

  // ── 6.5 打包 ZIP ───────────────────────────────────────────
  //
  // 关键是**不依赖下载任务**：全新的会话直接请求就该拿到正文。
  // 所以这一步放在第 7 步（下载）之前 —— 如果它要靠下载产物才能过，
  // 顺序一换就会红。
  step("6.5 打包下载 ZIP");

  const pkRes = await fetch(`${BASE}/api/package?sessionId=${sessionId}`);
  const pkBuf = new Uint8Array(await pkRes.arrayBuffer());

  check("打包", "HTTP 200", pkRes.status === 200, `HTTP ${pkRes.status}`);
  check(
    "打包",
    "Content-Type 是 application/zip",
    (pkRes.headers.get("content-type") ?? "").startsWith("application/zip"),
    pkRes.headers.get("content-type") ?? "",
  );
  check(
    "打包",
    "Content-Disposition 带 RFC 5987 文件名",
    /filename\*=UTF-8''/.test(pkRes.headers.get("content-disposition") ?? ""),
    pkRes.headers.get("content-disposition") ?? "",
  );
  // ZIP 的本地文件头魔数。只看状态码的话，一个返回 JSON 错误页的
  // 200 响应也能"通过"。
  check(
    "打包",
    "是合法的 ZIP（本地文件头魔数 PK\\x03\\x04）",
    pkBuf[0] === 0x50 && pkBuf[1] === 0x4b && pkBuf[2] === 0x03 && pkBuf[3] === 0x04,
    pkBuf.length > 0 ? `前四字节 ${[...pkBuf.slice(0, 4)].map((b) => b.toString(16)).join(" ")}` : "空响应",
  );

  const pkList = await listZipEntries(pkBuf);
  /*
    正文文件现在按**内容类型**分目录：`文章/<stem>.md` 与 `视频/<stem>.md`。
    原先的 `正文/` + `字幕/` + `配图/` 是按产物格式分的，对用户没有意义 ——
    他要的是「哪些是视频、哪些是文章」。这是**破坏性改名**。

    正则只数**顶层**的 .md，把 `<stem>/NN.jpg` 那层配图排除掉，
    否则「文件数 == 头」会被配图撑破。
  */
  const pkBody = pkList.filter((n) => /^(文章|视频)\/[^/]+\.md$/.test(n));
  const pkIncluded = Number(pkRes.headers.get("x-package-included") ?? "-1");

  check("打包", "含 报告.md", pkList.includes("报告.md"), `${pkBuf.length} 字节 · ${pkList.length} 个条目`);
  check(
    "打包",
    "含 未收录.md（绝不静默丢东西）",
    pkList.includes("未收录.md"),
    pkList.includes("未收录.md") ? "" : `实际条目：${pkList.slice(0, 8).join(", ")}`,
  );
  check(
    "打包",
    "文章/ + 视频/ 的文件数 == X-Package-Included（与服务端同一判据）",
    pkBody.length === pkIncluded,
    `文章+视频 ${pkBody.length} vs 头 ${pkIncluded}`,
  );
  // 目录名必须是且仅是这两个 —— 多出游离的顶层目录就说明分派漏了一处
  const pkDirs = [...new Set(pkBody.map((n) => n.split("/")[0]))].sort();
  check(
    "打包",
    "正文只落在 文章/ 与 视频/ 下（不再有 正文/ 字幕/ 配图/）",
    pkDirs.every((d) => d === "文章" || d === "视频") && !pkList.some((n) => /^(正文|字幕|配图)\//.test(n)),
    `目录：${pkDirs.join(", ") || "无"}`,
  );
  // 全新会话里够格打包的篇数，正是 e2e 前面抓到的那些
  soft(
    "打包",
    `文章/ + 视频/ 非空 —— ${pkBody.length} 篇`,
    pkBody.length > 0 ? `${pkBody.length} 篇` : "包内没有正文文件（可能是本轮一篇都没抓到完整正文）",
  );
  // 两个目录都出现才算真的分开了；本轮可能一个视频都没抓到，所以是 soft
  soft(
    "打包",
    `文章/ 与 视频/ 都出现 —— ${pkDirs.join(" + ") || "都没有"}`,
    pkDirs.length === 2 ? "两个目录都有内容" : "本轮只抓到一种类型，无法验证分流",
  );

  // ── 6.6 抓取质量回归 ───────────────────────────────────────
  //
  // P11 的核心修复：B 站 /list/ 这类页面上，Readability 抽到的「主内容」是
  // 侧栏的「接下来播放」推荐列表 —— 一千多字，没有一句是这个页面的内容，
  // 却会带着 error: undefined 当成一篇完整资料收下。
  //
  // 这一条直接盯住那个检测器。它是个**纯函数**（没有 import），所以能直接
  // 从 .ts 源码引进来跑。老版本 Node 不认识 .ts（需要类型剥离）时降级为跳过，
  // 不让整个套件因此变红。
  step("6.6 抓取质量回归（导航当正文）");

  let boilerplateReason = null;
  try {
    ({ boilerplateReason } = await import("../src/core/fetch/boilerplate.ts"));
  } catch (err) {
    soft("抓取质量", "能加载 boilerplate.ts", `跳过：当前 Node 不支持直接跑 .ts（${err.message}）`);
  }

  if (boilerplateReason) {
    // 真实样本（data/sessions/Ascj_hG6B6，原样截取）—— 必须拦下
    const junk = [
      "李宏毅 | 大模型（LLM）系列课程入门全集… 7413播放",
      "李宏毅 | Harness Engineer教程… 8117播放",
      "Transformer 逐段精读 1.2万播放",
      "手搓 Transformer 3.4万播放",
    ].join("\n");
    check(
      "抓取质量",
      "拦下「N播放」推荐列表",
      Boolean(boilerplateReason(junk)),
      boilerplateReason(junk) ?? "**漏判了** —— 这正是 P11 要修的那个 bug",
    );

    // 反例：真正文里偶尔提一次播放量是合理的（博主真的在讨论视频数据），
    // 不能因为出现就判成推荐位
    const prose =
      "这篇文章对比了几个主流模型。DeepSeek 那条视频有 1200万播放，" +
      "但播放量高不等于结论可靠，我们更该看它引用的原始论文。";
    check(
      "抓取质量",
      "放过提到播放量的正文",
      boilerplateReason(prose) === null,
      boilerplateReason(prose) ?? "",
    );

    // B 站页面骨架（导航条 / 播放页工具条）
    check(
      "抓取质量",
      "拦下 B 站页面骨架",
      Boolean(boilerplateReason("首页 番剧 直播 游戏中心 会员购\n点赞 投币 收藏 稿件 投诉")),
      "",
    );
  }

  // ── 6.7 相关性判定回归 ─────────────────────────────────────
  //
  // P12.3 的核心判据。用一个**真实反例**（用户会话 bzIgW6vdFj 里那条 ERP
  // 产品的「v4.1.7 发布」）钉住它 —— 这条判据一旦被改松，那 7 条噪音就会
  // 重新混进结果里，而界面上看不出来（它们只是「没被标记」而已）。
  //
  // 词法规则在 `search/relevance.ts` 里，是个**叶子模块**（只 import type），
  // 所以能像 boilerplate.ts 那样直接从 .ts 引入。模型那半边另有文件，不测这里。
  step("6.7 相关性判定回归（反例必须被标出）");

  let lexicalRelevance = null;
  let latinHead = null;
  try {
    ({ lexicalRelevance, latinHead } = await import("../src/core/search/relevance.ts"));
  } catch (err) {
    soft("相关性", "能加载 relevance.ts", `跳过：当前 Node 不支持直接跑 .ts（${err.message}）`);
  }

  if (lexicalRelevance) {
    // 与探针实测出来的那份 plan 同形
    const plan = {
      raw: "DeepSeek-V4.1-Flash",
      intent: "了解 DeepSeek V4.1-Flash 是什么、能力与实测表现如何",
      entity: { name: "DeepSeek-V4.1-Flash", aliases: ["DeepSeek V4.1 Flash"] },
      disambiguators: ["DeepSeek"],
      negatives: ["软件版本号 v4.1.7", "DeepSeek-V3", "DeepSeek-R1"],
      variants: {},
      source: "llm",
    };
    const at = (title, snippet = "") => ({ id: "x", title, snippet });

    check(
      "相关性",
      "词根取到最长的拉丁段（deepseek，而不是 flash）",
      latinHead(plan) === "deepseek",
      `latinHead=${latinHead(plan)}`,
    );

    /*
      反例，逐条都来自真实数据。

      第二条尤其关键：它的摘要里写着「Flash 目前好像正常」，所以**按词命中
      `flash`**。这正是「取最长词根」而不是「取所有 ≥4 字符的词」的理由 ——
      换成后者，它会和真结果一起被判成相关。
    */
    const junk = [
      ["Skyeye 云企业级AI+零代码智能制造系统-ERP、财务、商城板块 - v4.1.7 发布", "采用 SpringBoot+UNI-APP 的零代码平台开发模式"],
      ["[Google Gemini] Gemini 好像用不了了", "Gemini Pro 不管问什么 都拒绝回答。Flash 目前好像正常。"],
      ["$100 预算 + 四个顶级大模型，造出的 PDF 编辑器点几下就露馅", "给 Gemini 3.8 Flash、GPT Astra 6 各 $100 预算"],
      ["无内鬼，又来点大肥鱼梗图", ""],
    ];
    for (const [title, snippet] of junk) {
      const v = lexicalRelevance(at(title, snippet), plan);
      check("相关性", `标出不相关的：${title.slice(0, 22)}…`, v.verdict === "unlikely", `${v.verdict} · ${v.reason}`);
    }

    // 正例：切题的**一条都不许被误杀**。这半边和上面同等重要 ——
    // 判据放宽会漏掉噪音，收紧则会误杀资料，两个方向都得钉
    const good = [
      ["DeepSeek V4.1 Flash 首发实测，吊打自家 Pro 模型？！", ""],
      ["如何使用满血DeepSeek v4 flash正式版 (教材00:28开始)", ""],
      ["【突发】DeepSeek-V4-Flash 正式版 API 上线公测！", ""],
      ["DeepSeek · GitHub", ""],
    ];
    for (const [title, snippet] of good) {
      const v = lexicalRelevance(at(title, snippet), plan);
      check("相关性", `不误杀切题结果：${title.slice(0, 22)}…`, v.verdict !== "unlikely", v.verdict);
    }

    // 中文主题必须**弃权**。实测：「露营装备」整名匹配会把 55 条里的 48 条
    // （含 "Camping Gear Guide"）判成不相关 —— 那是灾难，不是判据
    const cjkPlan = { ...plan, raw: "露营装备", entity: { name: "露营装备", aliases: [] }, negatives: [] };
    check(
      "相关性",
      "中文主题弃权（不做词法判定）",
      lexicalRelevance(at("Camping Gear Guide", ""), cjkPlan).verdict === "uncertain",
      latinHead(cjkPlan) === null ? "没有拉丁词根 → uncertain" : `**latinHead 应为 null，实得 ${latinHead(cjkPlan)}**`,
    );
  }

  // ── 6.8 打包不变量：相关性只降不升 ──────────────────────────
  //
  // P12.4 把 `isPackageWorthy` 从「正文完整」扩成「正文完整 **且** 不疑似跑题」。
  // 这条判据同时决定三处的数字：ZIP 里的正文文件数、`X-Package-Included` 头、
  // 界面上「优质 N 篇」。三者相等唯一的保证就是它们调同一个函数 —— 所以这里
  // 钉住的是**函数本身**，任何一处绕过它去另写条件，都会在这里露馅。
  //
  // 同样重要的是「未判定 ≠ 不相关」：旧会话没有 `relevance` 字段，绝不能
  // 因为「没测过」就被判成坏的。
  step("6.8 打包不变量（相关性只降不升）");

  let isPackageWorthy = null;
  let whyNotPackaged = null;
  try {
    ({ isPackageWorthy, whyNotPackaged } = await import("../src/core/quality.ts"));
  } catch (err) {
    soft("打包不变量", "能加载 quality.ts", `跳过：当前 Node 不支持直接跑 .ts（${err.message}）`);
  }

  if (isPackageWorthy) {
    // 300 字是 FULL_BODY_CHARS 的下限，这里给足，确保走的是 full 分支
    const body = "正文".repeat(200);
    const doc = (over = {}) => ({
      id: "d",
      url: "https://example.com/a",
      title: "t",
      text: body,
      markdown: "",
      wordCount: 400,
      extractMethod: "readability",
      ...over,
    });
    const unlikely = { verdict: "unlikely", reason: "标题与摘要里都没有出现「deepseek」", source: "lexical" };

    check(
      "打包不变量",
      "正文完整 + 疑似跑题 → 不进包",
      isPackageWorthy({ ...doc(), relevance: unlikely }) === false,
      String(isPackageWorthy({ ...doc(), relevance: unlikely })),
    );
    check(
      "打包不变量",
      "正文完整 + 未判定（旧会话无该字段）→ 照常进包",
      isPackageWorthy(doc()) === true && isPackageWorthy({ ...doc(), relevance: undefined }) === true,
      "undefined 必须读成「未判定」而不是「不相关」",
    );
    check(
      "打包不变量",
      "正文完整 + uncertain → 照常进包",
      isPackageWorthy({ ...doc(), relevance: { verdict: "uncertain", reason: "中文主题弃权", source: "lexical" } }) === true,
      "只有判死的 unlikely 才排除",
    );
    check(
      "打包不变量",
      "正文完整 + likely → 进包",
      isPackageWorthy({ ...doc(), relevance: { verdict: "likely", reason: "出现了「deepseek」", source: "lexical" } }) === true,
    );
    check(
      "打包不变量",
      "没进包的原因先讲相关性、再讲正文",
      whyNotPackaged({ ...doc(), relevance: unlikely }).includes("疑似与主题不相关"),
      whyNotPackaged({ ...doc(), relevance: unlikely }),
    );
    check(
      "打包不变量",
      "正文只有摘要时仍按抓取缺陷解释（相关性不背这个锅）",
      whyNotPackaged({ ...doc(), extractMethod: "raw" }).includes("搜索摘要"),
      whyNotPackaged({ ...doc(), extractMethod: "raw" }),
    );
  }

  // ── 6.9 YouTube 机器人墙绕行 ────────────────────────────────
  //
  // 我们的代理出口 IP 被 YouTube 标记，默认 client 一律「Sign in to confirm
  // you're not a bot」。换 android 播放器端点可以过墙，**且不带 cookie、
  // 不登录** —— 这一步钉住那个参数还在，以及它没有被塞进公共的 ytdlpCommonArgs
  // （那就等于给 B 站也发了 youtube 命名空间的东西）。
  //
  // `ytdlp-args.ts` 是零 import 的叶子模块，所以能直接引。
  step("6.9 YouTube 机器人墙绕行（参数存在且已作用域化）");

  let ytdlpYoutubeArgs = null;
  try {
    ({ ytdlpYoutubeArgs } = await import("../src/core/ytdlp-args.ts"));
  } catch (err) {
    soft("YouTube 绕行", "能加载 ytdlp-args.ts", `跳过：当前 Node 不支持直接跑 .ts（${err.message}）`);
  }

  if (ytdlpYoutubeArgs) {
    const args = ytdlpYoutubeArgs();
    const i = args.indexOf("--extractor-args");
    check(
      "YouTube 绕行",
      "带 --extractor-args youtube:player_client=android",
      i >= 0 && args[i + 1] === "youtube:player_client=android",
      args.join(" "),
    );

    // 作用域化：这个函数必须**只**吐 youtube 命名空间的东西，
    // 才能保证 download/kinds.ts 只在 isYoutubeUrl 时才追加它
    const namespaced = args.filter((a) => !a.startsWith("--")).every((a) => a.startsWith("youtube:"));
    check(
      "YouTube 绕行",
      "参数只含 youtube: 命名空间（可以安全地按站点作用域化）",
      namespaced,
      args.join(" "),
    );
  }

  // ── 6.10 视频 / 图文判据 ────────────────────────────────────
  //
  // 这条判据原先写死在 `buildDoc` 里，是**按站点**判的
  // （`site === "youtube" || site === "bilibili" ? video : article`），
  // 于是 B 站的专栏 `/read/` 与图文 `/opus/` 被标成 video —— 而这两类
  // 抓到的是**真正文**。错标的代价是下游去给一篇没有播放器的文章排
  // 「字幕」和「媒体」下载任务，并在包里放进 `字幕/`。
  //
  // 所以这里钉的是**按路径判**而不是按站点判。`core/kind.ts` 是零依赖
  // 叶子模块，可以直接引。
  step("6.10 视频 / 图文判据（按 URL 路径，不按站点）");

  let contentKind = null;
  let packageDirFor = null;
  try {
    ({ contentKind, packageDirFor } = await import("../src/core/kind.ts"));
  } catch (err) {
    soft("类型判据", "能加载 kind.ts", `跳过：当前 Node 不支持直接跑 .ts（${err.message}）`);
  }

  if (contentKind) {
    const cases = [
      // B 站必须按路径分 —— 这是本次修的核心
      ["bilibili", "https://www.bilibili.com/video/BV1xx411c7mD", "video", "视频页"],
      ["bilibili", "https://www.bilibili.com/bangumi/play/ep123456", "video", "番剧"],
      ["bilibili", "https://www.bilibili.com/read/cv1234567", "article", "专栏（真正文）"],
      ["bilibili", "https://www.bilibili.com/opus/713767524046471239", "article", "图文动态（真正文）"],
      ["bilibili", "https://space.bilibili.com/123456", "unknown", "个人空间（抓到的是列表）"],
      ["bilibili", "https://live.bilibili.com/12345", "unknown", "直播间"],
      // 其它站点
      ["youtube", "https://www.youtube.com/watch?v=abc", "video", "YouTube 只有视频"],
      ["zhihu", "https://www.zhihu.com/question/123", "social", "知乎"],
      ["xiaohongshu", "https://www.xiaohongshu.com/explore/abc", "social", "小红书"],
      ["web", "https://example.com/blog/post", "article", "普通博客"],
    ];
    for (const [site, url, want, note] of cases) {
      const got = contentKind(site, url);
      check("类型判据", `${note} → ${want}`, got === want, got === want ? "" : `实得 ${got}`);
    }

    // 下游目录归属：只有 video 进 视频/，其余一律 文章/
    check(
      "类型判据",
      "包内目录：只有 video 进 视频/，其余归 文章/",
      packageDirFor("video") === "视频" &&
        packageDirFor("article") === "文章" &&
        packageDirFor("social") === "文章" &&
        packageDirFor("unknown") === "文章",
      "社交长文与未知类型都归文章侧（它们的正文是文本，进 视频/ 才是错的）",
    );
  }

  /*
    6.11 —— `withTimeout` 的入口同态。

    这里钉的不是「超时能超时」，而是**一个已经 abort 的 signal 传进来时，
    调用方的截止时间不许被丢掉**。旧实现只给它挂一个 `"abort"` 监听器，
    而事件早就发生过了，监听器永远不会触发 —— 于是返回的 signal 只剩自己的
    `ms` 兜底。当一个 deadline 罩住多次调用时（`plan.ts` / `relevance-llm.ts`
    都是这个形状），第二批起就整个失效。

    这个 bug 肉眼看不出来，而且症状是「偶尔慢几分钟」，不是报错。所以必须有断言。
  */
  step("6.11 超时合成的入口同态（已 abort 的 signal 不许丢掉截止时间）");

  let withTimeout = null;
  try {
    ({ withTimeout } = await import("../src/core/timeout.ts"));
  } catch (err) {
    soft("超时合成", "能加载 timeout.ts", `跳过：当前 Node 不支持直接跑 .ts（${err.message}）`);
  }

  if (withTimeout) {
    /** 等 signal abort，最多 cap 毫秒。已在 abort 状态返回 0，等不到返回 -1。 */
    const untilAborted = (signal, cap) =>
      new Promise((res) => {
        if (signal.aborted) return res(0);
        const t0 = Date.now();
        const timer = setTimeout(() => res(-1), cap);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            res(Date.now() - t0);
          },
          { once: true },
        );
      });

    // (a) 核心回归：传进来的 signal 已经 abort
    const dead = AbortSignal.timeout(0);
    await new Promise((r) => setTimeout(r, 20)); // 确保它已经 abort
    const a = withTimeout(dead, 60_000, "测试");
    const aMs = await untilAborted(a.signal, 200);
    a.release();
    check(
      "超时合成",
      "已 abort 的 signal → 立刻同态（不退回 60 秒兜底）",
      dead.aborted && aMs === 0,
      aMs === 0 ? "" : `等了 ${aMs}ms 仍未 abort —— 调用方的截止时间被丢掉了`,
    );

    // (b) 原本的职责不能丢：外部取消要透传
    const ctl = new AbortController();
    const b = withTimeout(ctl.signal, 60_000, "测试");
    const bWasAborted = b.signal.aborted;
    ctl.abort();
    const bMs = await untilAborted(b.signal, 200);
    b.release();
    check(
      "超时合成",
      "外部取消仍然透传（点了取消不该等到超时）",
      !bWasAborted && bMs >= 0,
      bMs >= 0 ? `取消后 ${bMs}ms 内 abort` : "200ms 内没有透传",
    );

    // (c) 没传 signal 时按 ms 超时
    const c = withTimeout(undefined, 120, "测试");
    const cMs = await untilAborted(c.signal, 2_000);
    c.release();
    check(
      "超时合成",
      "没传 signal 时按 ms 超时",
      cMs >= 100 && cMs < 2_000,
      `${cMs}ms`,
    );

    // (d) release() 之后不再超时（定时器确实被清掉了）
    const d = withTimeout(undefined, 300, "测试");
    d.release();
    await new Promise((r) => setTimeout(r, 150));
    check(
      "超时合成",
      "release() 之后不再超时（定时器已清，不会漏）",
      !d.signal.aborted,
      "",
    );
  }

  /*
    6.12 —— 已知站点限制的翻译。

    知乎 109/109 全是「HTTP 403」，那是平台策略而不是故障，但用户看到的和
    「网络超时」一模一样的一句话，于是会去查代理、翻日志。

    这里钉两件事：**该翻译的翻译**（zhihu + 403），以及**不该翻译的绝不翻译**
    （B站接口 500 是真故障；YouTube 没有字幕是真结果）。第二件更要紧 ——
    把真故障贴上「已知限制」的标签，会让用户照着这句话放弃排查。
  */
  step("6.12 已知站点限制（翻译错误，但不粉饰故障）");

  let knownLimitation = null;
  let isKnownLimitation = null;
  try {
    ({ knownLimitation, isKnownLimitation } = await import("../src/core/fetch/limitations.ts"));
  } catch (err) {
    soft("站点限制", "能加载 limitations.ts", `跳过：当前 Node 不支持直接跑 .ts（${err.message}）`);
  }

  if (knownLimitation) {
    // (a) 该翻译的：知乎 403
    const zhihu = knownLimitation("zhihu", "HTTP 403");
    check(
      "站点限制",
      "知乎 403 → 说成「已知限制」而不是「故障」",
      Boolean(zhihu) && zhihu.includes("已知限制") && zhihu.includes("403"),
      zhihu ?? "**没翻译** —— 用户会把它当成一次普通故障去排查",
    );
    check(
      "站点限制",
      "翻译后的文案能被 isKnownLimitation 认回来（未收录.md 的分组靠它）",
      isKnownLimitation(zhihu),
      "",
    );

    // (b) 不该翻译的：真故障 / 真结果，一律返回 null 保留原始文案
    const notLimitations = [
      ["bilibili", "HTTP 500", "B站接口 500 是服务端故障"],
      ["bilibili", "接口返回 code=62002 稿件不可见", "稿件被删是真实结果"],
      ["youtube", "该视频没有可用字幕", "没字幕是真实结果，不是平台限制"],
      ["web", "HTTP 403", "「web」是聚合站点名，403 可能来自任何地方，不该替它下结论"],
      ["zhihu", "超时（15000ms）", "知乎超时是本次的失败，不是平台限制"],
    ];
    for (const [site, error, note] of notLimitations) {
      check(
        "站点限制",
        `${note} → 不翻译`,
        knownLimitation(site, error) === null,
        knownLimitation(site, error) ?? "",
      );
    }

    // (c) 判据要窄：站点与特征必须同时命中
    check(
      "站点限制",
      "站点对不上就不认（同样的 403，换成 web 不算知乎的限制）",
      knownLimitation("web", "HTTP 403") === null && knownLimitation("zhihu", "HTTP 403") !== null,
      "",
    );
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
  // ── 9. 只重抓失败和低质的 ────────────────────────────────
  //
  // 界面上的入口是 DownloadPanel 里那个按钮，它做的事就是**把低质那几篇的
  // id 作为 `resultIds` 再发一次 /api/fetch** —— 所以这里钉的是同一条路径。
  //
  // 最要紧的一条断言是**「不能变少」**：重抓是为了补齐，如果一次重抓反而
  // 让某篇本来完整的正文退化成了摘要（站点这次返回了风控页、超时），
  // 用户就亏了。这种回归不会报错、只会让优质篇数悄悄少几篇，最难发现。
  step("9. 只重抓失败和低质的（点名 resultIds，不重跑全部）");

  let bodyGrade = null;
  try {
    ({ bodyGrade } = await import("../src/core/quality.ts"));
  } catch (err) {
    soft("重抓", "能加载 quality.ts", `跳过：当前 Node 不支持直接跑 .ts（${err.message}）`);
  }

  if (bodyGrade) {
    const lowQualityIds = documents.filter((d) => bodyGrade(d) !== "full").map((d) => d.id);
    const fullBefore = documents.filter((d) => bodyGrade(d) === "full").length;

    if (lowQualityIds.length === 0) {
      soft("重抓", "本次没有低质文档可重抓", "整批都是完整正文 —— 界面上这个按钮同样不会出现");
    } else {
      let refetchPlan = null;
      let refetchedDone = null;

      await sse(
        `${BASE}/api/fetch`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, resultIds: lowQualityIds, concurrency: 4 }),
        },
        (ev) => {
          if (ev.type === "plan") refetchPlan = ev;
          else if (ev.type === "done") refetchedDone = ev;
        },
      );

      // 界面送的就是这 N 个 id，服务端收到的目标数应当**恰好**是这些 ——
      // 多一篇就是「重跑全部」，少一篇就是静默丢东西
      check(
        "重抓",
        "目标数等于低质篇数（既没有重跑全部，也没有漏）",
        refetchPlan?.total === lowQualityIds.length,
        `${refetchPlan?.total}/${lowQualityIds.length} 篇`,
      );
      check(
        "重抓",
        "点名路径不筛相关性（否则「补抓」会被判定结果挡回去）",
        refetchPlan?.skippedIrrelevant === 0,
        `skippedIrrelevant=${refetchPlan?.skippedIrrelevant}`,
      );
      check("重抓", "重抓有收尾事件（不是跑到一半没了）", Boolean(refetchedDone), "");

      const after = await getJson(`/api/session?id=${sessionId}`);
      const fresh = after.body?.session?.documents ?? [];
      const fullAfter = fresh.filter((d) => bodyGrade(d) === "full").length;
      check(
        "重抓",
        "重抓之后完整正文的篇数不下降",
        fresh.length > 0 && fullAfter >= fullBefore,
        `${fullBefore} → ${fullAfter}${fullAfter < fullBefore ? " —— 重抓把已经拿到的正文弄丢了" : ""}`,
      );
    }
  }
  // ── 10. 无头浏览器那条路 ────────────────────────────────
  //
  // 这一级此前**从来没有被执行过**：`ENABLE_PLAYWRIGHT` 默认 false 而
  // node_modules 里也没有这个包，于是「疑似动态渲染 → 无头浏览器」永远为假，
  // SPA 站点静默退化成摘要。P13.3 三态化之后它会自己生效，所以这里要真跑一次。
  //
  // 用**本机夹具**而不是某个真实 SPA 站点：真实站点的渲染取决于它的接口、
  // 登录墙、反爬策略 —— 它们一变，红的是我们的测试，而不是我们的代码。
  // 夹具是一个确定的 JS 空壳（静态 HTML 里 0 字正文，全部由脚本写入），
  // 只要浏览器真的打开并执行了脚本，就必然拿到正文。
  //
  // 顺带钉住一个真 bug（本轮实测发现）：`shouldProxy()` 只认国内域名，
  // 于是 `127.0.0.1` 被当成境外站点塞进代理，拿到的是代理的 502 页 ——
  // 而那个错误页会被读成「渲染了但没有正文」。所以夹具走的是 loopback，
  // 它一旦被代理，这一步就会红。
  step("10. 无头浏览器渲染（本机 JS 空壳夹具）");

  if (by.playwright?.state !== "ready") {
    soft(
      "无头浏览器",
      "装好 playwright + chromium 才能验证这一级",
      `当前状态：${by.playwright?.state ?? "未知"} · ${by.playwright?.detail ?? ""}`,
    );
  } else {
    const { createServer } = await import("node:http");
    const { mkdirSync, writeFileSync } = await import("node:fs");

    const MARKER = "脚本渲染出来的正文";
    const fixtureHtml = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>夹具：前端渲染</title></head><body><div id="root"></div><script>
setTimeout(function(){var p=[];for(var i=1;i<=12;i++){p.push('<p>第 '+i+' 段：知识拓扑把一批资料里的概念与关系摊开。这一段只存在于脚本渲染的结果里，静态 HTML 里没有它。</p>');}
document.getElementById('root').innerHTML='<article><h1>${MARKER}</h1>'+p.join('')+'</article>';},50);
</script></body></html>`;

    const server = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(fixtureHtml);
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    const fixtureUrl = `http://127.0.0.1:${port}/spa.html`;

    // 会话用一个固定目录名，且 topic.id 与目录名一致 —— `saveSession` 是按
    // topic.id 定位目录的，两者不一致会写到别的会话上去
    const fixtureSession = "E2E-PWSPA";
    const fixtureId = createHash("sha1").update(fixtureUrl).digest("hex").slice(0, 16);
    const fixtureDir = join(ROOT, "data", "sessions", fixtureSession);
    mkdirSync(join(fixtureDir, "assets"), { recursive: true });
    writeFileSync(
      join(fixtureDir, "session.json"),
      JSON.stringify(
        {
          topic: {
            id: fixtureSession,
            query: "无头浏览器路径验证",
            sites: ["web"],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          results: [
            {
              id: fixtureId,
              title: "夹具：前端渲染的页面",
              url: fixtureUrl,
              snippet: "静态 HTML 里没有正文。",
              domain: "127.0.0.1",
              site: "web",
              provider: "searxng",
              rank: 1,
              hitCount: 1,
              sources: ["searxng"],
            },
          ],
          documents: [],
          providerLog: [],
        },
        null,
        2,
      ),
      "utf8",
    );

    let fixtureDoc = null;
    try {
      await sse(
        `${BASE}/api/fetch`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: fixtureSession, resultIds: [fixtureId] }),
        },
        (ev) => {
          if (ev.type === "doc") fixtureDoc = ev.doc;
        },
      );
    } finally {
      await new Promise((r) => server.close(r));
    }

    check(
      "无头浏览器",
      "真的用无头浏览器拿到了正文（extractMethod = playwright）",
      fixtureDoc?.extractMethod === "playwright",
      fixtureDoc
        ? `${fixtureDoc.extractMethod} / ${fixtureDoc.wordCount} 字 / ${fixtureDoc.extractMs}ms` +
          `${fixtureDoc.error ? ` / ${fixtureDoc.error}` : ""}`
        : "没有收到 doc 事件",
    );
    check(
      "无头浏览器",
      "拿到的是脚本渲染出来的内容（静态 HTML 里没有它）",
      typeof fixtureDoc?.text === "string" && fixtureDoc.text.includes(MARKER),
      `${fixtureDoc?.text?.length ?? 0} 字`,
    );
    check(
      "无头浏览器",
      "这一篇没有降级、没有 error",
      Boolean(fixtureDoc) && !fixtureDoc.error,
      fixtureDoc?.error ?? "",
    );

    /*
      夹具会话用完即删。它不是「产物」，是脚手架 —— 留着会出现在用户的
      会话列表里（标题叫「无头浏览器路径验证」），下次打开界面得自己认一下
      这是什么。失败时也不留：三条断言各自的 detail 里已经带着 extractMethod、
      字数、error 原文，那才是排查要看的，一个 session.json 不比它多。
    */
    await rm(fixtureDir, { recursive: true, force: true });
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
