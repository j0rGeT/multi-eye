/**
 * 打包：把一次调研的成果压成一个 ZIP。
 *
 * ── 为什么不复用下载队列 ──
 *
 * 下载队列要求用户先点「开始下载」，否则 `assets/` 是空的，包也就空了。
 * 那就不是「页面直接下载」了。所以这里**现场生成**：正文与报告都是
 * `session.json` 的纯函数，不联网、不会失败；只有配图是二进制，必须从
 * `assets/` 读 —— 有就装，没有就跳过，并在包里说明。
 *
 * ── 包里装什么 ──
 *
 *   报告.md              整篇调研报告（含拓扑图与全部来源链接）
 *   文章/<stem>.md       每篇**优质**的图文/社交长文
 *   文章/<stem>/NN.jpg   它的配图（从 assets/<stem>.images/ 拷来）
 *   视频/<stem>.md       每篇**优质**视频的资料页
 *   视频/<stem>.txt      字幕（doc.text 对视频就是字幕本身）
 *   视频/<stem>/NN.jpg   它的封面/截图
 *   未收录.md            被排除的那些，逐条写明为什么
 *
 * ── 目录为什么按「文章 / 视频」分（破坏性改名）──
 *
 * 原先是 `正文/` + `字幕/` + `配图/`，按**产物的格式**分。那对用户没有
 * 意义：他想知道的是「这堆东西里哪些是视频、哪些是文章」，而不是
 * 「哪些是 markdown、哪些是 jpg」。所以改为按**内容类型**分，判据来自
 * `core/kind.ts` —— 与抓取链、界面、报告同源，不会各说各话。
 *
 * 这是**破坏性改名**：读 ZIP 的脚本如果按 `正文/` 取文件，需要改。
 *
 * ── 媒体文件（.mp4 等）不在包里 ──
 *
 * 媒体体积远超配图，且用户多半只要资料与字幕。它们留在会话目录的
 * `assets/<stem>.media/` 下，不塞进 ZIP。
 *
 * `未收录.md` 不是可选项。用户对低质资料的选择是「保留并标注，但不进包」，
 * 那么包本身就得说清楚少了什么、为什么少 —— 否则「包里只有 16 篇」和
 * 「我们静默丢了 52 篇」在用户眼里是一样的。
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { zipSync } from "fflate";
import type { Document, Session } from "@/core/types";
import { assetsDir } from "@/core/store";
import { isPackageWorthy, whyNotPackaged } from "@/core/quality";
import { fileStem } from "@/core/download/kinds";
import { DOC_KIND_LABELS, docKind, packageDirFor } from "@/core/kind";
import { renderMarkdownReport, reportFileName } from "./markdown";
import { renderDocMarkdown, renderDocTranscript } from "./docmarkdown";

/**
 * 配图的体积上限。
 *
 * 配图是唯一进包的大块数据 —— 正文与报告都在百 KB 级。`zipSync` 会一次性
 * 把输入和输出都放进内存（峰值约 2×），所以这道闸的意义是别让一次点击
 * 把进程撑爆。超了就**拒绝并说清楚**，而不是悄悄少装几张图。
 */
export const MAX_IMAGE_BYTES = 200 * 1024 * 1024;

export interface PackageOk {
  ok: true;
  zip: Uint8Array;
  /** 文件名（含 .zip）。 */
  filename: string;
  included: number;
  excluded: number;
  /** 有配图可下、但 assets/ 里还没有的篇数。 */
  imagesMissing: number;
}

export interface PackageErr {
  ok: false;
  status: number;
  error: string;
}

export type PackageResult = PackageOk | PackageErr;

export async function buildPackage(
  session: Session,
  sessionId: string,
  now = new Date(),
): Promise<PackageResult> {
  if (session.results.length === 0) {
    return {
      ok: false,
      status: 409,
      error: "该会话还没有搜索结果，没有可打包的内容",
    };
  }

  const included = session.documents.filter(isPackageWorthy);
  const excluded = session.documents.filter((d) => !isPackageWorthy(d));

  const files: Record<string, Uint8Array> = {};
  const encoder = new TextEncoder();
  const putText = (path: string, text: string) => {
    files[path] = encoder.encode(text);
  };

  putText("报告.md", renderMarkdownReport(session, { now }));

  for (const doc of included) {
    const stem = fileStem(doc);
    /*
      **按内容类型分目录**（用户明确要求「视频网站和文章网站内容区分开」）。

      一篇资料的全部产物都收在它自己那一侧，所以「这个视频对应哪些文件」
      不需要靠文件名去猜：`视频/` 下同一个 stem 的 .md / .txt 就是它。
      类型判据来自 `core/kind.ts`，与抓取链、界面、报告同源。

      图片也放进对应类型的目录（`collectImages` 那边），否则包里会多出
      一个游离在外的顶层 `配图/`，又要把「视频和文章分开」这件事重新搅混。
    */
    const dir = packageDirFor(docKind(doc));
    putText(`${dir}/${stem}.md`, renderDocMarkdown(doc));
    // 字幕只在视频上有意义；doc.text 对视频就是字幕本身
    if (docKind(doc) === "video" && doc.text.trim()) {
      putText(`${dir}/${stem}.txt`, renderDocTranscript(doc));
    }
  }

  const { bytes: imageBytes, missing: imagesMissing } = await collectImages(
    sessionId,
    included,
    files,
  );

  if (imageBytes > MAX_IMAGE_BYTES) {
    const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
    return {
      ok: false,
      status: 413,
      error:
        `配图共 ${mb(imageBytes)} MB，超过单个压缩包的 ${mb(MAX_IMAGE_BYTES)} MB 上限。` +
        `请先取消勾选「配图」跑一次下载，或缩小选题范围。`,
    };
  }

  putText("未收录.md", renderExcluded(session, excluded, included.length, now));

  /*
    已压缩的图片用 level 0（store）：JPEG/PNG 再压一遍几乎不省字节，
    却要花掉可观的时间与内存。文本类用 6 —— 再高收益递减，而用户是在
    等一个浏览器下载。
  */
  const zippable: Record<string, Uint8Array | [Uint8Array, { level: 0 | 6 }]> = {};
  for (const [path, data] of Object.entries(files)) {
    zippable[path] = /\.(jpe?g|png|gif|webp|avif)$/i.test(path)
      ? [data, { level: 0 }]
      : [data, { level: 6 }];
  }

  const base = reportFileName(session.topic.query, now).replace(/\.md$/, "");
  return {
    ok: true,
    zip: zipSync(zippable),
    filename: `${base}.zip`,
    included: included.length,
    excluded: excluded.length,
    imagesMissing,
  };
}

