/**
 * Markdown 报告生成。
 *
 * 报告的主线是「簇」而不是「资料列表」。平铺几百条搜索结果，用户拿到的只是
 * 一份书签；按主题簇分章节，每一章回答「这个方向在讲什么、有哪些资料支撑」，
 * 才是一份能读的调研结论文档。
 *
 * 因此顺序是：概览 → 拓扑图 → 分簇章节 → 附录（全量来源、未参与构图的资料、
 * 检索日志）。附录里的每一项都是刻意保留的：「搜到了但没抓到正文」本身就是
 * 一条信息，静默丢掉会让报告看起来比实际更完整。
 *
 * 输出目标是 Obsidian / GitHub / GitLab 这类渲染器，所以只用它们的公共子集：
 * 标题、表格、引用块、围栏代码块、Mermaid。不用 HTML 标签和脚注。
 */

import type { Document, GraphModel, SearchResult, Session } from "@/core/types";
import { siteLabel } from "@/core/search/sites";
import { clusterColor, clusterIndexMap } from "@/core/graph/palette";

export interface MarkdownOptions {
  /**
   * 生成时间。由调用方传入而不是就地取 —— 报告里的每处日期都来自它，
   * 传固定值就能得到可复现的输出（写测试、比对两次导出的差异都要靠这个）。
   */
  now?: Date;
  /**
   * 是否输出 Mermaid 拓扑图。默认输出。
   * 少数渲染器不认 Mermaid 且会把代码块内容原样显示，那种场合关掉更干净。
   */
  includeMermaid?: boolean;
  /** 是否带上站点的原始链接。默认带上。 */
  includeUrls?: boolean;
}

export function renderMarkdownReport(
  session: Session,
  opts: MarkdownOptions = {},
): string {
  const { topic, results, documents, graph, providerLog } = session;
  const now = opts.now ?? new Date();
  const includeUrl = opts.includeUrls ?? true;

  const docById = new Map(documents.map((d) => [d.id, d]));
  /** 真正参与了构图的文档。以图里的 document 节点为准，而不是重算一遍过滤条件。 */
  const graphedDocIds = new Set(
    (graph?.nodes ?? [])
      .filter((n) => n.kind === "document")
      .flatMap((n) => n.docIds),
  );

  const out: string[] = [];

  const withContent = documents.filter((d) => d.extractMethod !== "raw").length;

  out.push(frontmatter(session, now));
  out.push(`# ${topic.query} · 主题资料报告`);
  // 三个数字分别说清楚：搜到多少、其中抓到正文多少、最终进图多少。
  // 只写「抓取 71 篇」会把 28 篇只有摘要的也算成正文，读者据此判断
  // 资料完整度就会出错。
  out.push(
    `> 生成于 ${formatDateTime(now)}，检索 ${results.length} 条结果，` +
      `${withContent} 篇拿到正文，${graphedDocIds.size} 篇参与构图。`,
  );

  // 站点清单放在最前面：读者需要先知道这份报告的搜索范围，
  // 才能判断「某方向没有资料」是真的没有，还是压根没搜。
  out.push(`**检索站点**：${topic.sites.map(siteLabel).join("、")}`);

  out.push(overview(session, graphedDocIds.size));
  out.push(siteDistribution(session));

  if (graph && graph.clusters.length > 0 && opts.includeMermaid !== false) {
    out.push(topologyGraph(graph));
  }

  if (graph && graph.clusters.length > 0) {
    out.push(clusterSections(graph, docById, includeUrl));
  } else {
    out.push(flatSection(documents, includeUrl));
  }

  out.push(fullSourceList(session, graphedDocIds, includeUrl));

  const unused = documents.filter((d) => !graphedDocIds.has(d.id));
  if (unused.length > 0) {
    out.push(unusedSection(unused));
  }

  if (providerLog.length > 0) {
    out.push(providerLogSection(session));
  }

  out.push(footer(graph));

  // 段落之间统一空一行，最后收成单个换行 —— 文件末尾多几个空行会让
  // git diff 变脏，而对渲染没有任何影响
  return out.filter((s) => s.trim().length > 0).join("\n\n") + "\n";
}

// ─────────────────────────── 各章节 ───────────────────────────

/**
 * YAML frontmatter。
 *
 * 字符串值一律走 JSON.stringify：它对双引号、反斜杠、换行的转义规则正好是
 * YAML 双引号标量的子集，所以「用户输入的标题里有冒号或引号」这种最容易
 * 破坏 frontmatter 的情况不需要单独处理。
 */
