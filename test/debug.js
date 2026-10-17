'use strict';
// 调试脚本：跑一次 mock 聊天并打印每个事件（排查 Agent 循环问题用）
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 8898;
const TEST_DIR = path.join(ROOT, 'test-projects');
const BASE = `http://127.0.0.1:${PORT}`;

async function main() {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), PHONE_PROJECTS_DIR: TEST_DIR, ANTHROPIC_API_KEY: 'mock', AUTO_OPEN: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });

  const wait = async () => {
    for (let i = 0; i < 40; i++) {
      try { const r = await fetch(`${BASE}/api/state`); if (r.ok) return; } catch {}
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error('server not up');
  };
  try {
    await wait();
    const resp = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: '调试项目', message: '做一个记账小工具' }),
    });
    console.log('chat status:', resp.status);
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
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
        if (evt.type === 'text') process.stdout.write(evt.delta);
        else if (evt.type === 'approval') {
          console.log('\n[approval]', evt.question);
          await fetch(`${BASE}/api/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approvalId: evt.approvalId, allow: true }) });
        } else {
          console.log('\n[' + evt.type + ']', JSON.stringify(evt).slice(0, 400));
        }
      }
    }
    console.log('\n---- 项目目录内容 ----');
    const dir = path.join(TEST_DIR, '调试项目');
    try { console.log(fs.readdirSync(dir)); } catch (e) { console.log('目录不存在:', e.message); }
    console.log('---- 服务器日志尾部 ----');
    console.log(log.slice(-1500));
  } catch (e) {
    console.error('debug error:', e);
    console.log(log.slice(-1500));
  } finally {
    try { server.kill(); } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
}
main();