/**
 * 把已下载的配图收进包里。
 *
 * 目录不存在、是个空目录、或者只有 `.part`/`.done`，都算「还没下」——
 * 不抛异常，只累加计数，让调用方在界面上提示一句「配图需要先跑一次下载」。
 */
async function collectImages(
  sessionId: string,
  docs: Document[],
  files: Record<string, Uint8Array>,
): Promise<{ bytes: number; missing: number }> {
  let bytes = 0;
  let missing = 0;

  for (const doc of docs) {
    if (doc.images.length === 0) continue;

    const stem = fileStem(doc);
    const dir = join(assetsDir(sessionId), `${stem}.images`);

    let names: string[];
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      names = entries
        .filter((e) => e.isFile() && !e.name.startsWith(".") && !e.name.endsWith(".part"))
        .map((e) => e.name)
        .sort();
    } catch {
      missing += 1;
      continue;
    }

    if (names.length === 0) {
      missing += 1;
      continue;
    }

    for (const name of names) {
      const full = join(dir, name);
      try {
        // 边读边记大小，超限时外层会直接拒绝，不必先全部读进内存才判断
        if (bytes > MAX_IMAGE_BYTES) return { bytes, missing };
        const buf = await readFile(full);
        bytes += buf.byteLength;
        // 跟着正文走：文章配图进 文章/，视频封面进 视频/
        files[`${packageDirFor(docKind(doc))}/${stem}/${name}`] = new Uint8Array(buf);
      } catch {
        // 单张图读不出来不该让整包失败 —— 它已经下到本地了，
        // 用户随时能在会话目录里找到
      }
    }
  }

  return { bytes, missing };
}

/** 被排除的那些，逐条写清为什么。 */
function renderExcluded(
  session: Session,
  excluded: Document[],
  includedCount: number,
  now: Date,
): string {
  const out: string[] = [
    "# 未收录的资料",
    "",
    `主题：**${session.topic.query}**  ·  生成于 ${now.toISOString()}`,
    "",
    `本次打包收录了 **${includedCount} 篇**正文完整的资料。下面这 **${excluded.length} 篇**` +
      `没有进包，但它们**没有被删除** —— 仍在会话里，点开就能看到抓到的原文。`,
    "",
    "> 收录标准：正文 ≥300 字、抓取过程没有报错，**且没有被判为疑似跑题**。",
    "> 前两条只回答「有没有拿到够长的正文」，第三条只回答「像不像你要找的东西」",
    "> —— 本工具**不回答「内容对不对」**，不做事实核查，也不给可信度评分。",
    "",
  ];

  if (excluded.length === 0) {
    out.push("这一批全部收录，没有遗漏。", "");
    return out.join("\n");
  }

  // 按原因归类：同一类问题一次说完，比逐条罗列更好读，也更容易看出「这是站点问题还是抓取问题」
  const groups = new Map<string, Document[]>();
  for (const d of excluded) {
    const reason = whyNotPackaged(d);
    const list = groups.get(reason);
    if (list) list.push(d);
    else groups.set(reason, [d]);
  }

  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);

  for (const [reason, docs] of ordered) {
    out.push(`## ${reason} —— ${docs.length} 篇`, "");
    for (const d of docs) {
      const title = d.title?.trim() || "(无标题)";
      // 带上类型：正文侧按 文章/视频 分了目录，这里也照同一份判据标注，
      // 用户扫一眼就知道「少的是几篇图文还是几个视频」
      out.push(`- [${title}](${d.url}) · ${d.site} · ${DOC_KIND_LABELS[d.kind]}`);
    }
    out.push("");
  }

  return out.join("\n");
}