function frontmatter(session: Session, now: Date): string {
  const { topic, results, documents, graph } = session;
  const lines = [
    "---",
    `topic: ${JSON.stringify(topic.query)}`,
    `generated: ${JSON.stringify(now.toISOString())}`,
    `sites: [${topic.sites.map((s) => JSON.stringify(s)).join(", ")}]`,
    `results: ${results.length}`,
    `documents: ${documents.length}`,
  ];
  if (graph) {
    lines.push(
      "graph:",
      `  nodes: ${graph.stats.nodeCount}`,
      `  edges: ${graph.stats.edgeCount}`,
      `  clusters: ${graph.stats.clusterCount}`,
      `  generatedBy: ${graph.stats.generatedBy}`,
    );
  }
  lines.push("---");
  return lines.join("\n");
}

function overview(session: Session, graphedCount: number): string {
  const { results, documents, graph } = session;
  const withContent = documents.filter((d) => d.extractMethod !== "raw").length;

  const rows: [string, string][] = [
    ["搜索结果", `${results.length} 条`],
    ["抓取正文", `${withContent} 篇（另 ${documents.length - withContent} 篇仅拿到摘要）`],
    ["参与构图", `${graphedCount} 篇`],
  ];

  if (graph) {
    rows.push(
      ["概念节点", `${graph.stats.nodeCount - graphedCount} 个`],
      ["共现关系", `${graph.stats.edgeCount} 条`],
      ["主题簇", `${graph.stats.clusterCount} 个`],
      [
        "构图方式",
        graph.stats.generatedBy === "llm"
          ? "LLM 语义抽取"
          : "本地启发式（分词 + TF-IDF + 共现 + Louvain）",
      ],
    );
    if (graph.stats.llmFallbackReason) {
      rows.push(["降级原因", graph.stats.llmFallbackReason]);
    }
  }

  const body = ["## 概览", "", "| 指标 | 数值 |", "| --- | --- |"];
  for (const [k, v] of rows) body.push(`| ${k} | ${escapeCell(v)} |`);
  return body.join("\n");
}

function siteDistribution(session: Session): string {
  const docByUrl = new Map(session.documents.map((d) => [d.url, d]));
  const tally = new Map<string, { results: number; withContent: number }>();

  for (const r of session.results) {
    const t = tally.get(r.site) ?? { results: 0, withContent: 0 };
    t.results++;
    const doc = docByUrl.get(r.url);
    if (doc && doc.extractMethod !== "raw") t.withContent++;
    tally.set(r.site, t);
  }

  const body = [
    "## 站点分布",
    "",
    // 「结果」与「有正文」分列，是因为这两个数经常差得很远：
    // 知乎能搜到但抓不到正文，这个差距必须让读者看见。
    "| 站点 | 搜索结果 | 拿到正文 |",
    "| --- | --- | --- |",
  ];
  for (const [site, t] of [...tally.entries()].sort(
    (a, b) => b[1].results - a[1].results,
  )) {
    body.push(`| ${siteLabel(site)} | ${t.results} | ${t.withContent} |`);
  }
  return body.join("\n");
}

/**
 * 拓扑图。
 *
 * 刻意只画到簇这一层，不画完整的节点图：103 个节点 / 877 条边的 Mermaid
 * 图在 GitHub 上会糊成一团黑，而且文件大到难读。簇之间的连线按跨簇共现的
 * 次数加权 —— 读者要的是「哪几个方向关系近」，不是「每个词连了谁」，
 * 后者去交互界面看更合适。
 */
