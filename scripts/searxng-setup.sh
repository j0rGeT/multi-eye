#!/usr/bin/env bash
# 原生安装 SearXNG（不依赖 Docker）。
#
# 为什么不用 Docker：本机 Docker Desktop 的代理指向 VPN，拉取 Docker Hub 镜像
# 实际零吞吐（连 3.5MB 的 alpine 都超时），且所有国内镜像站都返回地域限制。
# SearXNG 本身是个普通 Python 应用，原生跑完全可行。
#
# 用法：bash scripts/searxng-setup.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/.searxng"
VENV="$SRC/.venv"

if ! command -v uv >/dev/null 2>&1; then
  echo "错误：需要 uv。安装：brew install uv" >&2
  exit 1
fi

# 配置文件不入库（含 secret_key），首次安装时从模板生成并填入本机随机密钥。
SETTINGS="$ROOT/searxng/settings.yml"
if [ ! -f "$SETTINGS" ]; then
  echo "==> 从模板生成本机配置 searxng/settings.yml"
  SECRET="$(openssl rand -hex 32)"
  # 用 python 而不是 sed 替换：密钥里可能出现 / 或 &，sed 的替换语义会咬到它们
  python3 - "$ROOT/searxng/settings.yml.example" "$SETTINGS" "$SECRET" <<'PY'
import sys
src, dst, secret = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(src, encoding="utf-8").read()
if "__SEARXNG_SECRET_KEY__" not in text:
    sys.exit("模板里没有找到 __SEARXNG_SECRET_KEY__ 占位符")
open(dst, "w", encoding="utf-8").write(
    text.replace("__SEARXNG_SECRET_KEY__", secret)
)
PY
  echo "    密钥已生成（32 字节随机）"
else
  echo "==> searxng/settings.yml 已存在，保留现有密钥"
fi

if [ ! -d "$SRC" ]; then
  echo "==> 克隆 SearXNG 源码到 .searxng/"
  git clone --depth 1 https://github.com/searxng/searxng.git "$SRC"
else
  echo "==> .searxng/ 已存在，跳过克隆"
fi

if [ ! -d "$VENV" ]; then
  echo "==> 创建虚拟环境"
  uv venv --python 3.13 "$VENV"
fi

echo "==> 安装依赖（PyPI 官方源；国内镜像对当前出口会 403）"
VIRTUAL_ENV="$VENV" uv pip install -r "$SRC/requirements.txt"

# 克隆出来的源码里 bing 引擎有上游 bug（不发 mkt，导致永远 0 结果），
# 补丁随 clone 一起丢失，所以每次 setup 都重新应用一次（幂等）。
echo
echo "==> 给 bing 引擎打 mkt 补丁"
bash "$ROOT/scripts/searxng-patch.sh"

echo
echo "✅ 完成。用以下命令启停："
echo "   pnpm searxng:up     # 启动"
echo "   pnpm searxng:down   # 停止"
echo "   pnpm searxng:status # 查看状态"
