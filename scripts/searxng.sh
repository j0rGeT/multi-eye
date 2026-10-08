#!/usr/bin/env bash
# SearXNG 进程管理（原生方式，不依赖 Docker）。
#
# 用法：bash scripts/searxng.sh {start|stop|status|restart}
#
# 关键点：必须把 SEARXNG_SETTINGS_PATH 指向本仓库的 searxng/settings.yml，
# 那份配置里启用了 json 输出格式 —— 这是 /api/search 能工作的前提。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/.searxng"
VENV="$SRC/.venv"
PIDFILE="$SRC/.searxng.pid"
LOGFILE="$SRC/.searxng.log"
PORT="${SEARXNG_PORT:-8888}"

export SEARXNG_SETTINGS_PATH="$ROOT/searxng/settings.yml"

is_running() {
  [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null
}

case "${1:-}" in
  start)
    if is_running; then
      echo "已在运行 (pid $(cat "$PIDFILE")) → http://localhost:$PORT"
      exit 0
    fi
    if [ ! -d "$VENV" ]; then
      echo "未安装。先运行：bash scripts/searxng-setup.sh" >&2
      exit 1
    fi

    # bing 引擎缺 mkt 会静默返回 0 条结果（见 scripts/searxng-patch.sh）。
    # 每次启动都校验一次，缺了就自动补，避免重新 clone 后功能悄悄失效。
    bash "$ROOT/scripts/searxng-patch.sh" >/dev/null

    cd "$SRC"
    # SEARXNG_BIND_ADDRESS/PORT 只影响监听；webapp.py 是 Flask 自带的开发服务器，
    # 本地个人工具够用，也免去 granian/uwsgi 的额外依赖。
    #
    # PYTHONPATH 必须设：直接跑 searx/webapp.py 时 Python 会把脚本所在目录
    # （searx/）加进 sys.path 而非仓库根，导致 `import searx` 失败。
    #
    # 代理：SearXNG 必须能通过 VPN 走代理，否则 Google 完全不可达
    # （实测本机直连 google.com 超时，走 127.0.0.1:6666 得 200）。
    # Bing / 百度 直连更快，但走代理也能用，所以统一走代理是更稳的选择：
    # VPN 开着时三家都可用，VPN 关掉时 Bing/百度 仍直连工作，自动降级。
    SEARXNG_BIND_ADDRESS=127.0.0.1 \
    SEARXNG_PORT="$PORT" \
    PYTHONPATH="$SRC" \
    SEARXNG_SECRET="$(sed -n 's/^ *secret_key: *"\(.*\)"/\1/p' "$ROOT/searxng/settings.yml")" \
      nohup "$VENV/bin/python" searx/webapp.py > "$LOGFILE" 2>&1 &

    echo $! > "$PIDFILE"
    echo "启动中 (pid $(cat "$PIDFILE"))，等待就绪…"

    for i in $(seq 1 40); do
      if curl -sf --noproxy '*' -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then
        echo "✅ 就绪 → http://localhost:$PORT"
        exit 0
      fi
      sleep 0.5
    done

    echo "⚠️  30 秒内未就绪。日志末尾：" >&2
    tail -25 "$LOGFILE" >&2
    exit 1
    ;;

  stop)
    if is_running; then
      kill "$(cat "$PIDFILE")" 2>/dev/null || true
      rm -f "$PIDFILE"
      echo "已停止"
    else
      echo "未在运行"
    fi
    ;;

  status)
    if is_running; then
      echo "运行中 (pid $(cat "$PIDFILE")) → http://localhost:$PORT"
      # 顺便验证 json 格式是否真的可用，这是最容易漏配的一项
      code=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' \
        "http://127.0.0.1:$PORT/search?q=test&format=json" 2>/dev/null || echo "000")
      if [ "$code" = "200" ]; then
        echo "JSON API: ✅ 可用"
      elif [ "$code" = "403" ]; then
        echo "JSON API: ❌ 403 —— settings.yml 的 search.formats 缺少 json"
      else
        echo "JSON API: ❌ HTTP $code"
      fi
    else
      echo "未在运行"
      exit 1
    fi
    ;;

  restart)
    "$0" stop
    sleep 1
    "$0" start
    ;;

  logs)
    tail -f "$LOGFILE"
    ;;

  *)
    echo "用法：bash scripts/searxng.sh {start|stop|status|restart|logs}" >&2
    exit 1
    ;;
esac
