'use strict';
const $ = (s) => document.querySelector(s);
const state = {
  projects: [], current: null, session: null,
  running: false, configured: true, lanIps: [], port: 8787,
  stepEl: null, textEl: null, textRaw: '',
};

const TOOL_LABELS = {
  list_dir: '📂 查看目录', read_file: '📄 读文件', write_file: '✍️ 写文件',
  delete_file: '🗑️ 删除', run_command: '⚙️ 执行命令', start_project: '🚀 启动项目', stop_project: '⏹️ 停止项目',
};

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) {
    let msg = 'HTTP ' + r.status;
    try { msg = (await r.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  return r.json();
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 轻量 markdown：代码块 + 行内代码 + 粗体
function md(s) {
  let t = esc(s);
  t = t.replace(/```(\w*)\n?([\s\S]*?)```/g, (m, lang, code) => '<pre class="md-code">' + code + '</pre>');
  t = t.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  return t;
}

function scrollBottom(force) {
  const log = $('#log');
  if (force || log.scrollTop + log.clientHeight >= log.scrollHeight - 160) log.scrollTop = log.scrollHeight;
}

function bubble(cls) {
  const div = document.createElement('div');
  div.className = 'msg ' + cls;
  if (cls === 'ai') {
    const name = document.createElement('div');
    name.className = 'aname';
    name.textContent = 'Lewis';
    div.appendChild(name);
  }
  $('#log').appendChild(div);
  return div;
}

function clearLog() {
  $('#log').innerHTML = '';
  state.textEl = null; state.textRaw = ''; state.stepEl = null;
}

// ---------- 视图切换 ----------
function show(view) {
  $('#viewChat').classList.toggle('hidden', view !== 'chat');
  $('#viewProjects').classList.toggle('hidden', view !== 'projects');
  $('#btnProjects').classList.toggle('active', view === 'projects');
}
$('#btnProjects').addEventListener('click', () => {
  show($('#viewProjects').classList.contains('hidden') ? 'projects' : 'chat');
  if (!$('#viewProjects').classList.contains('hidden')) loadProjects();
});

// ---------- 项目列表 ----------
async function loadProjects() {
  try {
    state.projects = await api('/api/projects');
  } catch (e) { state.projects = []; }
  renderProjects();
}

function renderProjects() {
  const list = $('#projectList');
  list.innerHTML = '';
  if (!state.projects.length) {
    list.innerHTML = '<div class="empty">还没有项目。新建一个，或回到聊天直接说需求（会自动建项目）。</div>';
  }
  for (const p of state.projects) {
    const card = document.createElement('div');
    card.className = 'project-card';
    const badge = p.running
      ? `<span class="badge on">● 运行中${p.port ? ' :' + p.port : ''}</span>`
      : '<span class="badge">○ 未运行</span>';
    card.innerHTML = `
      <div class="pc-head"><div class="pc-title">${esc(p.title)}</div>${badge}</div>
      <div class="pc-desc">${esc(p.desc || p.name)}</div>
      <div class="pc-actions">
        ${p.running ? '<button data-act="stop">⏹ 停止</button>' : '<button data-act="run">▶ 运行</button>'}
        <button data-act="open">🌐 打开</button>
        <button data-act="export">⬇ 导出</button>
        <button data-act="chat">💬 用 AI 改</button>
        <button data-act="del" class="danger">🗑</button>
      </div>`;
    card.addEventListener('click', (e) => {
      const act = e.target.dataset.act;
      if (act) projectAction(p, act);
    });
    list.appendChild(card);
  }
  $('#lanInfo').innerHTML = state.lanIps.length
    ? `📶 局域网访问：${state.lanIps.map((ip) => `http://${ip}:${state.port}`).join('　')}`
    : '';
}

async function projectAction(p, act) {
  try {
    if (act === 'run') {
      const r = await api(`/api/project/${encodeURIComponent(p.name)}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'auto', install: true }),
      });
      if (r.ok === false) throw new Error(r.error || '启动失败');
      await loadProjects();
      if (r.error) alert('进程已启动，但：' + r.error);
      else window.open('/p/' + encodeURIComponent(p.name) + '/', '_blank');
    } else if (act === 'stop') {
      await api(`/api/project/${encodeURIComponent(p.name)}/stop`, { method: 'POST' });
      await loadProjects();
    } else if (act === 'open') {
      window.open('/p/' + encodeURIComponent(p.name) + '/', '_blank');
    } else if (act === 'export') {
      window.location.href = `/api/project/${encodeURIComponent(p.name)}/export`;
    } else if (act === 'chat') {
      await selectProject(p.name);
      show('chat');
    } else if (act === 'del') {
      if (confirm(`确定删除项目「${p.title}」？项目文件会全部删除，不可恢复。`)) {
        await api(`/api/project/${encodeURIComponent(p.name)}/delete`, { method: 'POST' });
        if (state.current === p.name) { state.current = null; state.session = null; clearLog(); $('#projectName').textContent = '—'; }
        await loadProjects();
      }
    }
  } catch (e) {
    alert(e.message);
  }
}

$('#newProjectForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#newProjectName').value.trim();
  if (!name) return;
  try {
    const r = await api('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    $('#newProjectName').value = '';
    await loadProjects();
    await selectProject(r.name);
    show('chat');
  } catch (err) { alert(err.message); }
});

// ---------- 会话历史 ----------
async function openHistory() {
  let sessions = [];
  try { sessions = await api('/api/history?project=' + encodeURIComponent(state.current || '')); } catch {}
  const card = $('#modalCard');
  card.innerHTML = '<div class="modal-title">🕘 会话历史（' + esc(state.current || '全部') + '）<button class="close" id="mClose">✕</button></div>';
  if (!sessions.length) card.innerHTML += '<div class="empty">还没有历史会话</div>';
  const list = document.createElement('div');
  for (const s of sessions) {
    const row = document.createElement('div');
    row.className = 'hist-row';
    row.innerHTML = `<div class="hist-main"><div class="hist-title">${esc(s.title)}</div>
      <div class="hist-time">${new Date(s.updatedAt).toLocaleString('zh-CN')}</div></div>
      <button data-act="del" title="删除">🗑</button>`;
    row.addEventListener('click', async (e) => {
      if (e.target.dataset.act === 'del') {
        if (!confirm('删除这个会话？')) return;
        await api('/api/history/' + s.id, { method: 'DELETE' });
        if (state.session && state.session.id === s.id) { state.session = null; clearLog(); }
        return openHistory();
      }
      try {
        await loadSession(s.id);
        hideModal();
      } catch (err) { alert(err.message); }
    });
    list.appendChild(row);
  }
  card.appendChild(list);
  $('#modal').classList.remove('hidden');
}

function hideModal() { $('#modal').classList.add('hidden'); }
$('#modal').addEventListener('click', (e) => {
  if (e.target.id === 'modal' || e.target.id === 'mClose') hideModal();
});
$('#btnHistory').addEventListener('click', openHistory);

async function loadSession(id) {
  const s = await api('/api/history/' + id);
  state.session = s;
  clearLog();
  for (const evt of s.events || []) renderEvent(evt, true);
  scrollBottom(true);
}

// ---------- 事件渲染 ----------
function renderEvent(evt, replay) {
  switch (evt.type) {
    case 'user': {
      const b = bubble('user');
      b.innerHTML = '<div class="bubble">' + esc(evt.text) + '</div>';
      state.textEl = null; state.textRaw = ''; state.stepEl = null;
      scrollBottom(true);
      break;
    }
    case 'text': {
      if (!state.textEl) {
        const b = bubble('ai');
        state.textEl = document.createElement('div');
        state.textEl.className = 'bubble md';
        b.appendChild(state.textEl);
      }
      state.textRaw += evt.delta;
      state.textEl.innerHTML = md(state.textRaw);
      state.stepEl = null;
      scrollBottom();
      break;
    }
    case 'tool_call': {
      state.textEl = null; state.textRaw = '';
      const b = bubble('ai');
      const step = document.createElement('div');
      step.className = 'step';
      const label = TOOL_LABELS[evt.name] || evt.name;
      let detail = '';
      const inp = evt.input || {};
      if (evt.name === 'write_file') {
        detail = esc(inp.path || '');
        if (inp.content) detail += '<pre class="preview">' + esc(inp.content) + '</pre>';
      } else if (evt.name === 'run_command') {
        detail = '<pre class="cmd">$ ' + esc(inp.command || '') + '</pre>';
      } else if (evt.name === 'start_project') {
        detail = '类型：' + esc(inp.type || 'auto') + (inp.install_deps ? '（装依赖）' : '');
      } else if (inp.path) {
        detail = esc(inp.path);
      }
      step.innerHTML = `<div class="step-head"><span class="step-label">${label}</span><span class="step-status">…</span></div>
        ${detail ? '<div class="step-detail">' + detail + '</div>' : ''}
        <pre class="step-out hidden"></pre>`;
      b.appendChild(step);
      state.stepEl = step;
      scrollBottom(true);
      break;
    }
    case 'output': {
      if (!state.stepEl) break;
      const out = state.stepEl.querySelector('.step-out');
      out.classList.remove('hidden');
      out.textContent = (out.textContent + evt.chunk).slice(-3000);
      out.scrollTop = out.scrollHeight;
      scrollBottom();
      break;
    }
    case 'tool_result': {
      if (!state.stepEl) break;
      const st = state.stepEl.querySelector('.step-status');
      st.textContent = evt.ok ? '✓' : '✗';
      st.className = 'step-status ' + (evt.ok ? 'ok' : 'err');
      const out = state.stepEl.querySelector('.step-out');
      if (evt.output) {
        out.textContent = (out.textContent ? out.textContent + '\n' : '') + evt.output;
        out.textContent = out.textContent.slice(-3000);
        out.classList.remove('hidden');
      }
      if (evt.needsInstall) {
        const warn = document.createElement('div');
        warn.className = 'step-warn';
        warn.textContent = '⚠️ 需要安装依赖：AI 会发起确认，请点「允许」';
        state.stepEl.appendChild(warn);
      }
      if (evt.summary) {
        const sum = document.createElement('div');
        sum.className = 'step-sum';
        sum.textContent = evt.summary;
        state.stepEl.appendChild(sum);
      }
      state.stepEl = null;
      scrollBottom(true);
      break;
    }
    case 'approval': {
      if (replay) break; // 历史回放不显示审批卡
      state.textEl = null; state.textRaw = ''; state.stepEl = null;
      const b = bubble('ai');
      const card = document.createElement('div');
      card.className = 'approval';
      card.innerHTML = `<div class="approval-title">⚠️ 需要你的确认</div>
        <pre class="approval-q">${esc(evt.question)}</pre>
        <div class="approval-btns">
          <button data-v="1">✅ 允许</button>
          <button data-v="0" class="danger">✋ 拒绝</button>
        </div>
        <div class="approval-state"></div>`;
      card.addEventListener('click', async (e) => {
        const v = e.target.dataset.v;
        if (v === undefined) return;
        card.querySelector('.approval-state').textContent = v === '1' ? '已允许，继续…' : '已拒绝';
        card.querySelector('.approval-btns').classList.add('hidden');
        try {
          await api('/api/approve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ approvalId: evt.approvalId, allow: v === '1' }),
          });
        } catch {}
      });
      b.appendChild(card);
      scrollBottom(true);
      break;
    }
    case 'done': {
      state.textEl = null; state.textRaw = ''; state.stepEl = null;
      if (evt.text && evt.text.trim()) {
        const b = bubble('ai');
        const d = document.createElement('div');
        d.className = 'bubble md';
        d.innerHTML = md(evt.text);
        b.appendChild(d);
      }
      if (evt.usage && evt.usage.input > 0) {
        const b = bubble('ai');
        b.innerHTML = '<div class="usage">本次消耗 ' + evt.usage.input + ' 输入 / ' + evt.usage.output + ' 输出 token</div>';
      }
      scrollBottom(true);
      break;
    }
    case 'error': {
      state.textEl = null; state.textRaw = ''; state.stepEl = null;
      const b = bubble('ai');
      b.innerHTML = '<div class="bubble error-bubble">❌ ' + esc(evt.message) + '</div>';
      scrollBottom(true);
      break;
    }
    case 'cancelled': {
      state.textEl = null; state.textRaw = ''; state.stepEl = null;
      const b = bubble('ai');
      b.innerHTML = '<div class="bubble">⏹ 已停止</div>';
      scrollBottom(true);
      break;
    }
    case 'chat_meta':
      break;
  }
}

// ---------- 聊天 ----------
async function send() {
  const text = $('#input').value.trim();
  if (!text || state.running) return;
  $('#input').value = '';
  autoGrow();
  if (!state.current) state.current = '新项目';
  $('#projectName').textContent = state.current;
  state.running = true;
  $('#send').classList.add('hidden');
  $('#cancel').classList.remove('hidden');
  state.textEl = null; state.textRaw = ''; state.stepEl = null;

  const decoder = new TextDecoder();
  try {
    const resp = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project: state.current,
        sessionId: state.session ? state.session.id : null,
        message: text,
      }),
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const reader = resp.body.getReader();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = chunk.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        let evt;
        try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (evt.type === 'chat_meta') {
          state.session = { id: evt.sessionId, project: evt.project, title: evt.title };
          localStorage.setItem('pv:session:' + evt.project, evt.sessionId);
        } else {
          renderEvent(evt, false);
        }
      }
    }
  } catch (e) {
    renderEvent({ type: 'error', message: '连接中断：' + e.message }, false);
  }
  state.running = false;
  $('#send').classList.remove('hidden');
  $('#cancel').classList.add('hidden');
  $('#input').focus();
  await loadProjects();
  renderProjects();
}

function autoGrow() {
  const el = $('#input');
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 130) + 'px';
}
$('#send').addEventListener('click', send);
$('#input').addEventListener('input', autoGrow);
$('#input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
$('#cancel').addEventListener('click', async () => {
  if (!state.session) return;
  try {
    await api('/api/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: state.session.id }),
    });
  } catch {}
});

// ---------- 项目选择 ----------
async function selectProject(name) {
  state.current = name;
  state.session = null;
  clearLog();
  $('#projectName').textContent = name;
  localStorage.setItem('pv:project', name);
  const lastId = localStorage.getItem('pv:session:' + name);
  if (lastId) {
    try {
      const s = await api('/api/history/' + lastId);
      state.session = s;
      for (const evt of s.events || []) renderEvent(evt, true);
      scrollBottom(true);
    } catch { state.session = null; }
  }
}

// ---------- API Key ----------
async function initKey() {
  $('#keyBanner').classList.toggle('hidden', state.configured);
}
$('#keySave').addEventListener('click', async () => {
  const k = $('#keyInput').value.trim();
  if (!k) return alert('请粘贴 API Key');
  try {
    await api('/api/key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: k }),
    });
    state.configured = true;
    $('#keyBanner').classList.add('hidden');
    $('#keyInput').value = '';
    alert('已保存到本机 .env ✅\n现在可以对 AI 说需求了');
  } catch (e) { alert('保存失败：' + e.message); }
});

// ---------- 启动 ----------
async function init() {
  try {
    const st = await api('/api/state');
    state.configured = st.configured;
    state.lanIps = st.lanIps || [];
    state.port = st.port;
    await initKey();
    await loadProjects();
    renderProjects();
    const saved = localStorage.getItem('pv:project');
    if (saved && state.projects.some((p) => p.name === saved)) await selectProject(saved);
    else if (state.projects.length) await selectProject(state.projects[0].name);
    else $('#projectName').textContent = '（说个需求，会自动建项目）';
    show(state.projects.length ? 'chat' : 'projects');
    // Service Worker 只在安全上下文（localhost / https）注册
    if ('serviceWorker' in navigator &&
      (location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.protocol === 'https:')) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  } catch (e) {
    $('#log').innerHTML = '<div class="empty">连接服务器失败：' + esc(e.message) + '</div>';
  }
}
init();
