'use strict';
const VERSION = 'v1.9';
const $ = (s) => document.querySelector(s);
const state = {
  projects: [], current: null, session: null,
  running: false, configured: true, lanIps: [], port: 8787,
  stepEl: null, textEl: null, textRaw: '', typingEl: null, gotText: false,
};

const TOOL_LABELS = {
  list_dir: '查看目录', read_file: '读文件', write_file: '写文件', edit_file: '改代码',
  delete_file: '删除', run_command: '执行命令', start_project: '启动项目', stop_project: '停止项目',
  search_code: '搜索代码', read_url: '读网页', send_message: '发消息',
};
const TOOL_ICONS = {
  list_dir: '📂', read_file: '📄', write_file: '✍️', edit_file: '✏️',
  delete_file: '🗑️', run_command: '⚙️', start_project: '🚀', stop_project: '⏹️',
  search_code: '🔍', read_url: '🌐', send_message: '💬',
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

// 增量渲染（v1.9.1）：整段重排 markdown 在手机上会占满主线程——
// 回答越长界面越卡、点了没反应。改成只把「已稳定部分」追加进页面，
// 每 tick 只重排末尾一小段，界面全程跟手。
// 复制按钮由 done 事件追加到 el 上，不再有 innerHTML 整体替换，不会被冲掉。
function scheduleMd(el) {
  if (el._mdTimer) return;
  el._mdTimer = setTimeout(() => {
    el._mdTimer = 0;
    if (!el._body) {
      el._body = document.createElement('div');
      el._tail = document.createElement('span');
      el.appendChild(el._body);
      el.appendChild(el._tail);
      el._flushed = 0;
    }
    const raw = String(el._raw || '');
    // 安全切点：距结尾 40 字符以内的最后一个换行（标题/列表/粗体/行内码都按行，
    // 切在行尾不会把 ** 或 ` 从中间劈开）
    let cut = raw.lastIndexOf('\n', raw.length - 40);
    if (cut === -1 && raw.length - el._flushed > 800) {
      // 罕见的长单行回答：找个空格硬切，防止末尾重排区无限变大
      cut = raw.lastIndexOf(' ', raw.length - 60);
      if (cut <= el._flushed) cut = raw.length - 60;
    }
    if (cut > el._flushed) {
      el._body.insertAdjacentHTML('beforeend', md(raw.slice(el._flushed, cut + 1)));
      el._flushed = cut + 1;
    }
    el._tail.innerHTML = md(raw.slice(el._flushed));
    scrollBottom();
  }, 80);
}

function scrollBottom(force) {
  const log = $('#log');
  if (force) { log.scrollTop = log.scrollHeight; return; }
  if (scrollQueued) return;
  scrollQueued = true;
  requestAnimationFrame(() => {
    scrollQueued = false;
    if (log.scrollTop + log.clientHeight >= log.scrollHeight - 220) log.scrollTop = log.scrollHeight;
  });
}
let scrollQueued = false;

// 长会话会堆出成百上千个节点，手机上会明显变卡——只保留最近的
function trimLog() {
  const log = $('#log');
  const kids = [...log.children].filter((c) => c.id !== 'landing');
  if (kids.length > 120) kids.slice(0, kids.length - 120).forEach((el) => el.remove());
}

function aiBubble() {
  const div = document.createElement('div');
  div.className = 'msg ai';
  div.innerHTML = '<div class="avatar">L</div>';
  $('#log').appendChild(div);
  trimLog();
  return div;
}
function userBubble(text) {
  const div = document.createElement('div');
  div.className = 'msg user';
  div.innerHTML = '<div class="bubble">' + esc(text) + '</div>';
  $('#log').appendChild(div);
  trimLog();
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
  // 只回放最近 120 个事件：老会话动辄上千事件，全渲染会卡好几秒
  const evts = (s.events || []).slice(-120);
  for (const evt of evts) renderEvent(evt, true);
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
      state.textEl._raw = state.textRaw;
      scheduleMd(state.textEl);
      state.gotText = true;
      state.stepEl = null;
      break;
    }
    case 'tool_call': {
      state.textEl = null; state.textRaw = ''; state.gotText = false;
      const b = aiBubble();
      const step = document.createElement('div');
      step.className = 'step running';
      const inp = evt.input || {};
      let target = '';
      if (evt.name === 'write_file' || evt.name === 'read_file' || evt.name === 'delete_file' || evt.name === 'edit_file') target = inp.path || '';
      else if (evt.name === 'run_command') target = String(inp.command || '').slice(0, 40);
      else if (evt.name === 'list_dir') target = inp.path || '根目录';
      else if (evt.name === 'search_code') target = inp.pattern || '';
      else if (evt.name === 'read_url') target = String(inp.url || '').slice(0, 50);
      else if (evt.name === 'phone') target = String(inp.action || '') + (inp.app ? ' · ' + inp.app : '') + (inp.text ? ' · ' + String(inp.text).slice(0, 20) : '');
      else if (evt.name === 'send_message') target = String(inp.channel || '') + (inp.to ? ' → ' + inp.to : '');
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
      const step = state.stepEl;
      step._buf = (step._buf || '') + evt.chunk;
      if (step._raf) break;
      step._raf = requestAnimationFrame(() => {
        step._raf = 0;
        const out = step.querySelector('.step-out');
        if (!out) return;
        out.textContent = (out.textContent + (step._buf || '')).slice(-3000);
        step._buf = '';
        out.scrollTop = out.scrollHeight;
        scrollBottom();
      });
      break;
    }
    case 'tool_result': {
      if (!state.stepEl) break;
      const step = state.stepEl;
      // 取消还没执行的节流输出渲染，否则 evt.output（已含全部内容）之后又会追加一遍缓冲块
      if (step._raf) { cancelAnimationFrame(step._raf); step._raf = 0; }
      step._buf = '';
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
      const lastEl = state.textEl;
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
      if (lastEl && lastEl.isConnected) {
        const raw = lastEl._raw || lastEl.textContent;
        const cbtn = document.createElement('button');
        cbtn.className = 'copy-btn';
        cbtn.textContent = '📋 复制这段';
        cbtn.addEventListener('click', async () => {
          try { await navigator.clipboard.writeText(raw); cbtn.textContent = '✅ 已复制'; }
          catch { toast('复制失败，可长按选中'); }
        });
        lastEl.appendChild(cbtn);
      }
      speakIfEnabled(evt.text);
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
let chatAbort = null;
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
  chatAbort = new AbortController();
  try {
    const resp = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: chatAbort.signal,
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
    if (e && e.name === 'AbortError') renderEvent({ type: 'cancelled' }, false);
    else renderEvent({ type: 'error', message: '连接中断：' + e.message }, false);
  }
  chatAbort = null;
  hideTyping();
  state.running = false;
  $('#send').classList.remove('hidden');
  $('#cancel').classList.add('hidden');
  $('#input').focus();
  loadProjects(); // 后台刷新，不阻塞界面
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
  const sid = state.session && state.session.id;
  // 先本地立即断开，界面马上停住；再通知服务端停任务
  if (chatAbort) { try { chatAbort.abort(); } catch {} }
  if (sid) {
    try {
      await api('/api/cancel', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sid }),
      });
    } catch {}
  }
});

