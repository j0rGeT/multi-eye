#!/usr/bin/env bash
#
# 拉取官方的 yt-dlp 单文件二进制到 bin/yt-dlp（末位兜底方案）。
#
# ⚠️ 首选 `uv tool install yt-dlp`（或 pipx / brew），只有在完全没有 Python
#    工具链时才用这个脚本。实测官方单文件二进制在 macOS 上每次启动要 ~23 秒
#    （PyInstaller onefile 的开销，CPU 占用仅 3%，全程等 I/O），而标准安装只要
#    0.1 秒。本项目一次主题要调 yt-dlp 一到几十次，23 秒的启动开销会让 YouTube
#    这条链实际不可用 —— 所以 findYtdlp() 把它排在所有标准安装之后。
#
#    走这条路的原因也是真的：本机 brew 的 yt-dlp 依赖 deno，而 deno 又要求完整
#    的 Xcode.app；uv 装的则一切正常（~0.1 秒）。
#
# 二进制不入 git（见 .gitignore），需要时跑一次本脚本。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/bin/yt-dlp"

case "$(uname -s)" in
  Darwin) ASSET="yt-dlp_macos" ;;
  Linux)  ASSET="yt-dlp_linux" ;;
  *) echo "不支持的系统：$(uname -s)，请自行安装 yt-dlp 并用 YTDLP_PATH 指定。" >&2; exit 1 ;;
esac

mkdir -p "$ROOT/bin"

# 先下到临时文件再改名。直接写 DEST 的话，中断会留下一个半截的二进制，
# 而 findYtdlp() 只判断文件存在，于是应用会去执行一个损坏的文件。
TMP="$DEST.part"
trap 'rm -f "$TMP"' EXIT

echo "下载 $ASSET …"
curl -fL --retry 3 --connect-timeout 20 \
  -o "$TMP" \
  "https://github.com/yt-dlp/yt-dlp/releases/latest/download/$ASSET"

chmod +x "$TMP"

# 改名之前先确认拿到的是能跑的东西，而不是 GitHub 的 404 页面
if ! "$TMP" --version >/dev/null 2>&1; then
  echo "下载到的文件无法执行，已丢弃。请检查网络（本项目默认走 FETCH_PROXY_URL）。" >&2
  exit 1
fi

mv "$TMP" "$DEST"
trap - EXIT

echo "已就绪：$DEST ($("$DEST" --version))"
