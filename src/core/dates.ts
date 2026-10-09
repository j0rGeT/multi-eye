/**
 * 日期归一化 —— 把搜索层拿到的五花八门的日期统一成 ISO 8601。
 *
 * ── 为什么需要这个 ──
 *
 * 实测过搜到的日期字段长什么样：SearXNG 各上游引擎格式不统一（ISO、
 * `Aug 12, 2026`、`20260812`、纯 Unix 时间戳都出现过），Serper 给的是中文
 * 自然语言（「3 天前」）。这些值此前是**原样透传**进 SearchResult 的，
 * 于是下游没有任何一处敢用它 —— 排序比不了大小，界面不知道能不能显示。
 * 结果就是这个系统里「发布日期」形同虚设。
 *
 * 归一化之后，下游只需要认一件事：`publishedAt` 要么是**合法的 ISO 串**，
 * 要么是 `undefined`（表示上游没给）。没有第三种可能。
 *
 * ── 一条硬规则：宁缺毋滥 ──
 *
 * 解析不出来就返回 `undefined`，**绝不猜**。上游偶尔会给出 `1970-01-01`
 * 这类哨兵值表示「没有日期」；把它当真，用户就会看到一篇 2026 年的文章
 * 标着「56 年前」。这类值一律按「未知」处理 —— 未知是可以展示的（界面写
 * 「日期未知」），错的日期不能。
 */

/**
 * 早于这个时间的日期一律判为「上游没给日期」。
 *
 * 选 1990 是因为 arXiv 1991 年才开始运营，而这套系统面向的是**主题资料检索**：
 * web 上不存在 1990 年以前、还值得为某个主题引用的内容。真实工作里这个下限
 * 拦下的全是哨兵值（`1970-01-01`、`0000-00-00` 被解析出来的产物）。
 */
const MIN_PLAUSIBLE_MS = Date.UTC(1990, 0, 1, 0, 0, 0);

/** 未来超过这个宽限期的日期判为不可信（时钟偏差、`9999-12-31` 这类哨兵）。 */
const FUTURE_TOLERANCE_MS = 48 * 3_600_000;

/** 十个数字以内当秒，超过当毫秒（1e11 秒是公元 5138 年，1e11 毫秒是 1973 年）。 */
const EPOCH_MS_THRESHOLD = 1e11;

const UNIT_MS: Record<string, number> = {
  秒: 1_000,
  分钟: 60_000,
  小时: 3_600_000,
  天: 86_400_000,
  周: 604_800_000,
  个月: 2_592_000_000,
  年: 31_536_000_000,
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
  month: 2_592_000_000,
  year: 31_536_000_000,
};

/** 绝对日期：`2026-08-12` / `2026/8/12` / `2026.8.12`，可带时间与时区。 */
const ABSOLUTE_RE =
  /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

