'use strict';
// 手机本机 Vibe Coding —— 主服务（零 npm 依赖，Node >= 18）
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('./src/config');
const store = require('./src/store');
const projects = require('./src/projects');
const { startSSE } = require('./src/sse');
const { runAgent } = require('./src/agent');
const { buildReleaseZip } = require('./scripts/make-release-zip');
const { httpProxy, wsProxy } = require('./src/proxy');
const { ensureIcons } = require('./scripts/gen-icons');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
  '.zip': 'application/zip',
  '.webmanifest': 'application/manifest+json',
};

const activeRuns = new Map(); // sessionId -> { controller }
const approvalResolvers = new Map(); // approvalId -> resolve(allow)

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

function serveFile(res, filePath, { noCache = false } = {}) {
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) return sendJSON(res, 404, { error: '未找到' });
    const headers = {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'X-Content-Type-Options': 'nosniff',
    };
    headers['Cache-Control'] = noCache ? 'no-cache' : 'public, max-age=3600';
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  });
}

// ---------- 主应用静态资源 ----------
function serveApp(res, pathname) {
  const p = pathname === '/' ? '/index.html' : pathname;
  const full = path.join(PUBLIC_DIR, p);
  if (!full.startsWith(PUBLIC_DIR)) return sendJSON(res, 403, { error: '禁止访问' });
  serveFile(res, full, { noCache: true });
}

// ---------- /p/<项目>/ 项目托管 ----------
function serveProject(req, res, pathname, search) {
  try {
    const m = pathname.match(/^\/p\/([^/]+)(\/.*)?$/);
    if (!m) return sendJSON(res, 404, { error: '无效路径' });
    const name = decodeURIComponent(m[1]);
    const rest = m[2] || '/';
    const entry = projects.getProject(name);
    if (entry && entry.type === 'node') {
      req.url = rest + (search || '');
      return httpProxy(req, res, entry.port);
    }
    // 静态：直接读文件（无需显式"启动"）
    const dir = projects.projectPath(name);
    let rel = rest === '/' ? '/index.html' : rest;
    let full = path.join(dir, rel);
    if (!full.startsWith(dir)) return sendJSON(res, 403, { error: '禁止访问' });
    fs.stat(full, (err, st) => {
      if (!err && st.isDirectory()) full = path.join(full, 'index.html');
      else if (err) {
        // SPA 回退：无扩展名的路径返回 index.html
        if (!path.extname(rel)) full = path.join(dir, 'index.html');
        else return sendJSON(res, 404, { error: '文件不存在（项目可能还没创建文件）' });
      }
      serveFile(res, full, { noCache: true });
    });
  } catch (e) {
    return sendJSON(res, 404, { error: String((e && e.message) || e) });
  }
}

