'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const projects = require('./projects');
const config = require('./config');

// ---------------- 工具定义（给大模型的 schema）----------------
const TOOL_DEFS = [
  {
    name: 'list_dir',
    description: '列出目录内容（默认项目根目录，也可以传 ~/storage/shared 这类绝对路径）',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对项目路径或手机存储的绝对路径，默认项目根目录' } },
    },
  },
  {
    name: 'read_file',
    description: '读取文本文件内容（项目内相对路径，或 ~/storage/shared/notes.txt 这类绝对路径）',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对路径或绝对路径' },
        offset: { type: 'number', description: '从第几个字符开始读（可选）' },
        limit: { type: 'number', description: '最多读多少个字符（可选）' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: '创建或覆盖文件（自动创建目录；支持项目内相对路径，也支持 ~/storage/shared/xxx 这类绝对路径）',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对路径（如 index.html），或绝对路径（如 ~/storage/shared/记账/data.json）' },
        content: { type: 'string', description: '文件完整内容' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'delete_file',
    description: '删除文件或目录（会弹窗让用户确认）',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对路径或绝对路径' } },
      required: ['path'],
    },
  },
  {
    name: 'run_command',
    description: '执行一条 shell 命令（默认在项目目录里运行，也可以 cd 到手机存储；涉及删除/下载/安装时会要求用户确认）',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        timeout_seconds: { type: 'number', description: '超时秒数，默认 120，最大 600' },
      },
      required: ['command'],
    },
  },
  {
    name: 'start_project',
    description: '启动当前项目：static=纯静态网页直接托管；node=有后端，自动装依赖并分配端口。启动后手机浏览器里 /p/<项目名>/ 即可访问',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['static', 'node', 'auto'], description: '项目类型，不确定就填 auto' },
        install_deps: { type: 'boolean', description: '是否允许运行 npm install 安装依赖（需要用户确认）' },
      },
    },
  },
  {
    name: 'stop_project',
    description: '停止当前项目',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'search_code',
    description: '在项目文件里搜索文本（类似 grep），用于修改已有项目时定位代码',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '要搜索的文本，如函数名、颜色值、文案' },
        path: { type: 'string', description: '限定子目录，默认整个项目' },
        max_results: { type: 'number', description: '最多返回条数，默认 30' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'edit_file',
    description: '精确替换文件里的一段文本（改已有文件的首选，比 write_file 整篇重写更稳）。old_string 必须与文件内容完全一致，含缩进和换行。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        old_string: { type: 'string', description: '要被替换的原文（要求唯一匹配）' },
        new_string: { type: 'string', description: '替换成的新内容' },
        replace_all: { type: 'boolean', description: '是否替换全部匹配（默认 false）' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'read_url',
    description: '读取网页正文（查资料、看文档用）。自动去掉 HTML 标签，返回纯文本。',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http/https 网址' },
        max_chars: { type: 'number', description: '最多返回多少字符，默认 6000' },
      },
      required: ['url'],
    },
  },
  {
    name: 'http_request',
    description: '调用任意 HTTP 接口（GET/POST/PUT/DELETE），查天气、调 API、抓数据都行。返回状态码和正文。',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http/https 网址' },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'], description: '默认 GET' },
        headers: { type: 'object', description: '请求头对象，如 {"Content-Type":"application/json"}' },
        body: { type: 'string', description: '请求体（POST/PUT 时用）' },
        max_chars: { type: 'number', description: '最多返回多少字符，默认 4000' },
      },
      required: ['url'],
    },
  },
  {
    name: 'apps',
    description: '查看手机里装了哪些 App（列包名），或按包名启动某个 App。用于"帮我打开微信""手机上都有哪些应用"这类需求。',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'open'], description: 'list=列出已安装的第三方 App；open=启动指定包名的 App' },
        app: { type: 'string', description: 'open 时填包名，如 com.tencent.mm（微信）、com.xingin.xhs（小红书）' },
        filter: { type: 'string', description: 'list 时按关键词过滤，例如 tencent、music' },
      },
      required: ['action'],
    },
  },
  {
    name: 'phone',
    description: '直接操作这台手机：打开链接/应用、读写剪贴板、发通知、读电量与 WiFi、发短信、拍照、语音朗读、震动、手电筒、分享文件。需要手机装 Termux:API 应用。',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['open_url', 'open_app', 'clipboard_get', 'clipboard_set', 'notify', 'toast', 'vibrate', 'tts', 'battery', 'wifi', 'sms', 'photo', 'torch', 'share'],
          description: '要执行的动作',
        },
        url: { type: 'string', description: 'open_url 用' },
        app: { type: 'string', description: 'open_app 用，应用包名，如 com.tencent.mm（微信）、com.xingin.xhs（小红书）、com.eg.android.AlipayGphone（支付宝）' },
        text: { type: 'string', description: 'clipboard_set / notify / tts / sms / toast 的内容' },
        title: { type: 'string', description: 'notify 的标题' },
        to: { type: 'string', description: 'sms 的收件号码' },
        path: { type: 'string', description: 'photo 保存路径或 share 的文件路径' },
      },
      required: ['action'],
    },
  },
  {
    name: 'send_message',
    description: '替你发消息。channel=sms 发短信（需确认）；wecom 发企业微信群机器人（需 .env 配 WECOM_WEBHOOK_URL）；qq 发 QQ 机器人消息（需 .env 配 ONEBOT_API_URL，如 NapCat）；share 拉起系统分享面板让用户在微信/QQ 里选人发送；clipboard 复制内容+打开微信/QQ 让用户粘贴。注意：微信个人消息无法全自动发送（微信没有对外接口），share/clipboard 是最接近的替代。',
    input_schema: {
      type: 'object',
      properties: {
        channel: { type: 'string', enum: ['sms', 'wecom', 'qq', 'share', 'clipboard'], description: '发送通道' },
        text: { type: 'string', description: '要发送的内容' },
        to: { type: 'string', description: 'sms=手机号；qq=QQ 号或群号' },
        qq_type: { type: 'string', enum: ['private', 'group'], description: 'qq 通道用：私聊 private（默认）或群 group' },
        app: { type: 'string', description: 'clipboard 通道用：打开哪个 App，如 com.tencent.mm（微信）、com.tencent.mobileqq（QQ）' },
      },
      required: ['channel', 'text'],
    },
  },
];

