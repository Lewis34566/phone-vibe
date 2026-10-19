'use strict';
const VERSION = 'v1.4';
const $ = (s) => document.querySelector(s);
const state = {
  projects: [], current: null, session: null,
  running: false, configured: true, lanIps: [], port: 8787,
  stepEl: null, textEl: null, textRaw: '', typingEl: null, gotText: false,
};

const TOOL_LABELS = {
  list_dir: '查看目录', read_file: '读文件', write_file: '写文件',
  delete_file: '删除', run_command: '执行命令', start_project: '启动项目', stop_project: '停止项目',
  search_code: '搜索代码',
};
const TOOL_ICONS = {
  list_dir: '📂', read_file: '📄', write_file: '✍️',
  delete_file: '🗑️', run_command: '⚙️', start_project: '🚀', stop_project: '⏹️',
  search_code: '🔍',
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

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2200);
}

// Markdown 渲染：代码块（占位符保护）/ 标题 / 列表 / 粗体 / 行内代码
function md(s) {
  const codes = [];
  const tokenized = esc(s).replace(/```([\s\S]*?)```/g, (m, code) => {
    codes.push('<pre class="md-code">' + code.replace(/^\w*\n/, '').replace(/\n+$/, '') + '</pre>');
    return '\u0000C' + (codes.length - 1) + '\u0000';
  });
  let t = tokenized;
  t = t.replace(/^### (.+)$/gm, '<div class="md-h3">$1</div>');
  t = t.replace(/^## (.+)$/gm, '<div class="md-h2">$1</div>');
  t = t.replace(/^# (.+)$/gm, '<div class="md-h1">$1</div>');
  t = t.replace(/^(\d+)\. (.+)$/gm, '<div class="md-li"><span class="md-num">$1.</span> $2</div>');
  t = t.replace(/^[-•] (.+)$/gm, '<div class="md-li"><span class="md-num">•</span> $1</div>');
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  t = t.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  t = t.replace(/\u0000C(\d+)\u0000/g, (m, i) => codes[+i] || '');
  return t;
}

function scrollBottom(force) {
  const log = $('#log');
  if (force || log.scrollTop + log.clientHeight >= log.scrollHeight - 160) log.scrollTop = log.scrollHeight;
}

function aiBubble() {
  const div = document.createElement('div');
  div.className = 'msg ai';
  div.innerHTML = '<div class="avatar">L</div>';
  $('#log').appendChild(div);
  return div;
}
function userBubble(text) {
  const div = document.createElement('div');
  div.className = 'msg user';
  div.innerHTML = '<div class="bubble">' + esc(text) + '</div>';
  $('#log').appendChild(div);
  return div;
}

function updateLanding() {
  const log = $('#log');
  const hasContent = [...log.children].some((c) => c.id !== 'landing');
  const landing = $('#landing');
  if (landing) landing.classList.toggle('hidden', hasContent);
}

function clearLog() {
  const log = $('#log');
  [...log.children].forEach((c) => { if (c.id !== 'landing') c.remove(); });
  state.textEl = null; state.textRaw = ''; state.stepEl = null; state.typingEl = null;
  updateLanding();
}

// ---------- 正在输入动画 ----------
function showTyping() {
  hideTyping();
  const b = aiBubble();
  const t = document.createElement('div');
  t.className = 'typing';
  t.innerHTML = '<i></i><i></i><i></i>';
  b.appendChild(t);
  state.typingEl = b;
  scrollBottom(true);
}
function hideTyping() {
  if (state.typingEl) { state.typingEl.remove(); state.typingEl = null; }
}

// ---------- 底部抽屉 ----------
function showSheet(html) {
  $('#sheetCard').innerHTML = html;
  $('#sheet').classList.remove('hidden');
}
function hideSheet() { $('#sheet').classList.add('hidden'); }
$('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') hideSheet(); });

// ---------- 项目列表（抽屉） ----------
async function loadProjects() {
  try { state.projects = await api('/api/projects'); } catch { state.projects = []; }
}

function renderProjects() {
  let html = `<div class="sheet-title">📁 项目 <button class="sheet-close" id="sheetClose">✕</button></div>
    <div class="newproj"><input id="newProjectName" placeholder="新项目名，如：记账本"><button id="btnNewProject">＋ 新建</button></div>`;
  if (!state.projects.length) html += '<div class="empty">还没有项目。新建一个，或直接回聊天说需求（会自动建项目）。</div>';
  for (const p of state.projects) {
    html += `<div class="prow" data-name="${esc(p.name)}">
      <span class="pd ${p.running ? 'on' : ''}"></span>
      <div class="pi"><div class="pt">${esc(p.title)}</div><div class="ps">${p.running ? '● 运行中' + (p.port ? ' :' + p.port : '') : '未运行'} · ${esc(p.desc || p.name)}</div></div>
      <div class="pacts">
        ${p.running ? '<button class="pbtn on" data-act="stop">⏹</button>' : '<button class="pbtn" data-act="run">▶</button>'}
        <button class="pbtn" data-act="open">🌐</button>
        <button class="pbtn" data-act="export">⬇</button>
        <button class="pbtn danger" data-act="del">🗑</button>
      </div></div>`;
  }
  showSheet(html);
  $('#sheetClose').addEventListener('click', hideSheet);
  $('#btnNewProject').addEventListener('click', async () => {
    const name = $('#newProjectName').value.trim();
    if (!name) return toast('先输入项目名');
    try {
      const r = await api('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
      await loadProjects();
      await selectProject(r.name);
      hideSheet();
      toast('项目已创建：' + r.name);
    } catch (e) { toast('创建失败：' + e.message); }
  });
  for (const row of document.querySelectorAll('.prow')) {
    row.addEventListener('click', async (e) => {
      const act = e.target.dataset.act;
      const name = row.dataset.name;
      const p = state.projects.find((x) => x.name === name);
      if (!p) return;
      if (act) { e.stopPropagation(); projectAction(p, act); return; }
      await selectProject(p.name);
      hideSheet();
      toast('已切换到：' + p.title);
    });
  }
}

async function projectAction(p, act) {
  try {
    if (act === 'run') {
      toast('正在启动 ' + p.title + '…');
      const r = await api(`/api/project/${encodeURIComponent(p.name)}/run`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'auto', install: true }),
      });
      if (r.ok === false) throw new Error(r.error || '启动失败');
      await loadProjects();
      renderProjects();
      if (r.error) toast(r.error);
      else {
        const w = window.open('/p/' + encodeURIComponent(p.name) + '/', '_blank');
        if (!w) location.href = '/p/' + encodeURIComponent(p.name) + '/';
      }
    } else if (act === 'stop') {
      await api(`/api/project/${encodeURIComponent(p.name)}/stop`, { method: 'POST' });
      await loadProjects();
      renderProjects();
      toast('已停止');
    } else if (act === 'open') {
      const w = window.open('/p/' + encodeURIComponent(p.name) + '/', '_blank');
      if (!w) location.href = '/p/' + encodeURIComponent(p.name) + '/';
    } else if (act === 'export') {
      toast('正在打包下载…');
      window.location.href = `/api/project/${encodeURIComponent(p.name)}/export`;
    } else if (act === 'del') {
      if (confirm(`确定删除项目「${p.title}」？文件全部删除，不可恢复。`)) {
        await api(`/api/project/${encodeURIComponent(p.name)}/delete`, { method: 'POST' });
        if (state.current === p.name) { state.current = null; state.session = null; clearLog(); updatePill(); }
        await loadProjects();
        renderProjects();
        toast('已删除');
      }
    }
  } catch (e) { toast(e.message); }
}

