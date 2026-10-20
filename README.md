# 📱 手机版 Agent（手机本机 Vibe Coding）

**在手机上用中文说需求，手机里的 AI Agent「Lewis」自动写代码、运行、打开给你用。** 整套系统跑在你自己的 Android 手机里（Termux + Node.js），不需要电脑、不需要服务器。

```
你说："做一个记账小工具"
  ↓ Lewis：先出方案 → 写代码 → 语法自查 → 启动失败自动修 → 打开预览
  ↓ 文件都在手机里：文件管理器 → 内部存储/PhoneProjects/
  ↓ 说「继续」就能无限迭代：加功能、改配色、修 bug
  ↓ 随时一键导出 zip，传到电脑继续用
```

> **v1.9 新增**
> - **能直接操作手机**（`phone` 工具）：打开链接/应用、读写剪贴板、发通知、读电量与 WiFi、发短信（需确认）、拍照、语音朗读、震动、手电筒、分享文件——装好 **Termux:API** 即可用。
> - **Agent 能力更全**：新增 `edit_file`（精确改代码，不用整篇重写）、`read_url`（读网页正文查资料）、`http_request`（调任意接口）。
> - **能装成手机 App**：用 `http://127.0.0.1:8787` 打开 → 界面右上 📲 或 Chrome ⋮ → 添加到主屏幕，桌面出现图标、全屏无地址栏。
> - **全手机权限**：Lewis 能读写整个手机存储（`~` 家目录、`/sdcard`），系统目录仍然禁止，删除/下载/安装照旧弹窗确认。
> - **后台常驻**：`bash start.sh bg` 后台运行 + 唤醒锁，关掉 Termux 窗口服务不停；配 Termux:Boot 还能开机自启。
> - **访问密码**：首次安装自动生成，同一 WiFi 的别人打开时要输密码，防陌生人花你的 API Key（本机打开免密）。
> - **设置面板**：右上 ⚙️ 切换模型、语音朗读、自动打开预览、一键备份所有项目（zip）。
> - **界面不再卡**：流式输出改成节流渲染，长回答滚动顺滑；支持语音输入、回复朗读、中途停止。

---

## 零门槛用法：手机不用装任何东西（电脑开隧道）

**适用场景：只是想用起来，不想折腾手机。** Agent 跑在电脑上，手机只打开一个网址（4G/5G 也能用，不要求同一 WiFi）：

1. 电脑上右键 **`scripts\start-public.ps1`** →「使用 PowerShell 运行」
   （首次会提示下载 cloudflared.exe，放回 `scripts\` 同级的项目文件夹再跑一次）
2. 窗口里出现 **`https://xxx.trycloudflare.com`** 的绿色网址（已自动复制到剪贴板）
3. 把网址微信发到手机 → 手机浏览器打开 → 用户名随便填，密码用窗口里打印的 **访问密码**
4. 浏览器菜单 → 添加到主屏幕 → 手机上就是一个全屏 App

> 电脑需要保持开机。网址每次重启隧道会变；想要固定网址或 7×24 在线，把项目部署到云服务器即可（代码零改动）。

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

> 如果 git clone 卡住/失败（GitHub 网络问题），用【方案 B：安装包 zip】：
> 把电脑上打好的 `手机版Agent-安装包.zip` 用微信/数据线传到手机（放到"下载"目录），
> 在 Termux 里执行：
>
> ```bash
> termux-setup-storage   # 先授权访问手机存储（弹窗点【允许】）
> pkg install -y unzip
> cd ~ && unzip ~/storage/downloads/手机版Agent-安装包.zip -d 手机版Agent && cd 手机版Agent
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

1. 电脑/手机浏览器打开 `https://platform.deepseek.com/api_keys`，注册登录
2. 点 **创建 API Key** → 复制 `sk-...` 开头的一串
3. 先不用改文件 —— 下一步启动后在网页里粘贴即可（只保存在你手机里）

> 没有 Key 想先体验？在 Termux 里执行 `nano .env`，把
> `DEEPSEEK_API_KEY=mock` 填上（演示模式，模拟 AI 写一个记账工具，不花钱）

---

## 第五步：启动并使用

```bash
bash start.sh bg      # 后台常驻：关掉 Termux 窗口也不停（推荐）
bash start.sh         # 前台启动：能实时看到报错，关窗口就停
bash start.sh status  # 看服务在不在跑
bash start.sh stop    # 停止服务
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

> 必须用 `http://127.0.0.1:8787` 打开才能添加（局域网 IP 打开的不行）

1. Chrome 打开 `http://127.0.0.1:8787`
2. 右上角 **⋮ 菜单** → **添加到主屏幕**（Add to Home screen）
3. 桌面出现「手机版 Agent」图标 → 点开就是全屏 App

---

## 第七步（可选）：开机自启

1. 打开一次 **Termux:Boot** 应用（第一次需要，之后不用管）
2. 回到 Termux 执行：

```bash
mkdir -p ~/.termux/boot
cp ~/手机版Agent/scripts/termux-boot.sh ~/.termux/boot/
chmod +x ~/.termux/boot/termux-boot.sh
```

以后手机开机，服务自动在后台运行，直接打开「手机版 Agent」图标就能用。
（关闭方法：`bash start.sh stop`）

---

## 常用操作

