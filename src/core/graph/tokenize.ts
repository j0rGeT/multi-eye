/**
 * 中文分词与实词筛选。
 *
 * 这是启发式构图整条链的成败点：中文没有空格，不分词的话 TF-IDF 直接失效
 * （整句会被当成一个词，IDF 全是 1）。而分完词之后如果不筛掉虚词，
 * 「的/了/是/这个/我们」这类高频词会霸占权重榜首，图会退化成一团噪声。
 *
 * 所以这里做两件事：分词 + 词性筛选。
 */

import { STOPWORDS, SITE_CHROME } from "./stopwords";

/** 保留的词性前缀。jieba 用的是 ICTCLAS 词性体系。 */
const CONTENT_TAGS = new Set([
  "n",   // 名词：帐篷、睡袋
  "nr",  // 人名
  "ns",  // 地名
  "nt",  // 机构名
  "nz",  // 其他专名：SearXNG 这类
  "nl",  // 名词性惯用语
  "ng",  // 名词性语素
  "v",   // 动词：露营、推荐 —— 不能扔，"露营"本身是动词但显然是核心概念
  "vn",  // 动名词
  "vd",  // 副动词（如「继续」）保留，量少
  "a",   // 形容词：轻量化、便携
  "an",  // 名形词
  "ag",  // 形语素
  "j",   // 简称略语
  "l",   // 习用语
  "i",   // 成语
  "s",   // 处所词
  "eng", // 英文词：YouTube、Docker
  "x",   // 标点 —— 下面按内容再排掉，见 isContentWord
  "g",   // 语素
]);

/**
 * 明确丢弃的词性：助词、连词、介词、副词、代词、数词、量词、时间词、
 * 语气词、叹词、拟声词、标点、字符串。
 *
 * 注意 d（副词）被丢掉是有代价的：「非常」「很」确实没信息量，但「最」
 * 之类在标题里常见 —— 权衡之后仍以丢弃为主，因为它们几乎总是修饰语，
 * 单独成节点没有意义。
 */
const DROP_TAGS = new Set([
  "u", "c", "p", "d", "r", "m", "q", "t", "f", "y", "e", "o", "w", "x", "zg",
]);

export interface Token {
  word: string;
  tag: string;
}

let jieba: typeof import("jieba-wasm") | undefined;
let jiebaFailed = false;

/**
 * 懒加载 jieba-wasm。
 *
 * 用 WASM 版而不是 node-jieba：后者需要 node-gyp 编译，在换 Node 大版本或
 * 换机器时十有八九装不上。WASM 是预编译好的，装了就能跑 —— 实测冷启动
 * 约 200ms，之后再调用可忽略。
 */
async function loadJieba(): Promise<typeof import("jieba-wasm") | null> {
  if (jiebaFailed) return null;
  if (jieba) return jieba;
  try {
    jieba = await import("jieba-wasm");
    return jieba;
  } catch {
    // 加载失败不再重试，否则每篇文档都要付一次失败的代价
    jiebaFailed = true;
    return null;
  }
}

/**
 * 把一段文本切成实词。
 *
 * jieba 不可用时退化为「按字符 n-gram 切分」——质量差很多，但能让整条链
 * 继续跑完并给出可用的图，而不是整页报错。
 */
export async function tokenize(
  text: string,
  opts: { site?: string } = {},
): Promise<Token[]> {
  if (!text) return [];
  const j = await loadJieba();

  if (!j) return fallbackTokenize(text, opts);

  let tagged: Token[];
  try {
    // tag 返回 {word, tag}[]，比 cut 多一列信息，省一次分词
    tagged = j.tag(text, false) as Token[];
  } catch {
    return fallbackTokenize(text, opts);
  }

  const out: Token[] = [];
  for (const t of tagged) {
    const word = normalizeWord(t.word);
    if (isContentWord(word, t.tag, opts.site)) out.push({ word, tag: t.tag });
  }
  return out;
}

/** 站点专属的界面文案集合；无该站点时返回空集。 */
function chromeFor(site?: string): ReadonlySet<string> {
  if (!site) return EMPTY;
  const words = SITE_CHROME[site];
  return words ? new Set(words) : EMPTY;
}

const EMPTY: ReadonlySet<string> = new Set();

/**
 * 判断一个词是否值得进图。
 *
 * 三关：词性、停用词、长度。长度那关专门用来挡中文单字 ——
 * 「买」「用」「好」单独成节点毫无信息量，而它们在分词结果里占比很高。
 */
export function isContentWord(
  word: string,
  tag: string,
  site?: string,
): boolean {
  if (!word) return false;
  if (DROP_TAGS.has(tag)) return false;
  if (!CONTENT_TAGS.has(tag)) return false;
  if (STOPWORDS.has(word)) return false;
  const lower = word.toLowerCase();
  if (STOPWORDS.has(lower)) return false;
  // 站点界面文案：只在文档确实来自该站点时才滤（见 stopwords.ts 的说明）
  if (site && chromeFor(site).has(lower)) return false;

  // 全数字（年份、价格）不进图
  if (/^[\d.]+$/.test(word)) return false;
  // 纯标点/符号
  if (!/[\p{L}\p{N}]/u.test(word)) return false;

  const isCjk = /[一-鿿]/.test(word);
  if (isCjk && word.length < 2) return false;
  if (!isCjk && word.length < 3) return false;
  // 过长的多半是没切开的句子碎片
  if (word.length > 20) return false;

  return true;
}

/** 归一化：全角转半角、去首尾空白、英文统一小写用于比较（但保留原词形）。 */
export function normalizeWord(raw: string): string {
  return raw
    .replace(/[！-～]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
    )
    .replace(/　/g, " ")
    .trim();
}

/**
 * 没有 jieba 时的兜底分词。
 *
 * 用「相邻两字成词」的 bigram：中文里双字词占绝对多数，bigram 的召回足够
 * 撑起一张可用的共现图。英文按空格切。
 */
function fallbackTokenize(text: string, opts: { site?: string } = {}): Token[] {
  const out: Token[] = [];
  const segments = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);

  for (const seg of segments) {
    const isCjk = /[一-鿿]/.test(seg);
    if (!isCjk) {
      const w = seg.toLowerCase();
      if (isContentWord(w, "eng", opts.site)) out.push({ word: w, tag: "eng" });
      continue;
    }
    for (let i = 0; i + 2 <= seg.length; i++) {
      const w = seg.slice(i, i + 2);
      if (isContentWord(w, "n", opts.site)) out.push({ word: w, tag: "n" });
    }
  }
  return out;
}

/** 供 /api/graph 展示：当前用的是真分词还是兜底。 */
export async function tokenizerBackend(): Promise<"jieba" | "fallback"> {
  return (await loadJieba()) ? "jieba" : "fallback";
}