function topologyGraph(graph: GraphModel): string {
  const index = clusterIndexMap(graph.clusters);
  const nodeCluster = new Map(
    graph.nodes.map((n) => [n.id, n.clusterId] as const),
  );

  // 跨簇共现计数。簇内边不计 —— 那正是「簇」的定义，画出来只是噪音。
  const cross = new Map<string, number>();
  for (const e of graph.edges) {
    if (e.kind !== "cooccur") continue;
    const a = nodeCluster.get(e.source);
    const b = nodeCluster.get(e.target);
    if (!a || !b || a === b) continue;
    const key = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
    cross.set(key, (cross.get(key) ?? 0) + 1);
  }

  // 只保留最强的若干条跨簇关系，否则簇一多连线就会盖住节点
  const links = [...cross.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 16);

  const lines = ["## 知识拓扑", "", "```mermaid", "graph LR"];

  for (const [i, c] of graph.clusters.entries()) {
    // 第二行放规模而不是再列一遍词：c.label 本身就是 topTerms 前三个拼的，
    // 复述一遍只会让节点变成一行重复文字。
    const stats = `${c.size} 概念 / ${c.docIds.length} 资料`;
    lines.push(`  ${c.id}["${mermaidText(c.label)}<br/>${stats}"]`);
    // 样式类名用 k0/k1 而不是 c0/c1：节点 id 已经是 c0，写成 `class c0 c0`
    // 语法上成立但极易读错，也让某些版本的解析器产生歧义。
    // 配色与交互界面一致，两处对得上才不会让人怀疑看的是两份数据。
    lines.push(
      `  classDef k${i} fill:${clusterColor(i)},stroke:${clusterColor(i)},color:#0d1117`,
    );
    lines.push(`  class ${c.id} k${i}`);
  }

  for (const [key, count] of links) {
    const [a, b] = key.split("\u0000");
    lines.push(`  ${a} ---|${count}| ${b}`);
  }

  lines.push("```", "", "连线上的数字是两个簇之间跨簇共现的词对数量，越高说明方向越接近。");
  return lines.join("\n");
}

/** 每个簇最多列多少篇资料。超出部分靠附录 A 的完整清单兜底。 */
const DOCS_PER_CLUSTER = 10;

/** 一个簇至少占一篇资料多少比重，才认为这篇资料属于这个方向。 */
const MIN_CLUSTER_SHARE = 0.2;

interface DocAffinity {
  /** 簇 id → 该簇关键词在这篇资料里的 tf-idf 之和。 */
  byCluster: Map<string, number>;
  /** 这篇资料全部关键词的 tf-idf 之和，用作分母。 */
  total: number;
}

/**
 * 资料对各个簇的「亲和度」。
 *
 * 分子是 Σ (词权重 × 该词在这篇文档里的词频)——数据全在图上：节点权重就是
 * TF-IDF 权重，contains 边的权重是 1+tf，不必重算。
 *
 * 关键在于除以这篇资料自己的总分。第一版用的是不除的绝对分，结果四个簇
 * 列出来的是几乎同一批资料：关键词多的文档在每个簇里分都高，于是排序退化成
 * 「谁长谁靠前」。除掉之后得到的是「这篇资料有多大比例在讲这个方向」——
 * 通用清单类文章（横跨所有簇）比重被摊薄，真正聚焦的资料才浮上来。
 *
 * 也不用「把资料归到唯一的主簇」：这份语料 60 个概念里 40 个在同一个簇，
 * 「包含哪个簇的词最多」几乎总指向那个大簇（实测 43 篇里 38 篇被判给它），
 * 另外两个簇一条资料都没有。而且一篇讲奢华露营的资料本来就同属于「高端
 * 玩法」和「装备」，硬性二选一只是把信息丢掉。
 */
function docAffinities(graph: GraphModel): Map<string, DocAffinity> {
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const out = new Map<string, DocAffinity>();

  for (const e of graph.edges) {
    if (e.kind !== "contains") continue;
    const doc = nodeById.get(e.source);
    const kw = nodeById.get(e.target);
    if (!doc || !kw || doc.kind !== "document") continue;

    for (const docId of doc.docIds) {
      const entry = out.get(docId) ?? { byCluster: new Map(), total: 0 };
      const score = kw.weight * e.weight;
      entry.byCluster.set(kw.clusterId, (entry.byCluster.get(kw.clusterId) ?? 0) + score);
      entry.total += score;
      out.set(docId, entry);
    }
  }

  return out;
}

