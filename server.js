'use strict';
// 手机本机 Vibe Coding —— 主服务（零 npm 依赖，Node >= 18）
const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./src/config');
const store = require('./src/store');
const projects = require('./src/projects');
const { startSSE } = require('./src/sse');
const { runAgent } = require('./src/agent');
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
    if (session.events.length > 2000) session.events = session.events.slice(session.events.length - 1500);
    try { store.saveSession(session); } catch {}
    sse.end();
  }
}

// ---------- API 路由 ----------
async function handleApi(req, res, pathname, method) {
  if (pathname === '/api/state' && method === 'GET') {
    return sendJSON(res, 200, {
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
  console.log(`  本机访问:   http://localhost:${config.port}`);
  for (const ip of config.lanIPs()) {
    console.log(`  局域网访问: http://${ip}:${config.port}  (同一 WiFi 的手机/电脑可打开)`);
  }
  console.log(`  项目目录:   ${config.projectsDir}`);
  console.log(`  模型:       ${config.model}`);
  if (config.isMock) console.log('  API Key:    演示模式（mock）—— 填入真实 Key 后生效');
  else if (config.configured) console.log('  API Key:    已配置');
  else console.log('  API Key:    未配置 —— 打开网页后在顶部横幅里粘贴');
  console.log('════════════════════════════════════════════════');
});

async function shutdown() {
  try { await projects.stopAll(); } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