// ---------- 聊天（SSE）----------
async function handleChat(req, res) {
  let body;
  try { body = await readBody(req); } catch (e) { return sendJSON(res, 400, { error: e.message }); }
  const message = String(body.message || '').trim();
  if (!message) return sendJSON(res, 400, { error: '消息不能为空' });

  const sse = startSSE(res);
  if (activeRuns.size > 0) {
    sse.send({ type: 'error', message: '已有任务在进行中，请等它完成或点「停止」' });
    return sse.end();
  }
  if (!config.configured && !config.isMock) {
    sse.send({ type: 'error', message: '还没有配置 API Key：请先在顶部横幅里粘贴（只保存在本机 .env，不上传）' });
    return sse.end();
  }

  const project = await projects.ensureProject(body.project || '新项目');
  let session = body.sessionId ? store.loadSession(body.sessionId) : null;
  if (!session) {
    session = {
      id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      project,
      title: message.slice(0, 30),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      events: [],
    };
  }
  session.project = project;
  session.messages = session.messages || [];
  session.events = session.events || [];

  const controller = new AbortController();
  const runKey = session.id;
  activeRuns.set(runKey, { controller });

  const emit = (evt) => {
    session.events.push(evt);
    sse.send(evt);
    if (['tool_result', 'done', 'error', 'cancelled'].includes(evt.type)) {
      try { store.saveSession(session); } catch {}
    }
  };
  const runApprovals = new Set();
  const approve = (question) => new Promise((resolve, reject) => {
    const id = 'ap' + Math.random().toString(36).slice(2, 10);
    runApprovals.add(id);
    approvalResolvers.set(id, (allow) => {
      runApprovals.delete(id);
      if (allow) resolve(true);
      else reject(new Error('用户拒绝了操作'));
    });
    emit({ type: 'approval', approvalId: id, question });
  });

  emit({ type: 'chat_meta', sessionId: session.id, project, title: session.title });
  emit({ type: 'user', text: message });

  // 客户端断开 → 取消任务并拒绝所有待审批
  res.on('close', () => {
    if (activeRuns.get(runKey)?.controller === controller) controller.abort();
    for (const id of runApprovals) {
      const r = approvalResolvers.get(id);
      if (r) { approvalResolvers.delete(id); r(false); }
    }
    runApprovals.clear();
  });

  try {
    await runAgent({
      session, project, message,
      apiKey: config.apiKey, model: config.model,
      controller, emit, approve,
    });
  } catch (e) {
    emit({ type: 'error', message: String((e && e.message) || e) });
  } finally {
    activeRuns.delete(runKey);
    session.updatedAt = Date.now();
    if (session.messages.length > 60) session.messages = session.messages.slice(session.messages.length - 60);
    if (session.events.length > 400) session.events = session.events.slice(session.events.length - 300);
    try { store.saveSession(session); } catch {}
    sse.end();
  }
}

