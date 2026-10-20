#!/usr/bin/env bash
# 手机版 Agent —— 启动脚本（v1.5）
#   bash start.sh         前台启动，关掉窗口服务就停（适合看报错）
#   bash start.sh bg      后台常驻，关掉 Termux 窗口也不停（推荐日常用）
#   bash start.sh stop    停止服务
#   bash start.sh status  看看在不在运行
cd "$(dirname "$0")" || exit 1
APP_DIR="$PWD"
PORT="${PORT:-8787}"
export PORT
LOG="$APP_DIR/server.log"
PIDFILE="$APP_DIR/.server.pid"

is_up() { curl -s -m 2 "http://127.0.0.1:$PORT/api/state" >/dev/null 2>&1; }

# 防止手机休眠把服务杀掉（需要先 pkg install termux-api）
wake_lock() {
  if command -v termux-wake-lock >/dev/null 2>&1; then
    termux-wake-lock 2>/dev/null && echo "🔒 已加唤醒锁（息屏不掉线）"
  else
    echo "⚠️ 没装 termux-api：手机息屏可能断开。安装：pkg install termux-api"
  fi
}

lan_ip() {
  local ip=""
  ip=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.*src \([0-9.]*\).*/\1/p' | head -1)
  [ -z "$ip" ] && ip=$(ip -4 addr show wlan0 2>/dev/null | sed -n 's/.*inet \([0-9.]*\)\/.*/\1/p' | head -1)
  [ -z "$ip" ] && ip=$(ifconfig wlan0 2>/dev/null | sed -n 's/.*inet \([0-9.]*\) .*/\1/p' | head -1)
  echo "$ip"
}

# 老安装升级兜底：.env 里没有访问密码就自动生成一个（install.sh 新装时也会生成）
ensure_token() {
  if [ -f .env ] && grep -q '^ACCESS_TOKEN=' .env; then return; fi
  local tok; tok=$(tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 8)
  [ -f .env ] || cp .env.example .env
  echo "ACCESS_TOKEN=$tok" >> .env
}

banner() {
  local ip; ip=$(lan_ip)
  local tok; tok=$(sed -n 's/^ACCESS_TOKEN=//p' .env 2>/dev/null | head -1)
  echo ""
  echo "======================================"
  echo "  📱 手机版 Agent 已启动"
  echo "  本机访问:    http://127.0.0.1:$PORT"
  if [ -n "$ip" ]; then
    echo "  局域网访问:  http://$ip:$PORT"
    echo "  （电脑/其他手机连同一个 WiFi 可打开）"
  fi
  if [ -n "$tok" ]; then
    echo "  访问密码:    $tok  （局域网/公网打开要输，本机免密）"
  fi
  echo "  项目目录:    ~/storage/shared/PhoneProjects"
  echo "  手机全权限:  开（可读写整个手机存储，危险操作仍会弹窗确认）"
  echo "  装成 App:    Chrome 打开上面的地址 → ⋮ → 添加到主屏幕"
  echo "  停止:        bash start.sh stop"
  echo "======================================"
  echo ""
}

auto_open() {
  if [ -z "${NO_AUTO_OPEN:-}" ] && command -v termux-open-url >/dev/null 2>&1; then
    termux-open-url "http://127.0.0.1:$PORT/?v=19" >/dev/null 2>&1 &
  fi
}

case "${1:-start}" in
  stop)
    if [ -f "$PIDFILE" ]; then
      kill "$(cat "$PIDFILE")" 2>/dev/null
      rm -f "$PIDFILE"
    fi
    pkill -f "node server.js" 2>/dev/null
    sleep 1
    if is_up; then echo "❌ 没停掉，试试 bash start.sh stop 再来一次"; else echo "✅ 服务已停止"; fi
    exit 0
    ;;
  status)
    if is_up; then
      echo "✅ 正在运行：http://127.0.0.1:$PORT"
      curl -s "http://127.0.0.1:$PORT/api/state"; echo
    else
      echo "⛔ 没在运行。启动：bash start.sh bg"
    fi
    exit 0
    ;;
  bg)
    if is_up; then
      echo "✅ 服务已经在跑：http://127.0.0.1:$PORT"
      exit 0
    fi
    wake_lock
    ensure_token
    nohup node server.js >> "$LOG" 2>&1 &
    echo $! > "$PIDFILE"
    printf "正在后台启动"
    for _ in $(seq 1 40); do
      sleep 0.5
      if is_up; then break; fi
      printf "."
    done
    echo ""
    if is_up; then
      banner
      echo "🔒 后台模式：这个窗口可以关掉，服务不会停（日志：~/手机版Agent/server.log）"
      auto_open
    else
      echo "❌ 启动失败，最后 20 行日志："
      tail -n 20 "$LOG" 2>/dev/null
      exit 1
    fi
    exit 0
    ;;
  start|fg)
    wake_lock
    if is_up; then
      echo "✅ 服务已经在跑：http://127.0.0.1:$PORT"
    else
      ensure_token
      node server.js &
      SERVER_PID=$!
      trap 'kill $SERVER_PID 2>/dev/null' EXIT INT TERM
      printf "正在启动"
      for _ in $(seq 1 40); do
        sleep 0.5
        if is_up; then break; fi
        printf "."
      done
      echo ""
    fi
    banner
    auto_open
    if [ -n "${SERVER_PID:-}" ]; then
      wait "$SERVER_PID" 2>/dev/null || true
    else
      sleep infinity
    fi
    ;;
  *)
    echo "用法：bash start.sh [bg|stop|status]"
    exit 1
    ;;
esac