// ---------- 语音朗读 ----------
function speakIfEnabled(text) {
  if (localStorage.getItem('pv:tts') !== '1') return;
  if (!('speechSynthesis' in window)) return;
  const clean = String(text || '').replace(/[#*`>_-]/g, '').trim().slice(0, 500);
  if (!clean) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(clean);
    u.lang = 'zh-CN';
    u.rate = 1.05;
    speechSynthesis.speak(u);
  } catch {}
}

// ---------- 语音输入 ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recog = null;
const micBtn = $('#mic');
if (micBtn) {
  if (!SR) micBtn.style.display = 'none';
  else micBtn.addEventListener('click', () => {
    if (recog) { try { recog.stop(); } catch {} recog = null; micBtn.classList.remove('on'); return; }
    recog = new SR();
    recog.lang = 'zh-CN';
    recog.interimResults = true;
    recog.continuous = false;
    recog.onresult = (e) => {
      let t = '';
      for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript;
      $('#input').value = t;
      autoGrow();
    };
    recog.onend = () => { recog = null; micBtn.classList.remove('on'); };
    recog.onerror = () => { recog = null; micBtn.classList.remove('on'); toast('语音识别失败，检查麦克风权限'); };
    try {
      recog.start();
      micBtn.classList.add('on');
      toast('说话吧，说完自动填进输入框');
    } catch { toast('无法启动语音识别'); }
  });
}

// ---------- 设置 ----------
async function openSettings() {
  let st = { model: '', autoOpen: true, allowAnyPath: true };
  try { st = await api('/api/settings'); } catch {}
  const tts = localStorage.getItem('pv:tts') === '1';
  const modelBtn = (k, label) => `<button class="chip${st.model === k ? ' on' : ''}" data-model="${k}">${label}</button>`;
  showSheet(`<div class="sheet-title">⚙️ 设置 <button class="sheet-close" id="sheetClose">✕</button></div>
    <div class="set-group"><div class="set-label">用哪个模型</div>
      <div class="chips">${modelBtn('deepseek-v4-pro', 'V4 Pro · 更聪明')}${modelBtn('deepseek-flash', 'Flash · 更快更省')}</div></div>
    <div class="set-group"><div class="set-label">语音</div>
      <button class="chip${tts ? ' on' : ''}" id="setTts">${tts ? '🔊 朗读回复：开' : '🔇 朗读回复：关'}</button></div>
    <div class="set-group"><div class="set-label">做完自动打开预览</div>
      <button class="chip${st.autoOpen ? ' on' : ''}" id="setAuto">${st.autoOpen ? '已开启' : '已关闭'}</button></div>
    <div class="set-group"><div class="set-label">Lewis 可读写整个手机存储</div>
      <button class="chip${st.allowAnyPath ? ' on' : ''}" id="setAny">${st.allowAnyPath ? '已开启' : '已关闭'}</button></div>
    <div class="set-group"><button class="chip" id="setBackup">⬇ 备份所有项目（zip）</button></div>
    <div class="empty">${VERSION} · 手机版 Agent</div>`);
  $('#sheetClose').addEventListener('click', hideSheet);
  document.querySelectorAll('[data-model]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: b.dataset.model }) });
      hideSheet();
      toast('已切换模型');
    } catch (e) { toast(e.message); }
  }));
  $('#setTts').addEventListener('click', () => {
    const now = localStorage.getItem('pv:tts') === '1';
    localStorage.setItem('pv:tts', now ? '0' : '1');
    openSettings();
  });
  $('#setAuto').addEventListener('click', async () => {
    try {
      const r = await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autoOpen: !st.autoOpen }) });
      st.autoOpen = r.autoOpen;
      openSettings();
    } catch (e) { toast(e.message); }
  });
  $('#setAny').addEventListener('click', async () => {
    try {
      const r = await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ allowAnyPath: !st.allowAnyPath }) });
      st.allowAnyPath = r.allowAnyPath;
      openSettings();
    } catch (e) { toast(e.message); }
  });
  $('#setBackup').addEventListener('click', () => {
    location.href = '/api/backup';
    hideSheet();
    toast('正在打包所有项目…');
  });
}
const btnSettings = $('#btnSettings');
if (btnSettings) btnSettings.addEventListener('click', openSettings);

