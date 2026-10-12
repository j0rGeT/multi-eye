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
RUNTIME_SETTINGS="$SRC/settings.runtime.yml"

# 引擎出站的代理。优先级：SEARXNG_PROXY_URL > FETCH_PROXY_URL > 本机默认。
# 显式传空串（SEARXNG_PROXY_URL=""）表示强制直连。
PROXY_URL="${SEARXNG_PROXY_URL-${FETCH_PROXY_URL:-http://127.0.0.1:6666}}"

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

    # ── 出站代理：先探测，再决定写不写进运行时配置 ──
    #
    # 两层防护，缺一不可：
    #   1. unset 环境变量 —— Python 的 requests/curl_cffi 会读 http_proxy 等
    #      变量，shell 里残留一个死代理（实测 127.0.0.1:6666 已无进程监听）
    #      会让四个引擎全部 "HTTP connection error"，而 /search 仍返回 200
    #      只是 results 为空，看起来像「搜索卡住」。
    #   2. outgoing.proxies 显式声明 —— 清空环境变量之后，代理仍然是要走的：
    #      duckduckgo/startpage 直连超时（网络事实），没有代理这两个引擎
    #      永远躺在 unresponsive_engines 里，白名单等于残废。
    #
    # 代理地址**不写进 searxng/settings.yml**：那份文件入库，而代理是运行时
    # 事实（VPN 随时可能关）。写死的话代理一关就是上面那个老坑。所以这里
    # 先探测、再合成一份运行时才存在的 .searxng/settings.runtime.yml —
    # 探测失败就降级直连（bing/mojeek 仍可用），而不是带着死代理启动。
    SETTINGS_EFFECTIVE="$ROOT/searxng/settings.yml"
    if [ -n "$PROXY_URL" ]; then
      if "$VENV/bin/python" - "$PROXY_URL" <<'PYEOF'
import socket, sys, urllib.parse
u = urllib.parse.urlparse(sys.argv[1])
host = u.hostname or "127.0.0.1"
port = u.port or (443 if u.scheme == "https" else 80)
try:
    socket.create_connection((host, port), timeout=1.5).close()
    sys.exit(0)
except OSError as e:
    print(f"  探测失败: {e}", file=sys.stderr)
    sys.exit(1)
PYEOF
      then
        "$VENV/bin/python" - "$ROOT/searxng/settings.yml" "$RUNTIME_SETTINGS" "$PROXY_URL" <<'PYEOF'
import sys, yaml
src, dst, proxy = sys.argv[1], sys.argv[2], sys.argv[3]
with open(src) as f:
    cfg = yaml.safe_load(f)
cfg.setdefault("outgoing", {})["proxies"] = {"all://": proxy}
with open(dst, "w") as f:
    yaml.safe_dump(cfg, f, allow_unicode=True, sort_keys=False)
PYEOF
        SETTINGS_EFFECTIVE="$RUNTIME_SETTINGS"
        echo "代理: ✅ $PROXY_URL（已写入运行时配置）"
      else
        echo "⚠️  代理 $PROXY_URL 不可达，已降级为直连（bing/mojeek 仍可用，duckduckgo/startpage 将超时）" >&2
      fi
    else
      echo "代理: 关闭（SEARXNG_PROXY_URL 为空，全部直连）"
    fi

    # SEARXNG_BIND_ADDRESS/PORT 只影响监听；webapp.py 是 Flask 自带的开发服务器，
    # 本地个人工具够用，也免去 granian/uwsgi 的额外依赖。
    #
    # PYTHONPATH 必须设：直接跑 searx/webapp.py 时 Python 会把脚本所在目录
    # （searx/）加进 sys.path 而非仓库根，导致 `import searx` 失败。
    unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY no_proxy
    SEARXNG_BIND_ADDRESS=127.0.0.1 \
    SEARXNG_PORT="$PORT" \
    PYTHONPATH="$SRC" \
    SEARXNG_SETTINGS_PATH="$SETTINGS_EFFECTIVE" \
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
      # 当前生效的配置：settings.runtime.yml 存在且含 proxies 才算挂了代理。
      # 只看文件存在会误报 —— 降级直连时也会生成一份不含 proxies 的文件。
      if [ -f "$RUNTIME_SETTINGS" ] && grep -q 'all://' "$RUNTIME_SETTINGS"; then
        echo "出站代理: $(grep 'all://' "$RUNTIME_SETTINGS" | awk '{print $NF}')"
      else
        echo "出站代理: 无（直连）"
      fi
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
      # 引擎健康：哪些上游这次没响应。duckduckgo/startpage 在这里躺平
      # 通常意味着代理没挂上或代理本身不通。
      curl -s --noproxy '*' "http://127.0.0.1:$PORT/search?q=test&format=json" 2>/dev/null \
        | "$VENV/bin/python" -c "
import json,sys
try:
    d = json.load(sys.stdin)
    unresp = [e[0] for e in d.get('unresponsive_engines', [])]
    print('引擎未响应: ' + ('、'.join(unresp) if unresp else '无 ✅'))
except Exception:
    pass
" 2>/dev/null || true
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