function clusterSections(
  graph: GraphModel,
  docById: Map<string, Document>,
  includeUrl: boolean,
): string {
  const sections: string[] = ["## 主题分簇"];
  const affinities = docAffinities(graph);

  for (const [i, c] of graph.clusters.entries()) {
    const ranked: { docId: string; share: number }[] = [];
    for (const [docId, aff] of affinities) {
      if (!docById.has(docId) || aff.total <= 0) continue;
      const share = (aff.byCluster.get(c.id) ?? 0) / aff.total;
      if (share >= MIN_CLUSTER_SHARE) ranked.push({ docId, share });
    }
    ranked.sort((a, b) => b.share - a.share);

    const shown = ranked.slice(0, DOCS_PER_CLUSTER);
    const rest = ranked.length - shown.length;

    const body: string[] = [`### ${i + 1}. ${c.label}`, "", `> ${c.summary}`];

    if (c.topTerms.length) {
      body.push(
        "",
        `**核心概念**：${c.topTerms.map((t) => `\`${t}\``).join(" ")}`,
      );
    }

    if (shown.length === 0) {
      body.push(
        "",
        `_没有资料以这一方向为主（占比都不足 ${MIN_CLUSTER_SHARE * 100}%）。_`,
      );
    } else {
      body.push(
        "",
        `**以本方向为主的资料**（${shown.length} 篇${
          rest > 0 ? `，另有 ${rest} 篇相关度较低` : ""
        }）`,
        "",
      );
      shown.forEach(({ docId, share }, n) => {
        const d = docById.get(docId)!;
        body.push(`${n + 1}. ${docHeading(d, includeUrl)}`);
        // 占比写出来而不是只排序：读者据此能判断这篇资料有多聚焦，
        // 62% 和 21% 都排在同一张表里，不写出来就分不清。
        body.push(`   ${docMetaLine(d)} · 本方向占比 ${Math.round(share * 100)}%`);
        if (d.excerpt) {
          body.push(`   > ${escapeBlockquote(d.excerpt)}`);
        }
        body.push("");
      });
    }

    sections.push(body.join("\n").trimEnd());
  }

  return sections.join("\n\n");
}

/** 没有图时退化成一份按站点分组的资料清单，至少保证报告能出。 */
function flatSection(docs: Document[], includeUrl: boolean): string {
  if (docs.length === 0) {
    return "## 资料\n\n_本次没有抓取到任何正文。_";
  }
  const body = ["## 资料", ""];
  docs
    .slice()
    .sort((a, b) => b.wordCount - a.wordCount)
    .forEach((d, n) => {
      body.push(`${n + 1}. ${docHeading(d, includeUrl)}`);
      body.push(`   ${docMetaLine(d)}`);
      if (d.excerpt) body.push(`   > ${escapeBlockquote(d.excerpt)}`);
      body.push("");
    });
  return body.join("\n").trimEnd();
}

/**
 * 全量来源附录。
 *
 * 这里收的是搜索结果而不是文档：报告正文只呈现能支撑论点的那部分，
 * 而「搜过什么」必须完整留档，否则读者无法判断有没有漏掉某个方向。
 */
function fullSourceList(
  session: Session,
  graphedDocIds: Set<string>,
  includeUrl: boolean,
): string {
  const docByUrl = new Map(session.documents.map((d) => [d.url, d]));

  const body = [
    "## 附录 A · 全量来源",
    "",
    "| # | 标题 | 站点 | 正文 |",
    "| --- | --- | --- | --- |",
  ];

  session.results.forEach((r, i) => {
    const doc = docByUrl.get(r.url);
    const title = includeUrl
      ? `[${escapeLinkText(r.title || r.url)}](${r.url})`
      : escapeCell(r.title || r.url);
    const content = !doc
      ? "未抓取"
      : doc.extractMethod === "raw"
        ? "仅摘要"
        : `${doc.wordCount} 字`;
    body.push(
      `| ${i + 1} | ${escapeCell(title)} | ${siteLabel(r.site)} | ${content} |`,
    );
  });

  return body.join("\n");
}

function unusedSection(unused: Document[]): string {
  const byMethod = new Map<Document["extractMethod"], number>();
  for (const d of unused) {
    byMethod.set(d.extractMethod, (byMethod.get(d.extractMethod) ?? 0) + 1);
  }

  const body = [
    "## 附录 B · 未参与构图的资料",
    "",
    "这些资料没有进入拓扑图，原因见下表。列出来而不是丢掉，是因为",
    "「搜到了但只有摘要」本身会影响对资料完整度的判断。",
    "",
    "| 标题 | 站点 | 原因 |",
    "| --- | --- | --- |",
  ];

  for (const d of unused.slice(0, 100)) {
    const reason =
      d.extractMethod === "raw"
        ? "正文没抓到，只有搜索摘要"
        : `正文过短（${d.wordCount} 字）`;
    body.push(
      `| [${escapeLinkText(d.title || d.url)}](${d.url}) | ${siteLabel(d.site)} | ${reason} |`,
    );
  }

  if (unused.length > 100) {
    body.push("", `_另有 ${unused.length - 100} 篇未列出。_`);
  }

  const breakdown = [...byMethod.entries()]
    .map(([m, n]) => `${methodName(m)} ${n} 篇`)
    .join("、");
  body.push("", `合计 ${unused.length} 篇（${breakdown}）。`);
  return body.join("\n");
}

/**
 * 检索日志附录。
 *
 * 这是整份报告里最容易被忽略、却最能省时间的一节：它直接回答了
 * 「为什么某个站点一片空白」—— 是没命中，还是被挡了，还是压根没搜。
 */
function providerLogSection(session: Session): string {
  const body = [
    "## 附录 C · 检索日志",
    "",
    "| 提供方 | 站点 | 结果 | 耗时 | 状态 |",
    "| --- | --- | --- | --- | --- |",
  ];

  for (const l of session.providerLog) {
    const status = l.ok
      ? l.count > 0
        ? "正常"
        : "无命中"
      : `失败：${escapeCell(l.error ?? "未知原因")}`;
    body.push(
      `| ${l.provider} | ${siteLabel(l.site)} | ${l.count} | ${l.ms}ms | ${status} |`,
    );
  }
  return body.join("\n");
}

function footer(graph: GraphModel | undefined): string {
  const lines = [
    "---",
    "",
    "本报告由 muti-eye 自动生成：搜索引擎负责发现，站点适配器负责抓取正文，",
    "分词与共现分析负责组织结构。仅访问公开页面，不使用任何登录态。",
  ];
  if (graph?.stats.llmFallbackReason) {
    lines.push("", `本次构图的 LLM 路径未生效，已降级为本地启发式：${graph.stats.llmFallbackReason}`);
  }
  return lines.join("\n");
}

// ─────────────────────────── 格式化辅助 ───────────────────────────

function docHeading(d: Document, includeUrl: boolean): string {
  const title = escapeLinkText(d.title || d.url);
  return includeUrl ? `**[${title}](${d.url})**` : `**${title}**`;
}

function docMetaLine(d: Document): string {
  const parts = [siteLabel(d.site)];
  if (d.author) parts.push(d.author);
  if (d.publishedAt) parts.push(d.publishedAt.slice(0, 10));
  parts.push(`${d.wordCount} 字`);
  parts.push(methodName(d.extractMethod));
  if (d.error) parts.push(`（${d.error}）`);
  return parts.join(" · ");
}

function methodName(m: Document["extractMethod"]): string {
  switch (m) {
    case "readability":
      return "正文提取";
    case "playwright":
      return "无头浏览器";
    case "ytdlp-subtitle":
      return "视频字幕";
    case "bilibili-api":
      return "B站接口";
    case "raw":
      return "仅摘要";
  }
}

/**
 * 站点名取自站点注册表，而不是在 UI 里另立一套。
 *
 * 注意 UI 的芯片用的是更短的名字（「B 站」而不是「哔哩哔哩」）——
 * 那是空间受限场合的展示名，与报告正文里的正式名是两种用途，不算重复。
 */

function formatDateTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}`
  );
}

