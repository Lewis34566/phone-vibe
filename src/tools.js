'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const projects = require('./projects');

// ---------------- 工具定义（给大模型的 schema）----------------
const TOOL_DEFS = [
  {
    name: 'list_dir',
    description: '列出项目目录下（或指定子目录）的文件和文件夹',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对路径，默认项目根目录' } },
    },
  },
  {
    name: 'read_file',
    description: '读取项目内的文本文件内容',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对路径' },
        offset: { type: 'number', description: '从第几个字符开始读（可选）' },
        limit: { type: 'number', description: '最多读多少个字符（可选）' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: '创建或覆盖项目内的文件（自动创建目录）',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对路径，如 index.html 或 src/app.js' },
        content: { type: 'string', description: '文件完整内容' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'delete_file',
    description: '删除项目内的文件或目录（会弹窗让用户确认）',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对路径' } },
      required: ['path'],
    },
  },
  {
    name: 'run_command',
    description: '在项目目录里执行一条命令（涉及删除/下载/安装时会要求用户确认）',
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
function resolveIn(projectDir, rel) {
  const base = path.resolve(projectDir);
  const p = path.resolve(base, rel || '.');
  if (p !== base && !p.startsWith(base + path.sep)) {
    throw new Error(`路径越界，禁止访问项目目录之外：${rel}`);
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

function runProcess(sh, args, { cwd, timeoutMs, onChunk }) {
  return new Promise((resolve) => {
    const child = spawn(sh, args, {
      cwd,
      env: { ...process.env },
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let timedOut = false;
    let settled = false;
    const started = Date.now();
    const timer = setTimeout(() => {
      timedOut = true;
      projects.killTree(child.pid); // Windows 下杀整棵进程树
    }, timeoutMs);
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
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
      finish({ exitCode: code ?? -1, output, durationMs: Date.now() - started, timedOut });
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
      await state.approve(`删除文件/目录：${input.path}\n\n（项目目录内的操作，删除后不可恢复）`);
      await fs.promises.rm(p, { recursive: true, force: true });
      return { ok: true, summary: `已删除 ${input.path}`, output: '', data: { path: input.path } };
    }
    case 'run_command': {
      const cmd = String(input.command || '');
      if (!cmd.trim()) return { ok: false, summary: '空命令', error: 'empty command', output: '' };
      const danger = dangerOf(cmd);
      if (danger) {
        await state.approve(`需要确认才能执行（${danger}）：\n\n$ ${cmd}\n\n此命令只在项目目录内运行。`);
      }
      const timeoutMs = Math.min(Math.max(parseInt(input.timeout_seconds, 10) || 120, 5), 600) * 1000;
      const { sh, args } = shellCmd(cmd);
      const r = await runProcess(sh, args, {
        cwd: projectDir,
        timeoutMs,
        onChunk: (c) => state.send({ type: 'output', chunk: c, tool: 'run_command' }),
      });
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
    default:
      return { ok: false, summary: `未知工具 ${name}`, error: `unknown tool: ${name}`, output: '' };
  }
}

module.exports = { TOOL_DEFS, executeTool, dangerOf, resolveIn };
