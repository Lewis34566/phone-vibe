'use strict';
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn, execSync } = require('child_process');
const config = require('./config');
const { buildZip } = require('./zipstore');

// 运行中的项目注册表：name -> { type, port, proc, startedAt, log }
const registry = new Map();

function projectPath(name) {
  const p = path.join(config.projectsDir, name);
  if (p !== config.projectsDir && !p.startsWith(config.projectsDir + path.sep)) {
    throw new Error('非法项目名');
  }
  return p;
}

function sanitizeName(name) {
  let n = String(name || '').trim().replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '');
  if (!n) n = 'project';
  if (n.length > 40) n = n.slice(0, 40);
  return n;
}

async function listProjects() {
  await fs.promises.mkdir(config.projectsDir, { recursive: true });
  const names = await fs.promises.readdir(config.projectsDir);
  const out = [];
  for (const name of names) {
    const p = path.join(config.projectsDir, name);
    let st;
    try { st = await fs.promises.stat(p); } catch { continue; }
    if (!st.isDirectory()) continue;
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(p, 'meta.json'), 'utf8')); } catch {}
    const run = registry.get(name);
    out.push({
      name,
      title: meta.title || name,
      desc: meta.desc || '',
      createdAt: meta.createdAt || st.mtimeMs,
      running: !!run,
      port: run?.port || null,
      type: run?.type || meta.type || 'static',
      url: `/p/${encodeURIComponent(name)}/`,
    });
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

async function createProject(name) {
  const n = sanitizeName(name);
  const p = projectPath(n);
  await fs.promises.mkdir(p, { recursive: true });
  const metaFile = path.join(p, 'meta.json');
  if (!fs.existsSync(metaFile)) {
    fs.writeFileSync(metaFile, JSON.stringify({ name: n, title: n, desc: '', createdAt: Date.now() }, null, 2));
  }
  return n;
}