// ---------- API 路由 ----------
async function handleApi(req, res, pathname, method) {
  if (pathname === '/api/state' && method === 'GET') {
    return sendJSON(res, 200, {
      version: config.version,
      allowAnyPath: config.allowAnyPath,
      configured: config.configured,
      keyMasked: config.apiKey ? config.apiKey.slice(0, 7) + '…' + config.apiKey.slice(-4) : '',
      provider: 'deepseek',
      model: config.model,
      port: config.port,
      lanIps: config.lanIPs(),
      projectsDir: config.projectsDir,
      nodeVersion: process.version,
      platform: process.platform,
      mock: config.isMock,
    });
  }
  // 电脑端服务提供安装包下载：手机同 WiFi 下 curl 直接更新，免微信/数据线
  // （安装包已排除 .env，不会泄露 API Key）
  if (pathname === '/api/package' && method === 'GET') {
    try {
      const { zip } = buildReleaseZip();
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="phone-agent-update.zip"',
        'Content-Length': zip.length,
      });
      return res.end(zip);
    } catch (e) {
      return sendJSON(res, 500, { error: '打包失败：' + e.message });
    }
  }
  if (pathname === '/api/settings' && method === 'GET') {
    return sendJSON(res, 200, {
      model: config.model,
      autoOpen: config.autoOpen,
      allowAnyPath: config.allowAnyPath,
      models: ['deepseek-v4-pro', 'deepseek-flash'],
    });
  }
  // 网络体检：本机（跑这个服务的设备）自测 DNS + 到常用目标的 443 连通性。
  // 手机上的 Agent 用 http_request 调 http://<这台设备的IP>:8787/api/netcheck
  // 就能拿到这台设备的网络报告（如：检测电脑的网络情况）
  if (pathname === '/api/netcheck' && method === 'GET') {
    const net = require('net');
    const targets = [
      { host: 'api.deepseek.com', label: 'DeepSeek API' },
      { host: 'github.com', label: 'GitHub' },
      { host: 'www.baidu.com', label: '百度（国内基准）' },
    ];
    const checks = await Promise.all(targets.map(({ host, label }) => new Promise((resolve) => {
      const t0 = Date.now();
      const sock = net.connect({ host, port: 443 });
      sock.setTimeout(6000);
      const done = (r) => { try { sock.destroy(); } catch {} resolve(r); };
      sock.once('connect', () => done({ target: host, label, ok: true, ms: Date.now() - t0 }));
      sock.once('timeout', () => done({ target: host, label, ok: false, ms: null, error: 'timeout' }));
      sock.once('error', (e) => done({ target: host, label, ok: false, ms: null, error: e.code || e.message }));
    })));
    const allOk = checks.every((c) => c.ok);
    return sendJSON(res, 200, {
      ts: Date.now(),
      device: os.hostname(),
      lanIps: config.lanIPs(),
      summary: allOk ? '网络正常：三个目标全部连通' : '有目标连不通：' + checks.filter((c) => !c.ok).map((c) => c.label).join('、'),
      checks,
    });
  }
  if (pathname === '/api/settings' && method === 'POST') {
    const body = await readBody(req);
    try {
      if (body.model && /^[a-zA-Z0-9._-]{2,40}$/.test(body.model)) config.saveSetting('MODEL', body.model);
      if (body.autoOpen !== undefined) config.saveSetting('AUTO_OPEN', body.autoOpen ? '1' : '0');
      if (body.allowAnyPath !== undefined) config.saveSetting('ALLOW_ANY_PATH', body.allowAnyPath ? '1' : '0');
    } catch (e) {
      return sendJSON(res, 400, { error: '保存失败：' + e.message });
    }
    return sendJSON(res, 200, { ok: true, model: config.model, autoOpen: config.autoOpen, allowAnyPath: config.allowAnyPath });
  }
  if (pathname === '/api/backup' && method === 'GET') {
    try {
      const zip = await projects.backupAll();
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="PhoneProjects-backup.zip"',
        'Content-Length': zip.length,
      });
      return res.end(zip);
    } catch (e) {
      return sendJSON(res, 500, { error: '备份失败：' + e.message });
    }
  }
  if (pathname === '/api/key' && method === 'POST') {
    const body = await readBody(req);
    if (!body.apiKey || !String(body.apiKey).trim()) return sendJSON(res, 400, { error: 'API Key 不能为空' });
    config.saveApiKey(String(body.apiKey).trim());
    return sendJSON(res, 200, { ok: true, mock: config.isMock });
  }
  if (pathname === '/api/projects' && method === 'GET') {
    return sendJSON(res, 200, await projects.listProjects());
  }
  if (pathname === '/api/projects' && method === 'POST') {
    const body = await readBody(req);
    const name = await projects.createProject(body.name || '新项目');
    return sendJSON(res, 200, { ok: true, name });
  }
  let m = pathname.match(/^\/api\/project\/([^/]+)\/(run|stop|export|delete)$/);
  if (m) {
    const name = decodeURIComponent(m[1]);
    const action = m[2];
    if (action === 'run') {
      const body = await readBody(req);
      const r = await projects.startProject(name, { type: body.type || 'auto', installDeps: body.install !== false });
      return sendJSON(res, r.ok ? 200 : 500, r);
    }
    if (action === 'stop') { await projects.stopProject(name); return sendJSON(res, 200, { ok: true }); }
    if (action === 'delete') { await projects.deleteProject(name); return sendJSON(res, 200, { ok: true }); }
    if (action === 'export') {
      try {
        const zip = await projects.exportZip(name);
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${encodeURIComponent(name)}.zip"`,
          'Content-Length': zip.length,
        });
        return res.end(zip);
      } catch (e) {
        return sendJSON(res, 500, { error: '导出失败：' + e.message });
      }
    }
  }
  if (pathname === '/api/history' && method === 'GET') {
    const project = new URL(req.url, 'http://x').searchParams.get('project');
    return sendJSON(res, 200, store.listSessions(project || null));
  }
  m = pathname.match(/^\/api\/history\/([^/]+)$/);
  if (m) {
    if (method === 'GET') {
      const s = store.loadSession(m[1]);
      return s ? sendJSON(res, 200, s) : sendJSON(res, 404, { error: '会话不存在' });
    }
    if (method === 'DELETE') { store.deleteSession(m[1]); return sendJSON(res, 200, { ok: true }); }
  }
  if (pathname === '/api/approve' && method === 'POST') {
    const body = await readBody(req);
    const resolve = approvalResolvers.get(body.approvalId);
    if (resolve) {
      approvalResolvers.delete(body.approvalId);
      resolve(!!body.allow);
      return sendJSON(res, 200, { ok: true });
    }
    return sendJSON(res, 404, { error: '审批已失效（任务可能已结束）' });
  }
  if (pathname === '/api/cancel' && method === 'POST') {
    const body = await readBody(req);
    const run = activeRuns.get(body.sessionId);
    if (run) run.controller.abort();
    return sendJSON(res, 200, { ok: true });
  }
  if (pathname === '/api/chat' && method === 'POST') return handleChat(req, res);
  return sendJSON(res, 404, { error: '接口不存在' });
}