| 想做什么 | 怎么做 |
|---|---|
| 看所有项目 | 点左上角 🗂 |
| 运行某个项目 | 项目卡片点 **▶ 运行**，再点 **🌐 打开** |
| 让 AI 修改项目 | 项目卡片点 **💬 用 AI 改**，直接说"把背景色改成蓝色" |
| 导出项目 zip | 项目卡片点 **⬇ 导出**，下载到手机 |
| 传到电脑 D 盘 | 手机浏览器下载目录 → 微信"文件传输助手"发到电脑，解压到 D 盘 |
| 电脑访问手机上的应用 | 手机和电脑连同一 WiFi，电脑浏览器打开 start.sh 里打印的 `http://192.168.x.x:8787`，输访问密码 |
| 备份所有项目 | 右上 ⚙️ → 「⬇ 备份所有项目（zip）」 |
| 换端口 | `PORT=9000 bash start.sh` |
| 查看历史会话 | 点右上角 🕘 |

---

## 发消息（短信 / 企业微信 / QQ / 微信）

| 想发到哪 | 能力 | 怎么配 |
|---|---|---|
| 手机短信 | ✅ 全自动（发前弹窗确认） | 装 Termux:API 即可 |
| 企业微信群 | ✅ 全自动 | `.env` 填 `WECOM_WEBHOOK_URL`（企业微信群 → 添加机器人 → 复制 webhook），重启服务 |
| QQ 好友/群 | ✅ 全自动 | 电脑跑 NapCat 等 OneBot 机器人挂 QQ 小号，`.env` 填 `ONEBOT_API_URL` |
| 微信个人消息 | ⚠️ 无法全自动（微信没有对外接口，谁家都一样） | 说"发微信给 XX"时 Lewis 会复制好内容并打开微信（你粘贴发送），或拉起分享面板（你选人发送） |

直接说人话就行：「发短信给 138xxxx 说 我在路上了」「发到企业微信群：今日数据」「帮我把这段话发到 QQ 群 123456」「帮我发微信给妈妈：晚上回家吃饭」。

---

## 服务被杀 / 第二次打开打不开？

手机系统（尤其小米 HyperOS）息屏久了会把后台 Termux 杀掉 → 再打开 App 会看到「服务没在跑」引导页（数据和项目都在，没丢）。三种办法：

1. **桌面一键启动小部件**（最省事）：Termux 里执行
   ```bash
   pkg install -y termux-widget
   mkdir -p ~/.shortcuts && cp ~/手机版Agent/scripts/widget-start.sh ~/.shortcuts/启动Agent && chmod +x ~/.shortcuts/启动Agent
   ```
   回桌面 → 长按空白 → 添加小部件 → Termux:Widget → 选「启动Agent」。以后点一下服务就回来。
2. **让系统别杀**：设置 → 省电与电池 → Termux → **无限制**；应用自启动 → 允许；最近任务里把 Termux 卡片**下拉锁住**。
3. **开机自启**：见上文第七步（Termux:Boot），重启手机自动拉起。

> 注意：启动要用 `bash start.sh bg`（后台模式）。`bash start.sh` 前台模式关掉 Termux 窗口服务就停。

---

## 常见问题

**Q：start.sh 提示端口被占用？**
已经有实例在跑。`bash start.sh stop` 停掉后再启动，或者直接打开浏览器继续用。

**Q：同一 WiFi 的电脑/别人打开时让输密码？**
这是访问密码（防陌生人花你的 API Key、读写你的手机）。
- 密码在哪看：安装/启动时横幅会打印，或 Termux 里 `grep ACCESS_TOKEN .env`
- 想改密码：`nano .env` 修改 `ACCESS_TOKEN=` 那一行，然后 `bash start.sh stop && bash start.sh bg`
- 想完全关掉密码（不建议）：删掉 `.env` 里 `ACCESS_TOKEN` 那行再重启

**Q：AI 回复很慢或报网络错误？**
API Key 的请求走 DeepSeek 官方接口 `api.deepseek.com`，**国内网络直连可用，不需要代理**。如果报错，先确认 Key 有没有余额。

**Q：项目里 Node 代码报错？**
把项目卡片里的运行日志（启动失败时会提示）发到聊天里问 AI，让它自己修。

**Q：数据安全吗？**
- API Key 只存在你手机的 `.env` 文件里，不上传任何地方
- 所有代码都在你手机本地运行，不依赖任何外部服务器
- Lewis 能读写的范围：项目文件夹 + 手机存储（`~` 家目录、`/sdcard`）；系统目录禁止访问
- 删除文件、联网下载、安装依赖、发短信都会弹窗问你 ✅允许 / ✋拒绝，不点头就不做
- 同一 WiFi 的别人打开你的 Agent 需要访问密码（本机打开免密）

---

## 目录结构

```
phone-vibe/
├─ server.js            主服务（网页 + API + 项目预览反向代理）
├─ src/                 Agent 循环、工具、DeepSeek API 调用、项目管理
├─ public/              聊天界面（PWA，可添加主屏幕）
├─ install.sh           一键安装
├─ start.sh             一键启动 + 自动开浏览器
├─ scripts/termux-boot.sh  开机自启脚本
├─ scripts/start-public.ps1  电脑公网隧道模式（手机零安装）
└─ test/smoke.js        自测脚本
```

技术说明：零 npm 依赖（只有 Node 内置模块），Agent 直接调 DeepSeek 的 chat/completions 流式接口（OpenAI 兼容格式），模型可在 `.env` 里换（默认 `deepseek-v4-pro`）。
