#!/data/data/com.termux/files/usr/bin/bash
# 开机自启脚本（v1.5，后台常驻）：
#   1. 安装 Termux:Boot（F-Droid）并打开一次完成初始化
#   2. 在 Termux 里执行：
#        mkdir -p ~/.termux/boot
#        cp ~/手机版Agent/scripts/termux-boot.sh ~/.termux/boot/
#        chmod +x ~/.termux/boot/termux-boot.sh
#   3. 重启手机后服务自动在后台起来，直接打开 http://127.0.0.1:8787 就能用
# 兼容两种目录名：手机版Agent（推荐）或 phone-vibe
cd "$HOME/手机版Agent" 2>/dev/null || cd "$HOME/phone-vibe" 2>/dev/null || exit 0
APP_DIR="$PWD"

# 等网络就绪（最多 30 秒）
for _ in $(seq 1 30); do
  ip -4 route get 1.1.1.1 >/dev/null 2>&1 && break
  sleep 1
done

termux-wake-lock 2>/dev/null
# 后台常驻：不占用窗口，关掉 Termux 也不停
NO_AUTO_OPEN=1 bash start.sh bg >> "$APP_DIR/boot.log" 2>&1