async function openProjects() {
  await loadProjects();
  renderProjects();
}
$('#projectPill').addEventListener('click', openProjects);

function updatePill() {
  $('#pname').textContent = state.current || '选择项目';
}

// ---------- 会话历史（抽屉） ----------
async function openHistory() {
  let sessions = [];
  try { sessions = await api('/api/history?project=' + encodeURIComponent(state.current || '')); } catch {}
  let html = `<div class="sheet-title">🕘 历史会话 <button class="sheet-close" id="sheetClose">✕</button></div>
    <div class="newproj"><button id="btnNewSession" style="flex:1">＋ 新会话</button></div>`;
  if (!sessions.length) html += '<div class="empty">还没有历史会话</div>';
  for (const s of sessions) {
    html += `<div class="hrow" data-id="${s.id}">
      <div class="hi"><div class="ht">${esc(s.title)}</div><div class="hs">${new Date(s.updatedAt).toLocaleString('zh-CN')}</div></div>
      <button class="pbtn danger" data-act="del">🗑</button></div>`;
  }
  showSheet(html);
  $('#sheetClose').addEventListener('click', hideSheet);
  const btnNew = $('#btnNewSession');
  if (btnNew) btnNew.addEventListener('click', () => { state.session = null; clearLog(); hideSheet(); toast('已开启新会话'); });
  for (const row of document.querySelectorAll('.hrow')) {
    row.addEventListener('click', async (e) => {
      if (e.target.dataset.act === 'del') {
        if (!confirm('删除这个会话？')) return;
        await api('/api/history/' + row.dataset.id, { method: 'DELETE' });
        if (state.session && state.session.id === row.dataset.id) { state.session = null; clearLog(); }
        return openHistory();
      }
      try {
        await loadSession(row.dataset.id);
        hideSheet();
      } catch (err) { toast(err.message); }
    });
  }
}
$('#btnHistory').addEventListener('click', openHistory);

