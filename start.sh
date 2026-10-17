#!/usr/bin/env bash
# 手机本机 Vibe Coding —— 一键启动（自动打开浏览器）
cd "$(dirname "$0")"
PORT="${PORT:-8787}"
export PORT

# 防止手机休眠杀掉服务（需要已安装 termux-api）
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock

# 已在运行？直接打开浏览器
if curl -s "http://127.0.0.1:$PORT/api/state" >/dev/null 2>&1; then
  echo "服务已在运行，直接打开浏览器"
else
  node server.js &
  SERVER_PID=$!
  trap 'kill $SERVER_PID 2>/dev/null' EXIT INT TERM
  printf "正在启动"
  for _ in $(seq 1 40); do
    sleep 0.5
    if curl -s "http://127.0.0.1:$PORT/api/state" >/dev/null 2>&1; then break; fi
    printf "."
  done
  echo ""
fi

IP=""
IP=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.*src \([0-9.]*\).*/\1/p' | head -1)
[ -z "$IP" ] && IP=$(ip -4 addr show wlan0 2>/dev/null | sed -n 's/.*inet \([0-9.]*\)\/.*/\1/p' | head -1)
[ -z "$IP" ] && IP=$(ifconfig wlan0 2>/dev/null | sed -n 's/.*inet \([0-9.]*\) .*/\1/p' | head -1)

echo ""
echo "======================================"
echo "  📱 手机版 Agent 已启动"
echo "  本机访问:    http://localhost:$PORT"
if [ -n "$IP" ]; then
  echo "  局域网访问:  http://$IP:$PORT"
  echo "  （电脑/其他手机连同一个 WiFi 可打开）"
fi
echo "  项目目录:    ~/storage/shared/PhoneProjects"
echo "  停止:        回到 Termux 按 Ctrl+C"
echo "======================================"
echo ""

if [ -z "${NO_AUTO_OPEN:-}" ] && command -v termux-open-url >/dev/null 2>&1; then
  termux-open-url "http://localhost:$PORT"
fi

if [ -n "${SERVER_PID:-}" ]; then
  wait "$SERVER_PID" 2>/dev/null || true
else
  sleep infinity
fi