// ---------- 访问密码（只在公网/局域网访问时要求，本机 127.0.0.1 免密） ----------
// 从 .env 的 ACCESS_TOKEN 读（install.sh 首次安装自动生成）；进程环境变量优先（start-public.ps1 用）
const ACCESS_TOKEN = String(process.env.ACCESS_TOKEN || config.accessToken || '').trim();
// 公网隧道模式（start-public.ps1 设 PUBLIC_MODE=1）：cloudflared 转发过来的请求
// 看起来都来自 127.0.0.1，loopback 免密会形同虚设——此模式下所有人（含本机）都要密码
const PUBLIC_MODE = String(process.env.PUBLIC_MODE || '').trim() === '1';

function isLoopback(req) {
  const ip = String((req.socket && req.socket.remoteAddress) || '');
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function checkAuth(req, res) {
  if (!ACCESS_TOKEN) return true;
  if (!PUBLIC_MODE && isLoopback(req)) return true;
  const h = String(req.headers.authorization || '');
  if (h.startsWith('Basic ')) {
    try {
      const dec = Buffer.from(h.slice(6), 'base64').toString('utf8');
      const pass = dec.slice(dec.indexOf(':') + 1);
      if (pass === ACCESS_TOKEN) return true;
    } catch {}
  }
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="Phone Agent", charset="UTF-8"',
    'Content-Type': 'text/plain; charset=utf-8',
  });
  res.end('需要访问密码（用户名随便填，密码在电脑的启动窗口里）');
  return false;
}

// ---------- 主服务 ----------
const server = http.createServer(async (req, res) => {
  let pathname, search;
  try {
    const u = new URL(req.url, 'http://x');
    pathname = decodeURIComponent(u.pathname);
    search = u.search;
  } catch {
    return sendJSON(res, 400, { error: '路径编码错误' });
  }
  if (!checkAuth(req, res)) return;
  try {
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname, req.method);
    if (pathname.startsWith('/p/')) return serveProject(req, res, pathname, search);
    return serveApp(res, pathname);
  } catch (e) {
    if (!res.headersSent) return sendJSON(res, 500, { error: String((e && e.message) || e) });
    return res.end();
  }
});

server.on('upgrade', (req, socket, head) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { return socket.destroy(); }
  const m = pathname.match(/^\/p\/([^/]+)(\/.*)?$/);
  if (!m) return socket.destroy();
  const entry = projects.getProject(decodeURIComponent(m[1]));
  if (!entry || entry.type !== 'node') return socket.destroy();
  req.url = m[2] || '/';
  wsProxy(req, socket, head, entry.port);
});

ensureIcons(); // PWA 图标缺失时自动生成（无需手动跑脚本）
server.listen(config.port, '0.0.0.0', () => {
  console.log('');
  console.log('════════════════════════════════════════════════');
  console.log('  📱 手机版 Agent 已启动');
  console.log(`  本机访问:   http://127.0.0.1:${config.port}`);
  for (const ip of config.lanIPs()) {
    console.log(`  局域网访问: http://${ip}:${config.port}  (同一 WiFi 的手机/电脑可打开)`);
  }
  console.log(`  项目目录:   ${config.projectsDir}`);
  console.log(`  模型:       ${config.model}`);
  if (config.isMock) console.log('  API Key:    演示模式（mock）—— 填入真实 Key 后生效');
  else if (config.configured) console.log('  API Key:    已配置');
  else console.log('  API Key:    未配置 —— 打开网页后在顶部横幅里粘贴');
  if (ACCESS_TOKEN) console.log(`  访问密码:   ${ACCESS_TOKEN}  （局域网/公网打开时需要，本机免密）`);
  console.log('════════════════════════════════════════════════');
});

async function shutdown() {
  try { await projects.stopAll(); } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