async function loadSession(id) {
  const s = await api('/api/history/' + id);
  state.session = s;
  clearLog();
  for (const evt of s.events || []) renderEvent(evt, true);
  updateLanding();
  scrollBottom(true);
}

// ---------- 事件渲染 ----------
function renderEvent(evt, replay) {
  hideTyping();
  switch (evt.type) {
    case 'user': {
      userBubble(evt.text);
      state.textEl = null; state.textRaw = ''; state.stepEl = null; state.gotText = false;
      updateLanding();
      scrollBottom(true);
      break;
    }
    case 'text': {
      if (!state.textEl) {
        const b = aiBubble();
        state.textEl = document.createElement('div');
        state.textEl.className = 'bubble md';
        b.appendChild(state.textEl);
      }
      state.textRaw += evt.delta;
      state.textEl.innerHTML = md(state.textRaw);
      state.gotText = true;
      state.stepEl = null;
      scrollBottom();
      break;
    }
    case 'tool_call': {
      state.textEl = null; state.textRaw = ''; state.gotText = false;
      const b = aiBubble();
      const step = document.createElement('div');
      step.className = 'step running';
      const inp = evt.input || {};
      let target = '';
      if (evt.name === 'write_file' || evt.name === 'read_file' || evt.name === 'delete_file') target = inp.path || '';
      else if (evt.name === 'run_command') target = String(inp.command || '').slice(0, 40);
      else if (evt.name === 'list_dir') target = inp.path || '根目录';
      else if (evt.name === 'search_code') target = inp.pattern || '';
      else if (evt.name === 'start_project') target = (inp.type || 'auto') + (inp.install_deps ? ' +装依赖' : '');
      step.innerHTML = `<div class="step-head">
        <span class="step-ico">${TOOL_ICONS[evt.name] || '🔧'}</span>
        <span class="step-label">${TOOL_LABELS[evt.name] || evt.name}${target ? ' · ' + esc(target) : ''}</span>
        <span class="step-dot"></span>
      </div>
      <div class="step-sum"></div>
      <details class="step-details"><summary>详情</summary><pre class="step-out"></pre></details>`;
      b.appendChild(step);
      state.stepEl = step;
      scrollBottom(true);
      break;
    }
    case 'output': {
      if (!state.stepEl) break;
      const out = state.stepEl.querySelector('.step-out');
      out.textContent = (out.textContent + evt.chunk).slice(-3000);
      out.scrollTop = out.scrollHeight;
      scrollBottom();
      break;
    }
    case 'tool_result': {
      if (!state.stepEl) break;
      const step = state.stepEl;
      step.classList.remove('running');
      step.classList.add(evt.ok ? 'ok' : 'err');
      const sum = step.querySelector('.step-sum');
      if (evt.summary) sum.textContent = evt.summary;
      if (evt.needsInstall) {
        const warn = document.createElement('div');
        warn.className = 'step-warn';
        warn.textContent = '⚠️ 需要安装依赖：AI 会发起确认，请点「允许」';
        step.appendChild(warn);
      }
      const out = step.querySelector('.step-out');
      if (evt.output) {
        out.textContent = (out.textContent ? out.textContent + '\n' : '') + evt.output;
        out.textContent = out.textContent.slice(-3000);
      }
      if (out.textContent.trim()) step.querySelector('.step-details').open = true;
      state.stepEl = null;
      scrollBottom(true);
      break;
    }
    case 'approval': {
      if (replay) break;
      state.textEl = null; state.textRaw = ''; state.stepEl = null;
      const b = aiBubble();
      const card = document.createElement('div');
      card.className = 'approval';
      card.innerHTML = `<div class="approval-title">⚠️ 需要你的确认</div>
        <pre class="approval-q">${esc(evt.question)}</pre>
        <div class="approval-btns">
          <button class="ok" data-v="1">✅ 允许</button>
          <button class="no" data-v="0">✋ 拒绝</button>
        </div>
        <div class="approval-state"></div>`;
      card.addEventListener('click', async (e) => {
        const v = e.target.dataset.v;
        if (v === undefined) return;
        card.querySelector('.approval-state').textContent = v === '1' ? '已允许，继续…' : '已拒绝';
        card.querySelector('.approval-btns').classList.add('hidden');
        try {
          await api('/api/approve', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
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
      // 文字已在流式输出时显示过，done 里不再重复渲染（修重复回答 bug）
      if (evt.text && evt.text.trim() && !state.gotText) {
        const b = aiBubble();
        const d = document.createElement('div');
        d.className = 'bubble md';
        d.innerHTML = md(evt.text);
        b.appendChild(d);
      }
      state.gotText = false;
      if (evt.previewUrl) {
        const b = aiBubble();
        const a = document.createElement('a');
        a.className = 'open-btn';
        a.href = evt.previewUrl;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = '🌐 打开刚做好的应用';
        b.appendChild(a);
      }
      const hint = aiBubble();
      hint.innerHTML = '<div class="hint">💡 想继续完善？直接说，比如：加个筛选、改配色、支持导出</div>';
      if (evt.usage && evt.usage.input > 0) {
        const b = aiBubble();
        b.innerHTML = '<div class="usage">本次消耗 ' + evt.usage.input + ' 输入 / ' + evt.usage.output + ' 输出 token</div>';
      }
      scrollBottom(true);
      break;
    }
    case 'error': {
      state.textEl = null; state.textRaw = ''; state.stepEl = null;
      const b = aiBubble();
      const d = document.createElement('div');
      d.className = 'bubble error-bubble';
      d.textContent = '❌ ' + evt.message;
      b.appendChild(d);
      scrollBottom(true);
      break;
    }
    case 'cancelled': {
      state.textEl = null; state.textRaw = ''; state.stepEl = null;
      const b = aiBubble();
      const d = document.createElement('div');
      d.className = 'bubble';
      d.textContent = '⏹ 已停止';
      b.appendChild(d);
      scrollBottom(true);
      break;
    }
    case 'chat_meta':
      break;
  }
}

// ---------- 聊天 ----------
async function send(text) {
  text = (text || $('#input').value).trim();
  if (!text || state.running) return;
  $('#input').value = '';
  autoGrow();
  if (!state.current) state.current = '新项目';
  updatePill();
  state.running = true;
  $('#send').classList.add('hidden');
  $('#cancel').classList.remove('hidden');
  state.textEl = null; state.textRaw = ''; state.stepEl = null;
  updateLanding();
  showTyping();

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
  hideTyping();
  state.running = false;
  $('#send').classList.remove('hidden');
  $('#cancel').classList.add('hidden');
  $('#input').focus();
  await loadProjects();
}

function autoGrow() {
  const el = $('#input');
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 130) + 'px';
}
$('#send').addEventListener('click', () => send());
$('#input').addEventListener('input', autoGrow);
$('#input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
$('#cancel').addEventListener('click', async () => {
  if (!state.session) return;
  try {
    await api('/api/cancel', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: state.session.id }),
    });
  } catch {}
});

// 欢迎页快捷指令
for (const chip of document.querySelectorAll('.chip')) {
  chip.addEventListener('click', () => send(chip.textContent.trim()));
}

// ---------- 项目选择 ----------
async function selectProject(name) {
  state.current = name;
  state.session = null;
  clearLog();
  updatePill();
  localStorage.setItem('pv:project', name);
  const lastId = localStorage.getItem('pv:session:' + name);
  if (lastId) {
    try {
      const s = await api('/api/history/' + lastId);
      state.session = s;
      for (const evt of s.events || []) renderEvent(evt, true);
      updateLanding();
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
  if (!k) return toast('请粘贴 API Key');
  try {
    await api('/api/key', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: k }),
    });
    state.configured = true;
    $('#keyBanner').classList.add('hidden');
    $('#keyInput').value = '';
    toast('Key 已保存 ✅ 现在可以对 AI 说需求了');
  } catch (e) { toast('保存失败：' + e.message); }
});

// ---------- 启动 ----------
async function init() {
  $('#ver').textContent = VERSION + ' · DeepSeek · 手机版 Agent';
  try {
    const st = await api('/api/state');
    state.configured = st.configured;
    state.lanIps = st.lanIps || [];
    state.port = st.port;
    await initKey();
    await loadProjects();
    const saved = localStorage.getItem('pv:project');
    if (saved && state.projects.some((p) => p.name === saved)) await selectProject(saved);
    else if (state.projects.length) await selectProject(state.projects[0].name);
    updatePill();
    updateLanding();
    if ('serviceWorker' in navigator &&
      (location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.protocol === 'https:')) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  } catch (e) {
    const b = aiBubble();
    const d = document.createElement('div');
    d.className = 'bubble error-bubble';
    d.textContent = '连接服务器失败：' + e.message;
    b.appendChild(d);
    updateLanding();
  }
}
init();
