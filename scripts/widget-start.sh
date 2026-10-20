#!/data/data/com.termux/files/usr/bin/bash
# Termux:Widget 一键启动：桌面加小部件，点一下服务就起来
# 安装方法（Termux 里执行）：
#   pkg install -y termux-widget
#   mkdir -p ~/.shortcuts && cp ~/手机版Agent/scripts/widget-start.sh ~/.shortcuts/启动Agent && chmod +x ~/.shortcuts/启动Agent
# 然后回桌面：长按空白 → 添加小部件 → Termux:Widget → 点「启动Agent」
# 兼容两种目录名：手机版Agent（推荐）或 phone-vibe
cd "$HOME/手机版Agent" 2>/dev/null || cd "$HOME/phone-vibe" 2>/dev/null || { echo "找不到 手机版Agent 目录"; exit 1; }
bash start.sh bg