// ---------- 新聊天 ----------
function newChat() {
  if (chatAbort) { try { chatAbort.abort(); } catch {} }
  state.session = null;
  state.running = false;
  state.textEl = null; state.textRaw = ''; state.stepEl = null; state.gotText = false;
  $('#send').classList.remove('hidden');
  $('#cancel').classList.add('hidden');
  hideTyping();
  clearLog();
  updateLanding();
  $('#input').focus();
  toast('已开新聊天');
}
const btnNewChat = $('#btnNewChat');
if (btnNewChat) btnNewChat.addEventListener('click', () => { hideSheet(); newChat(); });

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

// ---------- 安装到桌面（PWA，装完就是独立 App，没有地址栏） ----------
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  const btn = $('#btnInstall');
  if (btn) btn.classList.remove('hidden');
});
const installBtn = $('#btnInstall');
if (installBtn) {
  installBtn.addEventListener('click', async () => {
    if (!installPrompt) {
      toast('用 Chrome ⋮ 菜单 → 添加到主屏幕');
      return;
    }
    installPrompt.prompt();
    try { await installPrompt.userChoice; } catch {}
    installPrompt = null;
    installBtn.classList.add('hidden');
  });
}

// ---------- 启动 ----------
async function init() {
  $('#ver').textContent = VERSION + ' · 手机版 Agent';
  // 首屏尽快可用：两个接口并发拿，历史会话异步加载（v1.7 提速）
  try {
    const [st, projects] = await Promise.all([api('/api/state'), api('/api/projects')]);
    state.configured = st.configured;
    state.lanIps = st.lanIps || [];
    state.port = st.port;
    state.projects = projects || [];
    await initKey();
    updateLanding();
    const saved = localStorage.getItem('pv:project');
    const first = state.projects.find((p) => p.name === saved) || state.projects[0];
    if (first) selectProject(first.name); // 故意不 await：先让输入框可用
    updatePill();
    if ('serviceWorker' in navigator &&
      (location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.protocol === 'https:')) {
      navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
        .then((r) => r && r.update && r.update())
        .catch(() => {});
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
