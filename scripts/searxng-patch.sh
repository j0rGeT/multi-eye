#!/usr/bin/env bash
# 给 SearXNG 的 bing 引擎打补丁，让它发送 mkt 市场参数。
#
# 为什么必须打这个补丁
# --------------------
# 不带 mkt 时 bing 返回的是一个纯前端渲染的空壳页（约 95KB，里面没有
# <ol id="b_results">），SearXNG 因此解析出 0 条结果，**而且不抛任何异常**。
# 表现极具迷惑性：引擎正常注册、enabled=true、不报错、永远是 0 条。
#
# 实测对照（同一查询「露营装备」，同一代理）：
#   ?q=...&setlang=zh            →  0 个 li.b_algo   ← SearXNG 原本发的
#   ?q=...&adlt=off              →  0 个 li.b_algo
#   ?q=...&mkt=zh-CN             → 10 个 li.b_algo   ← 加上 mkt 即可
#   ?q=...&setlang=zh&mkt=zh-CN  → 10 个 li.b_algo
#
# 讽刺的是 bing.py 顶部已经写好了 get_locale_params() 专门用来产生 mkt，
# 但 request() 从未调用它（上游 bug），补丁就是把这个调用补上。
#
# 这是对 .searxng/ 这份克隆的本地修改。该目录是 gitignore 的、可随时重新
# clone，所以补丁做成脚本；searxng-setup.sh 会在 clone 之后自动调用它。
#
# 用法：bash scripts/searxng-patch.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="$ROOT/.searxng/searx/engines/bing.py"

if [ ! -f "$TARGET" ]; then
  echo "错误：找不到 $TARGET —— 先运行 bash scripts/searxng-setup.sh" >&2
  exit 1
fi

python3 - "$TARGET" <<'PY'
import sys, pathlib

path = pathlib.Path(sys.argv[1])
src = path.read_text(encoding="utf-8")

if 'query_params["mkt"]' in src:
    print("✅ 补丁已存在，跳过")
    sys.exit(0)

anchor = '''        if cc and cc not in ("us", "cn", "ru"):  # bing just sends junk for these
            query_params["cc"] = cc
'''

if anchor not in src:
    print("❌ 找不到插入锚点 —— bing.py 上游已改动，请人工核对 request()", file=sys.stderr)
    print("   期望在 request() 里找到 setlang/cc 那两行。", file=sys.stderr)
    sys.exit(1)

patch = anchor + '''        # [muti-eye patch] mkt 必须发送，见 scripts/searxng-patch.sh 的说明。
        # 本文件顶部的 get_locale_params() 正是为此而写，但从未被调用（上游 bug）。
        query_params["mkt"] = engine_region
'''

path.write_text(src.replace(anchor, patch, 1), encoding="utf-8")
print("✅ 已给 bing 引擎打上 mkt 补丁")
PY