// ---------------- 危险命令判定 ----------------
const DANGEROUS = [
  { re: /(^|[;&|]\s*|\s)(rm\s+(-\S+\s+)*)/i, label: '删除文件/目录' },
  { re: /\b(rmdir|del|erase)\b/i, label: '删除文件' },
  { re: /\b(curl|wget)\b/i, label: '联网下载' },
  { re: /\bgit\s+clone\b/i, label: '从网络克隆代码' },
  { re: /\bnpm\s+(i|install|add|ci)\b/i, label: '安装 npm 包' },
  { re: /\b(npx|yarn\s+add|pnpm\s+add)\b/i, label: '安装依赖' },
  { re: /\b(pip3?|python\s+-m\s+pip)\s+install\b/i, label: '安装 Python 包' },
  { re: /\b(apt(-get)?|pkg|dnf|yum)\s+(install|upgrade)\b/i, label: '安装系统包' },
];
function dangerOf(cmd) {
  for (const d of DANGEROUS) if (d.re.test(cmd)) return d.label;
  return null;
}

// ---------------- 路径安全 ----------------
// v1.5：默认放开到"整个手机存储"，但系统目录仍然锁死；.env 里 ALLOW_ANY_PATH=0 可回到纯项目沙盒
function isInside(p, root) {
  return p === root || p.startsWith(root + path.sep);
}

