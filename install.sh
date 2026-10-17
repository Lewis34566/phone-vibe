#!/usr/bin/env bash
# 手机本机 Vibe Coding —— 一键安装（Termux 内执行：bash install.sh）
set -e
cd "$(dirname "$0")"

echo "======================================"
echo "  📱 手机版 Agent 安装"
echo "======================================"

echo ""
echo "== 1/5 更新软件源 =="
pkg update -y

echo ""
echo "== 2/5 安装 Node.js / Git / Termux-API =="
pkg install -y nodejs git termux-api

echo ""
echo "== 3/5 授权访问手机存储 =="
echo "    接下来会弹出授权窗口，请点【允许】"
termux-setup-storage || true
until [ -d "$HOME/storage/shared" ]; do
  printf "    授权完成后按回车继续..."
  read -r _
done

echo ""
echo "== 4/5 创建项目目录 =="
mkdir -p "$HOME/storage/shared/PhoneProjects"
echo "    已创建：~/storage/shared/PhoneProjects"
echo "    （手机文件管理器里能看到：内部存储/PhoneProjects）"

echo ""
echo "== 5/5 初始化配置 =="
[ -f .env ] || cp .env.example .env
npm install --no-fund --no-audit

echo ""
echo "======================================"
echo "  ✅ 安装完成！node $(node -v)"
echo ""
echo "  下一步：bash start.sh"
echo "  打开网页后，在顶部横幅粘贴 API Key 即可。"
echo "  （想先体验：.env 里 ANTHROPIC_API_KEY 填 mock）"
echo "======================================"