/** 中文写法：`2026年8月12日` / `2026年8月12日 14:30`。中文站点的 RSS 里很常见。 */
const CN_ABSOLUTE_RE =
  /^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?(?:\s*(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

/**
 * 月份名。宽松兜底路径的准入门槛。
 *
 * 见 `normalizeToIso` 末尾那段：`new Date()` 会接受 `2026-02-30` 并安静地
 * 滑到 3 月 2 日，也会把 `-1` 当成公元前 1 年。我们自己那几条精确规则
 * 已经把这类串挡掉了，问题是兜底又把它们放回来。所以兜底只对**含月份名**
 * 的串开放 —— 也就是说，它实际只服务 RFC 2822（`Wed, 12 Aug 2026`）和
 * `August 12, 2026` 这一类，正是它唯一有价值的用途。
 *
 * 代价是「只有年份」的串（`2026`）会被判为无法解析。这是对的：一个孤零零的
 * 年份说不清是 1 月 1 日还是 12 月 31 日，按「未知」处理比编一个日期诚实。
 */
const MONTH_NAME_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;

/** 中文相对时间：「3 天前」「2 小时前」。 */
const CN_RELATIVE_RE = /(\d+)\s*(秒|分钟|小时|天|周|个月|年)\s*前/;

/** 英文相对时间：「3 days ago」。 */
const EN_RELATIVE_RE = /(\d+)\s*(second|minute|hour|day|week|month|year)s?\s+ago/i;

/**
 * 把任意来源的日期值归一化成 ISO 8601 字符串。
 *
 * @param raw 上游给的原始值：字符串、数字、null、undefined 都可能。
 * @param now 相对时间的基准（毫秒）。显式传入是为了让「3 天前」可测试 ——
 *            否则测试用例第二天就会自己失败。
 * @returns 合法 ISO 串，或 `undefined` 表示「无从得知」。
 */
export function normalizeToIso(
  raw: unknown,
  now: number = Date.now(),
): string | undefined {
  if (raw === null || raw === undefined) return undefined;

  if (typeof raw === "number") return fromEpoch(raw, now);

  const s = String(raw).trim();
  if (!s) return undefined;

  // 纯数字：可能是 Unix 时间戳，也可能是紧凑的 YYYYMMDD
  if (/^\d+$/.test(s)) {
    if (s.length === 8) {
      const packed = fromParts(
        Number(s.slice(0, 4)),
        Number(s.slice(4, 6)),
        Number(s.slice(6, 8)),
      );
      if (packed !== undefined) return iso(packed, now);
    }
    return fromEpoch(Number(s), now);
  }

  const relative = fromRelative(s, now);
  if (relative !== undefined) return iso(relative, now);

  const absolute = fromAbsolute(s);
  if (absolute !== undefined) return iso(absolute, now);

  /*
    最后交给 Date 兜底 —— 但**只对含月份名的串开放**。

    `new Date()` 的宽松程度远超预期，实测踩到两个：
      - `new Date("2026-02-30")` 不报错，安静地给出 3 月 2 日
      - `new Date("-1")` 当成公元前 1 年
    这两种串本来都被上面的精确规则挡掉了，是这条兜底又放回来的。加上
    月份名的门槛之后，它只服务 RFC 2822（`Wed, 12 Aug 2026 10:00:00 GMT`）
    这类真正需要它的输入，而不再有权力编造日期。

    兜底也不能提到前面：`new Date("2026")` 会合法地解析成 2026-01-01，
    那会抢走本该走精确规则的串。
  */
  if (MONTH_NAME_RE.test(s)) {
    /*
      串里没有时区标记时，补一个 `UTC` 再交给 Date。

      不补的话 `new Date("August 12, 2026")` 按**本机时区**解析 —— 同一份数据
      在东八区的机器上是 2026-08-11T16:00Z、在 UTC 机器上是 2026-08-12T00:00Z。
      这正好是上面精确规则刻意避开的那种不确定性，兜底路径不该又把它引回来。

      已经写明时区的串（RFC 2822 常见的 `GMT`、`+0800`）不加，否则会拼出
      `... GMT UTC` 这种畸形输入。
    */
    const hasZone = /\b(gmt|utc)\b|Z$|[+-]\d{2}:?\d{2}/i.test(s);
    const anchored = hasZone ? s : `${s} UTC`;
    const loose = new Date(anchored);
    if (!Number.isNaN(loose.getTime())) return iso(loose.getTime(), now);
  }

  return undefined;
}

/** 校验合理性。返回 ISO 串，或 undefined 表示「这个值不可信」。 */
function iso(ms: number, now: number): string | undefined {
  if (!Number.isFinite(ms)) return undefined;
  if (ms < MIN_PLAUSIBLE_MS) return undefined;
  if (ms > now + FUTURE_TOLERANCE_MS) return undefined;
  return new Date(ms).toISOString();
}

function fromEpoch(n: number, now: number): string | undefined {
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const ms = n < EPOCH_MS_THRESHOLD ? n * 1_000 : n;
  return iso(ms, now);
}

/**
 * 由年月日拼出时间戳（UTC 零点）。
 *
 * 显式 range 校验 + 回读比对：`Date.UTC(2026, 1, 30)` 不会报错，它会安静地
 * 滑到 3 月 2 日。回读一次就能把 `2026-02-30` 这类不存在的日期挡掉。
 */
function fromParts(y: number, m: number, d: number): number | undefined {
  if (m < 1 || m > 12 || d < 1 || d > 31) return undefined;
  const ms = Date.UTC(y, m - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) {
    return undefined;
  }
  return ms;
}

function fromRelative(s: string, now: number): number | undefined {
  if (/^(刚刚|刚才|just now)$/i.test(s)) return now;
  if (/^(昨天|yesterday)$/i.test(s)) return now - UNIT_MS["天"];
  if (/^前天$/.test(s)) return now - 2 * UNIT_MS["天"];

  const cn = s.match(CN_RELATIVE_RE);
  if (cn) {
    const unit = UNIT_MS[cn[2]];
    if (unit) return now - Number(cn[1]) * unit;
  }

  const en = s.match(EN_RELATIVE_RE);
  if (en) {
    const unit = UNIT_MS[en[2].toLowerCase()];
    if (unit) return now - Number(en[1]) * unit;
  }

  return undefined;
}

function fromAbsolute(s: string): number | undefined {
  const m = s.match(ABSOLUTE_RE);
  if (m) {
    const [, y, mo, d, hh = "0", mi = "0", ss = "0", tz] = m;
    return assemble(y, mo, d, hh, mi, ss, tz);
  }

  // 中文写法不带时区，按与「无时区 ISO 串」同一条规则处理
  const cn = s.match(CN_ABSOLUTE_RE);
  if (cn) {
    const [, y, mo, d, hh = "0", mi = "0", ss = "0"] = cn;
    return assemble(y, mo, d, hh, mi, ss, undefined);
  }

  return undefined;
}

function assemble(
  y: string,
  mo: string,
  d: string,
  hh: string,
  mi: string,
  ss: string,
  tz?: string,
): number | undefined {
  const base = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(hh),
    Number(mi),
    Number(ss),
  );
  if (Number.isNaN(base)) return undefined;

  // 回读比对，挡住 `2026-02-30`、`25:00` 这类不存在的日期
  const back = new Date(base);
  if (
    back.getUTCFullYear() !== Number(y) ||
    back.getUTCMonth() !== Number(mo) - 1 ||
    back.getUTCDate() !== Number(d)
  ) {
    return undefined;
  }

  /*
    没有时区标记时按 **UTC** 解析，而不是本机时区。

    页面上的 `2026-08-12 09:00` 究竟指哪个时区，我们无从得知 —— 硬猜 +08:00
    对中文站点通常对、对英文站点通常错。选 UTC 的理由不是「更准」，是
    **更稳定**：同一份数据在开发机和用户机器上必须归一化成同一个值，
    否则同一次会话在两台机器上会显示出不同的日期，而那种差异无从解释。
  */
  return base - tzOffsetMs(tz);
}

/** `Z` → 0；`+08:00` / `+0800` → +480 分钟对应的毫秒。 */
function tzOffsetMs(tz?: string): number {
  if (!tz || tz.toUpperCase() === "Z") return 0;
  const m = tz.match(/^([+-])(\d{2}):?(\d{2})$/);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3])) * 60_000;
}