function allowedRoots() {
  return [
    os.homedir(),                 // Termux 家目录 ~（含 ~/storage 软链）
    '/sdcard',                    // 内部存储
    '/storage/emulated/0',        // 同上（真实路径）
    '/storage/self/primary',      // 同上（软链）
    os.tmpdir(),                  // 临时目录
    config.projectsDir,           // 项目根目录（可能被单独指到共享存储）
  ].map((p) => path.resolve(p));
}

function expandHome(p) {
  const s = String(p || '');
  if (s === '~') return os.homedir();
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(os.homedir(), s.slice(2));
  return s;
}

function resolveIn(projectDir, rel) {
  const base = path.resolve(projectDir);
  const p = path.resolve(base, expandHome(rel || '.'));
  if (isInside(p, base)) return p; // 项目内：永远允许
  if (!config.allowAnyPath) {
    throw new Error(`路径越界，禁止访问项目目录之外：${rel}（想放开整个手机，把 .env 里 ALLOW_ANY_PATH 设为 1）`);
  }
  const roots = allowedRoots();
  if (!roots.some((r) => isInside(p, r))) {
    throw new Error(`禁止访问系统目录：${rel}（只允许手机存储、Termux 家目录和项目目录）`);
  }
  return p;
}

function shellCmd(cmd) {
  if (process.platform === 'win32') {
    return process.env.SHELL
      ? { sh: process.env.SHELL, args: ['-c', cmd] }
      : { sh: 'cmd.exe', args: ['/d', '/s', '/c', cmd] };
  }
  return { sh: 'bash', args: ['-c', cmd] };
}

function runProcess(sh, args, { cwd, timeoutMs, onChunk, signal }) {
  return new Promise((resolve) => {
    const child = spawn(sh, args, {
      cwd,
      env: { ...process.env },
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const started = Date.now();
    const kill = () => {
      try { projects.killTree(child.pid); } catch { try { child.kill('SIGKILL'); } catch {} }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill(); // Windows 下杀整棵进程树
    }, timeoutMs);
    const onAbort = () => {
      if (settled) return;
      aborted = true;
      kill();
      output = capOutput(output + '\n[已被用户停止]');
      finish({ exitCode: -2, output, durationMs: Date.now() - started, timedOut: false, aborted: true });
    };
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) { try { signal.removeEventListener('abort', onAbort); } catch {} }
      resolve(r);
    };
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const onData = (buf) => {
      const s = buf.toString('utf8');
      output = capOutput(output + s);
      if (onChunk) onChunk(s.slice(0, 2000));
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => {
      output = capOutput(output + `\n[无法执行: ${e.message}]`);
      finish({ exitCode: 127, output, durationMs: Date.now() - started, timedOut: false });
    });
    child.on('close', (code) => {
      finish({ exitCode: code ?? -1, output, durationMs: Date.now() - started, timedOut, aborted });
    });
  });
}

function capOutput(s, max = 8000) {
  if (s.length <= max) return s;
  return s.slice(0, Math.floor(max / 2)) + `\n……(中间 ${s.length - max} 字符已省略)……\n` + s.slice(-Math.floor(max / 2));
}

function fmtSize(n) {
  if (n < 1024) return n + 'B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'KB';
  return (n / 1024 / 1024).toFixed(1) + 'MB';
}

