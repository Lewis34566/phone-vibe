#!/data/data/com.termux/files/usr/bin/bash
# 开机自启脚本：
#   1. 安装 Termux:Boot（F-Droid）
#   2. 打开一次 Termux:Boot 完成初始化
#   3. 在 Termux 里执行：
#        mkdir -p ~/.termux/boot
#        cp ~/手机版Agent/scripts/termux-boot.sh ~/.termux/boot/
#        chmod +x ~/.termux/boot/termux-boot.sh
# 以后手机开机就会自动启动服务（不会自动弹浏览器）
termux-wake-lock
# 兼容两种目录名：手机版Agent（推荐）或 phone-vibe
cd "$HOME/手机版Agent" 2>/dev/null || cd "$HOME/phone-vibe" 2>/dev/null || exit 0
NO_AUTO_OPEN=1 bash start.sh