/**
 * 表格单元格转义。
 *
 * 竖线是表格的分隔符，标题里出现一个就会把整行拆错列 —— 这是标题里
 * 最常见的特殊字符（「A | B」这种写法在中文标题里很常见）。
 * 换行同理，会把一行表格撕成两行。
 */
function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** 链接文字：方括号会提前闭合链接，反斜杠要转义。 */
function escapeLinkText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/\r?\n/g, " ");
}

/** 引用块里每行都要带 `>`，否则第二行会掉出引用块。 */
function escapeBlockquote(s: string): string {
  const oneLine = s.replace(/\s*\r?\n\s*/g, " ").trim();
  return oneLine.length > 300 ? oneLine.slice(0, 300) + "…" : oneLine;
}

/**
 * Mermaid 节点文字转义。
 *
 * 方括号和引号都会破坏 `id["文字"]` 的语法，`·` 之类的中文标点则没问题。
 * 换成全角括号比反斜杠转义更稳 —— Mermaid 对转义的支持在各版本间并不一致。
 */
function mermaidText(s: string): string {
  return s
    .replace(/["`]/g, "")
    .replace(/\[/g, "(")
    .replace(/\]/g, ")")
    .replace(/\r?\n/g, " ");
}

/** 供 /api/export 生成下载文件名。 */
export function reportFileName(topic: string, now = new Date()): string {
  // 去掉路径分隔符与控制字符 —— 文件名会进 Content-Disposition 头
  const safe = topic.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "").trim() || "report";
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  return `${safe}-${stamp}.md`;
}