// ---------------- 手机操作（Termux:API）----------------
function shq(s) {
  return "'" + String(s ?? '').replace(/'/g, "'\\''") + "'";
}

// 把 phone 的 action 翻译成一条 shell 命令（便于单测，不直接执行）
function buildPhoneCommand(action, input) {
  const i = input || {};
  switch (action) {
    case 'open_url':
      if (!i.url) return { error: 'open_url 需要 url' };
      return { cmd: `termux-open ${shq(i.url)} 2>/dev/null || am start -a android.intent.action.VIEW -d ${shq(i.url)}` };
    case 'open_app':
      if (!i.app) return { error: 'open_app 需要 app 包名' };
      return { cmd: `monkey -p ${shq(i.app)} -c android.intent.category.LAUNCHER 1` };
    case 'clipboard_get': return { cmd: 'termux-clipboard-get' };
    case 'clipboard_set': return { cmd: `printf '%s' ${shq(i.text)} | termux-clipboard-set` };
    case 'notify': return { cmd: `termux-notification --title ${shq(i.title || 'Lewis')} --content ${shq(i.text || '')}` };
    case 'toast': return { cmd: `termux-toast ${shq(i.text || '')}` };
    case 'vibrate': return { cmd: 'termux-vibrate -d 500 -f' };
    case 'tts': return { cmd: `termux-tts-speak ${shq(i.text || '')}` };
    case 'battery': return { cmd: 'termux-battery-status' };
    case 'wifi': return { cmd: 'termux-wifi-connectioninfo' };
    case 'sms':
      if (!i.to) return { error: 'sms 需要 to 号码' };
      return { cmd: `termux-sms-send -n ${shq(i.to)} ${shq(i.text || '')}` };
    case 'photo':
      return { cmd: i.path ? `termux-camera-photo ${shq(i.path)}` : 'termux-camera-photo "$HOME/storage/shared/DCIM/Lewis-$(date +%s).jpg"' };
    case 'torch': return { cmd: `termux-torch ${i.text === 'off' ? 'off' : 'on'}` };
    case 'share': return { cmd: `termux-share ${shq(i.path || '')}` };
    default: return { error: `不支持的动作：${action}` };
  }
}

// ---------------- 工具执行 ----------------
// ctx: { projectDir, projectName, state: { send, approve, signal } }
async function executeTool(name, input, ctx) {
  const { projectDir, state } = ctx;

  switch (name) {
    case 'list_dir': {
      const p = resolveIn(projectDir, input.path || '.');
      const ents = await fs.promises.readdir(p, { withFileTypes: true });
      const items = [];
      for (const e of ents.slice(0, 200)) {
        let size = null;
        if (e.isFile()) {
          try { size = (await fs.promises.stat(path.join(p, e.name))).size; } catch {}
        }
        items.push({ name: e.name, type: e.isDirectory() ? 'dir' : 'file', size });
      }
      items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
      const data = { cwd: input.path || '.', items, truncated: ents.length > 200 };
      const output = items.length
        ? items.map((i) => `${i.type === 'dir' ? '📁' : '📄'} ${i.name}${i.size != null ? `（${fmtSize(i.size)}）` : '/'}`).join('\n')
        : '（空目录）';
      return { ok: true, summary: `共 ${ents.length} 项`, output, data };
    }
    case 'read_file': {
      const p = resolveIn(projectDir, input.path);
      const buf = await fs.promises.readFile(p);
      let text;
      if (buf.includes(0)) {
        text = `[二进制文件，共 ${buf.length} 字节，前 256 字节 base64：]\n${buf.slice(0, 256).toString('base64')}`;
      } else {
        text = buf.toString('utf8');
        if (text.length > 60000) {
          text = text.slice(0, 60000) + `\n\n[已截断：文件共 ${text.length} 字符，可用 offset/limit 参数继续读]`;
        }
      }
      if (input.offset || input.limit) {
        const o = input.offset || 0;
        text = text.slice(o, input.limit ? o + input.limit : undefined);
      }
      return { ok: true, summary: `读取 ${input.path}（${buf.length} 字节）`, output: text, data: { path: input.path, bytes: buf.length } };
    }
    case 'write_file': {
      const content = String(input.content ?? '');
      const p = resolveIn(projectDir, input.path);
      await fs.promises.mkdir(path.dirname(p), { recursive: true });
      await fs.promises.writeFile(p, content, 'utf8');
      const bytes = Buffer.byteLength(content, 'utf8');
      return { ok: true, summary: `已写入 ${input.path}（${bytes} 字节）`, output: '', data: { path: input.path, bytes } };
    }
    case 'delete_file': {
      const p = resolveIn(projectDir, input.path);
      if (!fs.existsSync(p)) return { ok: false, summary: `${input.path} 不存在`, error: '文件不存在', output: '' };
      await state.approve(`删除文件/目录：${input.path}\n\n删除后不可恢复，确认要删吗？`);
      await fs.promises.rm(p, { recursive: true, force: true });
      return { ok: true, summary: `已删除 ${input.path}`, output: '', data: { path: input.path } };
    }
    case 'run_command': {
      const cmd = String(input.command || '');
      if (!cmd.trim()) return { ok: false, summary: '空命令', error: 'empty command', output: '' };
      const danger = dangerOf(cmd);
      if (danger) {
        await state.approve(`需要确认才能执行（${danger}）：\n\n$ ${cmd}\n\n命令默认在项目目录里运行，但可以 cd 到手机存储。`);
      }
      const timeoutMs = Math.min(Math.max(parseInt(input.timeout_seconds, 10) || 120, 5), 600) * 1000;
      const { sh, args } = shellCmd(cmd);
      const r = await runProcess(sh, args, {
        cwd: projectDir,
        timeoutMs,
        signal: state.signal,
        onChunk: (c) => state.send({ type: 'output', chunk: c, tool: 'run_command' }),
      });
      if (r.aborted) return { ok: false, summary: '已按你的要求停止', error: 'aborted', output: r.output };
      return {
        ok: r.exitCode === 0,
        summary: `退出码 ${r.exitCode}（${(r.durationMs / 1000).toFixed(1)}s）${r.timedOut ? '，已超时终止' : ''}`,
        output: r.output,
        data: { exitCode: r.exitCode, durationMs: r.durationMs, timedOut: r.timedOut },
      };
    }
    case 'start_project': {
      const type = input.type || 'auto';
      const installDeps = !!input.install_deps;
      if (installDeps) {
        await state.approve('将为项目安装 npm 依赖（执行 npm install，需要联网下载，可能要几分钟）：\n\n确认后开始。');
      }
      const r = await projects.startProject(ctx.projectName, {
        type,
        installDeps,
        onLog: (c) => state.send({ type: 'output', chunk: c, tool: 'start_project' }),
      });
      if (!r.ok) return { ok: false, summary: r.error || '启动失败', error: r.error, output: r.log || '' };
      if (r.needsInstall) {
        return { ok: true, summary: '需要先安装依赖', output: '', data: { needsInstall: true, hint: r.hint } };
      }
      return { ok: true, summary: `已启动（端口 ${r.port ?? '静态'}）`, output: r.log || '', data: { url: r.url, port: r.port, type: r.type } };
    }
    case 'stop_project': {
      await projects.stopProject(ctx.projectName);
      return { ok: true, summary: '已停止', output: '', data: {} };
    }
    case 'search_code': {
      const pattern = String(input.pattern || '');
      if (!pattern) return { ok: false, summary: '缺少搜索内容', error: 'empty pattern', output: '' };
      const base = resolveIn(projectDir, input.path || '.');
      const max = Math.min(Math.max(parseInt(input.max_results, 10) || 30, 1), 100);
      const matches = [];
      const walk = (dir) => {
        if (matches.length >= max) return;
        let ents;
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
          if (matches.length >= max) return;
          if (e.name === 'node_modules' || e.name === '.git' || e.name === 'data') continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) walk(full);
          else if (e.isFile() && e.name.endsWith('.js') || e.isFile() && e.name.endsWith('.html') || e.isFile() && e.name.endsWith('.css') || e.isFile() && e.name.endsWith('.json') || e.isFile() && e.name.endsWith('.md')) {
            let text;
            try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
            if (text.length > 200 * 1024) continue;
            const lines = text.split(/\r?\n/);
            for (let i = 0; i < lines.length && matches.length < max; i++) {
              if (lines[i].includes(pattern)) {
                matches.push({
                  file: path.relative(projectDir, full).split(path.sep).join('/'),
                  line: i + 1,
                  text: lines[i].trim().slice(0, 200),
                });
              }
            }
          }
        }
      };
      walk(base);
      const output = matches.length
        ? matches.map((m) => `${m.file}:${m.line}  ${m.text}`).join('\n')
        : `（没有找到「${pattern}」）`;
      return { ok: true, summary: `找到 ${matches.length} 处`, output, data: { matches } };
    }
    case 'edit_file': {
      const p = resolveIn(projectDir, input.path);
      const oldStr = String(input.old_string ?? '');
      const newStr = String(input.new_string ?? '');
      if (!oldStr) return { ok: false, summary: 'old_string 不能为空', error: 'empty old_string', output: '' };
      let text;
      try { text = await fs.promises.readFile(p, 'utf8'); }
      catch (e) { return { ok: false, summary: `读不到 ${input.path}`, error: String(e.message || e), output: '' }; }
      const count = text.split(oldStr).length - 1;
      if (count === 0) return { ok: false, summary: '没找到要替换的内容', error: 'old_string 在文件里不存在，请先用 read_file 确认原文（缩进、换行都要一致）', output: '' };
      if (count > 1 && !input.replace_all) return { ok: false, summary: `匹配到 ${count} 处，未替换`, error: `old_string 不唯一（${count} 处），请给更长的上下文，或设 replace_all: true`, output: '' };
      const out = input.replace_all ? text.split(oldStr).join(newStr) : text.replace(oldStr, newStr);
      await fs.promises.writeFile(p, out, 'utf8');
      return { ok: true, summary: `已替换 ${input.replace_all ? count : 1} 处（${input.path}）`, output: '', data: { path: input.path, replaced: input.replace_all ? count : 1 } };
    }
    case 'read_url': {
      const url = String(input.url || '');
      if (!/^https?:\/\//i.test(url)) return { ok: false, summary: '只支持 http/https 网址', error: 'invalid url', output: '' };
      const max = Math.min(Math.max(parseInt(input.max_chars, 10) || 6000, 500), 20000);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      try {
        const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) LewisAgent/1.6' } });
        const ct = r.headers.get('content-type') || '';
        let body = await r.text();
        clearTimeout(timer);
        if (!r.ok) return { ok: false, summary: `HTTP ${r.status}`, error: `HTTP ${r.status}`, output: body.slice(0, 500) };
        if (/html|xml/i.test(ct)) {
          body = body
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<!--[\s\S]*?-->/g, ' ')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
            .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
        }
        if (body.length > max) body = body.slice(0, max) + `\n\n[已截断：全文约 ${body.length} 字符]`;
        return { ok: true, summary: `读取网页成功（HTTP ${r.status}）`, output: body, data: { url, status: r.status } };
      } catch (e) {
        clearTimeout(timer);
        return { ok: false, summary: '抓取失败', error: String((e && e.message) || e), output: '' };
      }
    }
    case 'http_request': {
      const url = String(input.url || '');
      if (!/^https?:\/\//i.test(url)) return { ok: false, summary: '只支持 http/https 网址', error: 'invalid url', output: '' };
      const method = String(input.method || 'GET').toUpperCase();
      const max = Math.min(Math.max(parseInt(input.max_chars, 10) || 4000, 300), 20000);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      try {
        const r = await fetch(url, {
          method,
          headers: Object.assign({ 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) LewisAgent/1.9' }, input.headers || {}),
          body: method === 'GET' || method === 'HEAD' ? undefined : (input.body || ''),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        let text = await r.text();
        if (text.length > max) text = text.slice(0, max) + `\n\n[已截断：全文约 ${text.length} 字符]`;
        return { ok: r.ok, summary: `${method} ${r.status}`, output: text, data: { status: r.status, url } };
      } catch (e) {
        clearTimeout(timer);
        return { ok: false, summary: '请求失败', error: String((e && e.message) || e), output: '' };
      }
    }
    case 'apps': {
      const action = String(input.action || 'list');
      if (action === 'open') {
        if (!input.app) return { ok: false, summary: 'open 需要 app 包名', error: 'missing app', output: '' };
        const r = await runProcess('bash', ['-c', `monkey -p ${shq(input.app)} -c android.intent.category.LAUNCHER 1`], { cwd: projectDir, timeoutMs: 15000, signal: state.signal });
        const out = (r.output || '').trim();
        return { ok: r.exitCode === 0, summary: r.exitCode === 0 ? `已启动 ${input.app}` : `启动失败（${out.slice(0, 80) || '包名可能不对'}）`, output: out.slice(0, 2000), data: { action, exitCode: r.exitCode } };
      }
      const r = await runProcess('bash', ['-c', 'pm list packages -3 2>/dev/null | sed "s/^package://" | sort'], { cwd: projectDir, timeoutMs: 15000, signal: state.signal });
      let list = (r.output || '').split('\n').map((s) => s.trim()).filter(Boolean);
      const filter = String(input.filter || '').trim();
      if (filter) list = list.filter((p) => p.toLowerCase().includes(filter.toLowerCase()));
      return {
        ok: list.length > 0,
        summary: list.length ? `找到 ${list.length} 个第三方 App` : '没读到应用列表（系统权限限制，安卓 11+ 可能需要额外授权）',
        output: list.slice(0, 300).join('\n'),
        data: { count: list.length },
      };
    }
    case 'phone': {
      const action = String(input.action || '');
      if (action === 'sms') {
        await state.approve(`要替你发短信给 ${input.to || '（没填号码）'}：\n\n${String(input.text || '').slice(0, 300)}`);
      }
      const built = buildPhoneCommand(action, input);
      if (built.error) return { ok: false, summary: built.error, error: built.error, output: '' };
      const r = await runProcess('bash', ['-c', built.cmd], { cwd: projectDir, timeoutMs: 25000, signal: state.signal });
      const output = (r.output || '').trim();
      if (r.exitCode !== 0 && !output) {
        return { ok: false, summary: `${action} 失败`, error: `退出码 ${r.exitCode}（多半是没装 Termux:API 应用，F-Droid 可搜到）`, output: '' };
      }
      const brief = output.replace(/\s+/g, ' ').slice(0, 160);
      return { ok: r.exitCode === 0, summary: `${action} 完成${brief ? '：' + brief : ''}`, output: output.slice(0, 4000), data: { action, exitCode: r.exitCode } };
    }
    case 'send_message': {
      const channel = String(input.channel || '');
      const text = String(input.text || '');
      if (!text) return { ok: false, summary: '发送内容不能为空', error: 'empty text', output: '' };
      if (channel === 'sms') {
        if (!input.to) return { ok: false, summary: 'sms 需要 to 号码', error: 'missing to', output: '' };
        await state.approve(`要替你发短信给 ${input.to}：\n\n${text.slice(0, 300)}`);
        const r = await runProcess('bash', ['-c', `termux-sms-send -n ${shq(input.to)} ${shq(text)}`], { cwd: projectDir, timeoutMs: 20000, signal: state.signal });
        return { ok: r.exitCode === 0, summary: r.exitCode === 0 ? `短信已发给 ${input.to}` : '短信发送失败（可能没装 Termux:API）', output: (r.output || '').slice(0, 800), data: { channel } };
      }
      if (channel === 'wecom') {
        if (!config.wecomWebhook) return { ok: false, summary: '没配置企业微信机器人', error: '在 .env 里填 WECOM_WEBHOOK_URL（企业微信群 → 添加机器人 → 复制 webhook 地址），然后重启服务', output: '' };
        await state.approve(`发消息到企业微信群机器人：\n\n${text.slice(0, 300)}`);
        try {
          const resp = await fetch(config.wecomWebhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ msgtype: 'text', text: { content: text } }), signal: AbortSignal.timeout(15000) });
          const body = await resp.text();
          const ok = resp.ok && body.includes('"errcode":0');
          return { ok, summary: ok ? '已发到企业微信群' : `企业微信返回错误（HTTP ${resp.status}）`, output: body.slice(0, 400), data: { channel } };
        } catch (e) { return { ok: false, summary: '企业微信发送失败', error: String((e && e.message) || e), output: '' }; }
      }
      if (channel === 'qq') {
        if (!config.onebotApi) return { ok: false, summary: '没配置 QQ 机器人', error: '在 .env 里填 ONEBOT_API_URL（如 http://192.168.1.5:3000，NapCat 等 OneBot 协议的 HTTP 接口），然后重启服务', output: '' };
        if (!input.to) return { ok: false, summary: 'qq 需要 to（QQ 号或群号）', error: 'missing to', output: '' };
        await state.approve(`发 QQ 消息给 ${input.to}：\n\n${text.slice(0, 300)}`);
        const path = input.qq_type === 'group' ? '/send_group_msg' : '/send_private_msg';
        const key = input.qq_type === 'group' ? 'group_id' : 'user_id';
        try {
          const resp = await fetch(config.onebotApi + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ [key]: Number(input.to) || input.to, message: text }), signal: AbortSignal.timeout(15000) });
          const body = await resp.text();
          let j = {}; try { j = JSON.parse(body); } catch {}
          const ok = resp.ok && j.status === 'ok';
          return { ok, summary: ok ? `QQ 消息已发给 ${input.to}` : `QQ 机器人返回错误：${j.wording || j.message || body.slice(0, 80)}`, output: body.slice(0, 400), data: { channel } };
        } catch (e) { return { ok: false, summary: 'QQ 机器人发送失败', error: String((e && e.message) || e), output: '' }; }
      }
      if (channel === 'share') {
        await state.approve(`拉起系统分享面板（你在微信/QQ 里选人发送）：\n\n${text.slice(0, 300)}`);
        const cmd = `am start -a android.intent.action.SEND -t text/plain --es android.intent.extra.TEXT ${shq(text)} 2>/dev/null || (printf '%s' ${shq(text)} | termux-clipboard-set)`;
        const r = await runProcess('bash', ['-c', cmd], { cwd: projectDir, timeoutMs: 15000, signal: state.signal });
        const okShare = r.exitCode === 0 && !/Error/.test(r.output || '');
        return { ok: okShare, summary: okShare ? '分享面板已弹出，选人发送即可' : '分享面板没弹出来，内容已复制到剪贴板——手动粘贴发送', output: (r.output || '').slice(0, 400), data: { channel } };
      }
      if (channel === 'clipboard') {
        const app = String(input.app || 'com.tencent.mm');
        const cmd = `printf '%s' ${shq(text)} | termux-clipboard-set && monkey -p ${shq(app)} -c android.intent.category.LAUNCHER 1`;
        const r = await runProcess('bash', ['-c', cmd], { cwd: projectDir, timeoutMs: 15000, signal: state.signal });
        return { ok: r.exitCode === 0, summary: `内容已复制到剪贴板，${app} 已打开——长按输入框粘贴发送`, output: (r.output || '').slice(0, 400), data: { channel } };
      }
      return { ok: false, summary: `不支持的通道：${channel}`, error: 'channel 必须是 sms/wecom/qq/share/clipboard', output: '' };
    }
    default:
      return { ok: false, summary: `未知工具 ${name}`, error: `unknown tool: ${name}`, output: '' };
  }
}

module.exports = { TOOL_DEFS, executeTool, dangerOf, resolveIn, buildPhoneCommand };