async function ensureProject(name) {
  const n = sanitizeName(name);
  const p = projectPath(n);
  if (!fs.existsSync(p)) await createProject(n);
  return n;
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

// 杀整棵进程树：Windows 用 taskkill /T（kill 只杀直接子进程，npm->node 会漏）
function killTree(pid) {
  if (process.platform === 'win32') {
    try { execSync(`taskkill /T /F /PID ${pid}`, { stdio: 'ignore' }); } catch {}
    // 兜底：/T 偶尔漏掉 bash->npm 链条，按父进程链再扫一遍逐个杀
    try {
      const ids = [];
      const collect = (p) => {
        let out = '';
        try {
          out = execSync(
            `powershell.exe -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"ParentProcessId=${p}\\" | Select-Object -ExpandProperty ProcessId) -join ','"`,
            { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }
          ).trim();
        } catch {}
        for (const id of out.split(',').filter(Boolean)) {
          ids.push(id);
          collect(Number(id));
        }
      };
      collect(pid);
      if (ids.length) execSync(`taskkill /F /PID ${ids.join(' /PID ')}`, { stdio: 'ignore' });
    } catch {}
    return;
  }
  try {
    if (process.platform === 'win32') process.kill(pid, 'SIGKILL');
    else process.kill(-pid, 'SIGKILL');
  } catch {}
}

function shellCmd(cmd) {
  if (process.platform === 'win32') {
    return process.env.SHELL
      ? { sh: process.env.SHELL, args: ['-c', cmd] }
      : { sh: 'cmd.exe', args: ['/d', '/s', '/c', cmd] };
  }
  return { sh: 'bash', args: ['-c', cmd] };
}

async function runShell(cmd, { cwd, timeoutMs, onLog }) {
  return new Promise((resolve) => {
    const { sh, args } = shellCmd(cmd);
    const child = spawn(sh, args, {
      cwd,
      env: { ...process.env },
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const onData = (buf) => {
      const s = buf.toString('utf8');
      output = output.length < 20000 ? output + s : output.slice(-18000) + s.slice(-2000);
      if (onLog) onLog(s);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => { finish({ exitCode: 127, output: output + `\n[无法执行: ${e.message}]`, timedOut: false }); });
    child.on('close', (code) => { finish({ exitCode: code ?? -1, output, timedOut }); });
  });
}

function detectStart(cwd) {
  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')); } catch {}
  // Windows 上走 cmd.exe 时 npm 需要 .cmd 后缀；走 Git Bash 的 bash 时用 npm 脚本即可
  const npm = process.platform === 'win32' && !process.env.SHELL ? 'npm.cmd' : 'npm';
  if (pkg?.scripts?.start) return { cmd: `${npm} start` };
  for (const f of ['server.js', 'index.js', 'app.js']) {
    if (fs.existsSync(path.join(cwd, f))) return { cmd: `node ${f}` };
  }
  return null;
}

async function waitHttp(port, timeoutMs, isAlive) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (isAlive && !isAlive()) return false;
    try {
      await new Promise((resolve, reject) => {
        const r = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, (res) => {
          res.resume();
          resolve();
        });
        r.on('error', reject);
      });
      return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// ---------------- 启动 / 停止 ----------------
async function startProject(name, { type = 'auto', installDeps = false, onLog } = {}) {
  const n = await ensureProject(name);
  const cwd = projectPath(n);
  await stopProject(n);

  const hasPackage = fs.existsSync(path.join(cwd, 'package.json'));
  const mode = type === 'auto' ? (hasPackage ? 'node' : 'static') : type;

  if (mode === 'node') {
    let pkg = null;
    try { pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')); } catch {}
    const deps = Object.keys({ ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) });
    const hasModules = fs.existsSync(path.join(cwd, 'node_modules'));
    if (deps.length && !hasModules && !installDeps) {
      return {
        ok: true,
        needsInstall: true,
        hint: 'package.json 声明了依赖但还没安装。请再次调用 start_project，并传 install_deps: true',
      };
    }
    if (deps.length && installDeps) {
      if (onLog) onLog('\n[正在安装依赖：npm install]\n');
      const npm = process.platform === 'win32' && !process.env.SHELL ? 'npm.cmd' : 'npm';
      const r = await runShell(`${npm} install --no-fund --no-audit --loglevel=error`, { cwd, timeoutMs: 600000, onLog });
      if (r.exitCode !== 0) {
        return { ok: false, error: `npm install 失败（退出码 ${r.exitCode}）`, log: r.output };
      }
      if (onLog) onLog('\n[依赖安装完成]\n');
    }
    const start = detectStart(cwd);
    if (!start) {
      return { ok: false, error: '找不到启动方式：需要 package.json 的 start 脚本，或 server.js / index.js / app.js' };
    }
    const port = await freePort();
    const { sh, args } = shellCmd(start.cmd);
    const child = spawn(sh, args, {
      cwd,
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', BROWSER: 'none' },
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    const onData = (buf) => {
      const s = buf.toString('utf8');
      log = (log + s).slice(-4000);
      if (onLog) onLog(s.slice(0, 2000));
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => { log += `\n[启动失败: ${e.message}]`; });
    const entry = { type: 'node', port, proc: child, startedAt: Date.now(), log };
    registry.set(n, entry);
    child.on('exit', (code) => {
      if (registry.get(n) === entry) registry.delete(n);
      entry.log = log;
      if (onLog) onLog(`\n[进程退出，code=${code}]`);
    });
    const ok = await waitHttp(port, 25000, () => entry.proc.exitCode !== null);
    entry.log = log;
    if (!ok) {
      if (entry.proc.exitCode !== null) {
        registry.delete(n);
        return { ok: false, error: `项目启动后立刻退出（exit=${entry.proc.exitCode}）`, log };
      }
      return { ok: true, started: false, port, type: 'node', url: `/p/${encodeURIComponent(n)}/`, log, error: '25 秒内没有响应，可能还在启动，稍后再试' };
    }
    return { ok: true, started: true, port, type: 'node', url: `/p/${encodeURIComponent(n)}/`, log };
  }

  // static：直接由主服务托管，无需子进程
  registry.set(n, { type: 'static', port: null, proc: null, startedAt: Date.now(), log: '' });
  return { ok: true, started: true, port: null, type: 'static', url: `/p/${encodeURIComponent(n)}/` };
}

async function stopProject(name) {
  const n = sanitizeName(name);
  const entry = registry.get(n);
  if (!entry) return;
  if (entry.type === 'node' && entry.proc) {
    const child = entry.proc;
    try {
      if (process.platform === 'win32') killTree(child.pid);
      else process.kill(-child.pid, 'SIGTERM');
    } catch {}
    await new Promise((r) => setTimeout(r, 800));
    if (child.exitCode === null) {
      try {
        if (process.platform === 'win32') killTree(child.pid);
        else process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }
  }
  registry.delete(n);
}

async function stopAll() {
  for (const name of [...registry.keys()]) await stopProject(name);
}

function getProject(name) { return registry.get(sanitizeName(name)); }

async function deleteProject(name) {
  const n = sanitizeName(name);
  await stopProject(n);
  await fs.promises.rm(projectPath(n), { recursive: true, force: true });
}

// 递归收集文件，做成 zip（跳过 node_modules 和 .git）
async function collectFiles(dir, base) {
  const out = [];
  const ents = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const e of ents) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const full = path.join(dir, e.name);
    const rel = path.join(base, e.name).split(path.sep).join('/');
    if (e.isDirectory()) {
      out.push(...await collectFiles(full, rel));
    } else if (e.isFile()) {
      let size = 0;
      try { size = (await fs.promises.stat(full)).size; } catch {}
      if (size > 50 * 1024 * 1024) continue; // 跳过超大文件
      const data = await fs.promises.readFile(full);
      out.push({ name: rel, data, mtime: Date.now() });
    }
  }
  return out;
}

async function exportZip(name) {
  const n = sanitizeName(name);
  const files = await collectFiles(projectPath(n), n);
  return buildZip(files);
}

module.exports = {
  listProjects, createProject, ensureProject, startProject, stopProject, stopAll,
  getProject, deleteProject, exportZip, projectPath, sanitizeName, killTree,
};
