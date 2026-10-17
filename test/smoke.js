'use strict';
// 自测脚本：node test/smoke.js（Windows / Termux 通用，需在 bash 环境跑）
// 用 mock API Key 跑通：静态托管 / Agent 全流程 / 审批通过与拒绝 / Node 项目代理 / zip 导出
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 8899;
// 每次运行用独立目录，避免上次残留进程锁目录导致 EPERM
const TEST_DIR = path.join(ROOT, `test-projects-${process.pid}`);
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function ok(cond, msg) {
  if (cond) console.log('  ✓', msg);
  else { console.error('  ✗ FAIL:', msg); failures++; }
}

async function json(url, opts) {
  const r = await fetch(url, opts);
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}

async function waitFor(fn, timeoutMs = 15000, step = 400) {
  const start = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch {}
    if (Date.now() - start > timeoutMs) return null;
    await new Promise((r) => setTimeout(r, step));
  }
}

// 发一次聊天，收完 SSE 事件；遇到 approval 自动按 onApproval 决策回复
async function chat(message, project, onApproval) {
  const resp = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project, message }),
  });
  if (!resp.ok) return { status: resp.status, events: [] };
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const events = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = chunk.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const evt = JSON.parse(line.slice(5).trim());
      events.push(evt);
      if (evt.type === 'approval') {
        const allow = onApproval ? onApproval(evt) : true;
        await fetch(`${BASE}/api/approve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ approvalId: evt.approvalId, allow }),
        });
      }
    }
  }
  return { status: resp.status, events };
}

async function main() {
  console.log('== 手机本机 Vibe Coding 自测 ==');
  fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  fs.mkdirSync(TEST_DIR, { recursive: true });

  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), PHONE_PROJECTS_DIR: TEST_DIR, ANTHROPIC_API_KEY: 'mock', AUTO_OPEN: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });

  try {
    const st = await waitFor(async () => (await json(`${BASE}/api/state`)).body);
    ok(!!st, '1. 服务器启动');
    ok(st && st.mock === true, '2. mock 模式生效');
    ok(st && st.projectsDir === TEST_DIR, '3. 项目目录指向测试目录');

    // 新建项目
    let r = await json(`${BASE}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '测试应用' }),
    });
    ok(r.body && r.body.ok, '4. 新建项目「测试应用」');

    // 静态文件直接托管
    fs.writeFileSync(path.join(TEST_DIR, '测试应用', 'hello.html'), '<h1>静态OK</h1>');
    r = await json(`${BASE}/p/${encodeURIComponent('测试应用')}/hello.html`);
    ok(r.status === 200 && typeof r.body === 'string' && r.body.includes('静态OK'), '5. /p/ 静态托管');

    // mock Agent 全流程：写文件 + 启动
    const r1 = await chat('做一个记账小工具', '测试应用', () => true);
    const types = r1.events.map((e) => e.type);
    ok(r1.status === 200, '6. 聊天 SSE 建立');
    ok(types.includes('chat_meta') && types.includes('user'), '7. 会话元信息');
    ok(types.includes('text'), '8. 流式文本输出');
    ok(r1.events.some((e) => e.type === 'tool_call' && e.name === 'write_file'), '9. Agent 调用写文件工具');
    ok(r1.events.some((e) => e.type === 'tool_call' && e.name === 'start_project'), '10. Agent 调用启动工具');
    ok(types.includes('done'), '11. 任务正常结束');
    ok(fs.existsSync(path.join(TEST_DIR, '测试应用', 'index.html')), '12. Agent 写的文件落盘');

    // 审批：拒绝
    const r2 = await chat('请执行 rm 删除', '测试应用', () => false);
    const ap2 = r2.events.find((e) => e.type === 'approval');
    const tr2 = r2.events.filter((e) => e.type === 'tool_result' && e.name === 'run_command');
    ok(!!ap2, '13. 危险命令触发审批弹窗');
    ok(tr2.length && tr2[tr2.length - 1].ok === false, '14. 拒绝后命令被阻止');

    // 审批：允许
    fs.mkdirSync(path.join(TEST_DIR, '测试应用', 'test_target'), { recursive: true });
    const r3 = await chat('请执行 rm 删除', '测试应用', () => true);
    ok(r3.events.some((e) => e.type === 'tool_result' && e.name === 'run_command' && e.ok), '15. 允许后命令执行成功');
    ok(!fs.existsSync(path.join(TEST_DIR, '测试应用', 'test_target')), '16. 命令确实生效（目录已删除）');

    // 历史
    r = await json(`${BASE}/api/history?project=${encodeURIComponent('测试应用')}`);
    ok(r.body && Array.isArray(r.body) && r.body.length >= 1, '17. 历史会话已保存');
    const sid = r.body[0].id;
    r = await json(`${BASE}/api/history/${sid}`);
    ok(r.body && Array.isArray(r.body.events) && r.body.events.length > 3, '18. 历史详情可回放');

    // Node 项目
    r = await json(`${BASE}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'node测试' }),
    });
    const nodeDir = path.join(TEST_DIR, 'node测试');
    fs.writeFileSync(path.join(nodeDir, 'package.json'), JSON.stringify({ name: 'x', scripts: { start: 'node server.js' } }));
    fs.writeFileSync(path.join(nodeDir, 'server.js'), `require('http').createServer((req,res)=>res.end('node-hello')).listen(process.env.PORT||8000);`);
    r = await json(`${BASE}/api/project/${encodeURIComponent('node测试')}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'node', install: true }),
    });
    ok(r.body && r.body.ok, '19. Node 项目启动');
    const pr = await waitFor(async () => {
      const x = await json(`${BASE}/p/${encodeURIComponent('node测试')}/`);
      return typeof x.body === 'string' && x.body.includes('node-hello') ? x : null;
    }, 20000);
    ok(!!pr, '20. 反向代理访问 Node 项目');

    // zip 导出
    r = await json(`${BASE}/api/project/${encodeURIComponent('测试应用')}/export`);
    ok(r.status === 200 && typeof r.body === 'string' && r.body.slice(0, 2) === 'PK', '21. zip 导出（PK 魔数）');

    // 停止
    r = await json(`${BASE}/api/project/${encodeURIComponent('node测试')}/stop`, { method: 'POST' });
    ok(r.body && r.body.ok, '22. 停止项目');

    // 主页与静态资源
    r = await json(`${BASE}/`);
    ok(r.status === 200 && typeof r.body === 'string' && r.body.includes('Vibe 码'), '23. 主页面可访问');
    r = await json(`${BASE}/manifest.json`);
    ok(r.status === 200 && r.body && r.body.short_name, '24. PWA manifest 可访问');
  } catch (e) {
    console.error('  ✗ 测试过程异常:', e.message);
    failures++;
  } finally {
    if (process.platform === 'win32') {
      try { require('child_process').execSync(`taskkill /T /F /PID ${server.pid}`, { stdio: 'ignore' }); } catch {}
    } else {
      try { server.kill(); } catch {}
    }
    await new Promise((r) => setTimeout(r, 800));
    console.log('');
    console.log('---- 服务器日志（尾部）----');
    console.log(serverLog.slice(-2000));
    console.log('---- 结果 ----');
    if (failures) {
      console.error(`✗ ${failures} 项失败`);
      process.exit(1);
    }
    console.log('✅ 全部通过');
  }
}
main();
