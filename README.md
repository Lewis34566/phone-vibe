# 📱 手机版 Agent（手机本机 Vibe Coding）

**在手机上用中文说需求，手机里的 AI Agent「Lewis」自动写代码、运行、打开给你用。** 整套系统跑在你自己的 Android 手机里（Termux + Node.js），不需要电脑、不需要服务器。

```
你说："做一个记账小工具"
  ↓ AI 自动：建文件夹 → 写代码 → 自查 → 启动 → 浏览器自动打开
  ↓ 文件都在手机里：文件管理器 → 内部存储/PhoneProjects/
  ↓ 随时一键导出 zip，传到电脑继续用
```

---

## 第一步：装 Termux（约 3 分钟）

> ⚠️ 一定要装 **F-Droid 版**，不要装 Google Play 版（Play 版已停止更新，命令会报错）

1. 手机浏览器打开 `https://f-droid.org`，点 **下载 F-Droid**，安装 APK
   （提示"未知来源"→ 允许安装即可，F-Droid 是开源软件商店）
2. 打开 F-Droid，顶部搜索 **Termux**，点安装
3. 安装 **Termux:Boot**（第 6 步开机自启要用，现在一起装好）
4. 打开 Termux，黑底白字命令行出现，输入法弹出 → 成功

---

## 第二步：下载本项目（约 2 分钟）

打开 Termux，**逐行复制粘贴**执行（长按屏幕可粘贴）：

```bash
pkg update -y
pkg install -y git
git clone https://github.com/Lewis34566/phone-vibe.git
mv phone-vibe 手机版Agent && cd 手机版Agent
```

> 想用英文目录名也可以：不执行上面 mv 那行，直接 `cd phone-vibe`。
> ⚠️ 如果改了目录名，第七步开机自启脚本里的 `cd "$HOME/phone-vibe"` 也要同步改成新名字。

> 如果 git clone 卡住/失败（GitHub 网络问题），用【方案 B】：
> 在能访问 GitHub 的设备上下载本仓库 zip，用微信/数据线传到手机，
> 在 Termux 里执行（zip 放在下载目录时）：
>
> ```bash
> pkg install -y unzip
> cd ~ && unzip ~/storage/downloads/phone-vibe-main.zip && mv phone-vibe-main 手机版Agent
> ```

---

## 第三步：安装（约 3 分钟）

```bash
bash install.sh
```

安装过程中会弹出一个授权窗口 —— **点【允许】**，然后回到 Termux 按回车。
（这是让项目能保存到手机存储 /sdcard/PhoneProjects）

看到 `✅ 安装完成` 就成功了。

---

## 第四步：填入 API Key（1 分钟）

1. 电脑/手机浏览器打开 `https://console.anthropic.com`，注册登录
2. 左侧 **API Keys** → **Create Key** → 复制 `sk-ant-...` 开头的一串
3. 先不用改文件 —— 下一步启动后在网页里粘贴即可（只保存在你手机里）

> 没有 Key 想先体验？在 Termux 里执行 `nano .env`，把
> `ANTHROPIC_API_KEY=mock` 填上（演示模式，模拟 AI 写一个记账工具，不花钱）

---

## 第五步：启动并使用

```bash
bash start.sh
```

几秒后**浏览器会自动打开**，看到聊天界面。

1. 顶部横幅粘贴 API Key → 保存
2. 下方输入框说一句：**"做一个记账小工具"**
3. AI 开始干活：你会在屏幕上看到它写的每个文件、执行的每条命令
4. 涉及删除/下载/安装时，会弹窗问你 ✅允许 / ✋拒绝
5. 完成后自动打开预览 —— **直接就能用**

项目文件在哪：手机自带的文件管理器 → **内部存储 → PhoneProjects** → 每个项目一个文件夹。

---

## 第六步（可选）：添加到主屏幕，像 App 一样用

> 必须用 `localhost` 地址打开才能添加（局域网 IP 打开的不行）

1. Chrome 打开 `http://localhost:8787`
2. 右上角 **⋮ 菜单** → **添加到主屏幕**（Add to Home screen）
3. 桌面出现「Vibe码」图标 → 点开就是全屏 App

---

## 第七步（可选）：开机自启

1. 打开一次 **Termux:Boot** 应用（第一次需要，之后不用管）
2. 回到 Termux 执行：

```bash
mkdir -p ~/.termux/boot
cp ~/手机版Agent/scripts/termux-boot.sh ~/.termux/boot/
chmod +x ~/.termux/boot/termux-boot.sh
```

以后手机开机，服务自动在后台运行，直接打开「Vibe码」图标就能用。
（关闭方法：Termux 里按 Ctrl+C，或执行 `pkill -f server.js`）

---

## 常用操作

| 想做什么 | 怎么做 |
|---|---|
| 看所有项目 | 点左上角 🗂 |
| 运行某个项目 | 项目卡片点 **▶ 运行**，再点 **🌐 打开** |
| 让 AI 修改项目 | 项目卡片点 **💬 用 AI 改**，直接说"把背景色改成蓝色" |
| 导出项目 zip | 项目卡片点 **⬇ 导出**，下载到手机 |
| 传到电脑 D 盘 | 手机浏览器下载目录 → 微信"文件传输助手"发到电脑，解压到 D 盘 |
| 电脑访问手机上的应用 | 手机和电脑连同一 WiFi，电脑浏览器打开 start.sh 里打印的 `http://192.168.x.x:8787` |
| 换端口 | `PORT=9000 bash start.sh` |
| 查看历史会话 | 点右上角 🕘 |

---

## 常见问题

**Q：start.sh 提示端口被占用？**
已经有实例在跑。`pkill -f server.js` 后再启动，或者直接打开浏览器继续用。

**Q：AI 回复很慢或报网络错误？**
API Key 的请求需要能访问 `api.anthropic.com`。国内网络环境需要手机开启代理/科学上网。

**Q：项目里 Node 代码报错？**
把项目卡片里的运行日志（启动失败时会提示）发到聊天里问 AI，让它自己修。

**Q：数据安全吗？**
- API Key 只存在你手机的 `.env` 文件里，不上传任何地方
- AI 执行的命令被限制在项目文件夹内，删除/下载/安装必须你点头
- 所有代码都在你手机本地运行，不依赖任何外部服务器

---

## 目录结构

```
phone-vibe/
├─ server.js            主服务（网页 + API + 项目预览反向代理）
├─ src/                 Agent 循环、工具、Claude API 调用、项目管理
├─ public/              聊天界面（PWA，可添加主屏幕）
├─ install.sh           一键安装
├─ start.sh             一键启动 + 自动开浏览器
├─ scripts/termux-boot.sh  开机自启脚本
└─ test/smoke.js        自测脚本
```

技术说明：零 npm 依赖（只有 Node 内置模块），Agent 直接调 Anthropic Messages API 的 tool-use 流式接口，模型可在 `.env` 里换（默认 `claude-sonnet-5-5`）。
