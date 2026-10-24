// 集成测试：主接口失败 → 静默降级本地模型；且 5 分钟记忆窗口内不再重试主接口
'use strict';
const http = require('http');
const assert = require('assert');

// 假本地模型：只认 /v1/chat/completions 路径（和真 ollama 一样），记录请求体
let lastBody = null;
const fake = http.createServer((req, res) => {
  if (req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return; }
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    lastBody = JSON.parse(raw);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"本地模型直接回答"}}]}\n\n');
    res.end('data: [DONE]\n\n');
  });
});

// 假主接口：必失败（500）并计数——用来验证记忆窗口内不再访问主接口
let primaryCalls = 0;
const primary = http.createServer((req, res) => { primaryCalls++; res.writeHead(500); res.end('boom'); });

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', r));

(async () => {
  await listen(fake); await listen(primary);
  process.env.LOCAL_LLM_URL = `http://127.0.0.1:${fake.address().port}/v1`;
  process.env.LOCAL_LLM_MODEL = 'test-model';
  const { streamLLM } = require('../src/llm.js'); // 在设置 env 之后才加载 config

  const messyHistory = [
    { role: 'user', content: '帮我做个计算器' },
    { role: 'assistant', content: [{ type: 'text', text: '开始写代码。' }, { type: 'tool_use', id: 't1', name: 'write_file', input: { path: 'a.html', content: 'x' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"ok":true,"summary":"已写入"}' }] },
    { role: 'user', content: '继续' },
  ];
  const opts = (msgs) => ({
    apiKey: 'x', model: 'm', system: '', messages: msgs,
    tools: [{ name: 'write_file', description: 'x', input_schema: { type: 'object' } }],
    signal: new AbortController().signal,
    _primaryUrl: `http://127.0.0.1:${primary.address().port}/chat/completions`,
  });

  // 第一次：主接口失败 → 降级本地
  const events = [];
  for await (const evt of streamLLM(opts(messyHistory))) events.push(evt);
  const text = events.filter((e) => e.type === 'content_block_delta').map((e) => e.delta.text).join('');
  assert.ok(text.includes('本地模型直接回答'), '本地模型内容透传');
  assert.ok(!text.includes('切换') && !text.includes('出错'), '静默切换：无提示/错误文字');
  assert.strictEqual(lastBody.tools.length, 0, '降级请求不带工具');
  assert.ok(/离线/.test(lastBody.messages[0].content), '降级使用离线简洁提示词');
  const flat = JSON.stringify(lastBody.messages);
  assert.ok(!flat.includes('tool_calls') && !flat.includes('tool_use'), '历史里的工具调用被清洗');
  assert.ok(flat.includes('[操作结果]'), '工具结果压缩为纯文本注释');
  assert.ok(flat.includes('继续') && flat.includes('开始写代码'), '历史上下文保留');
  assert.strictEqual(primaryCalls, 1, '第一次调用访问了主接口一次');

  // 第二次：记忆窗口内 → 完全跳过主接口，直接本地
  for await (const _ of streamLLM(opts([{ role: 'user', content: '继续' }]))) {}
  assert.strictEqual(primaryCalls, 1, '记忆窗口内不再访问主接口（离线不白等超时）');

  console.log('✓ 离线静默降级：直接回答、无提示、无工具、历史清洗 + 5 分钟记忆窗口跳过主接口');
  fake.close(); primary.close();
  process.exitCode = 0; // 优雅退出（强制 process.exit 会触发 Windows libuv 断言）
})().catch((e) => { console.error('✗ 失败:', e.message); process.exit(1); });
