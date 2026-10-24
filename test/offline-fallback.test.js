// 集成测试：主接口断网 → 静默降级到本地模型（无提示文字、不带工具、直接回答）
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

fake.listen(0, '127.0.0.1', async () => {
  const port = fake.address().port;
  process.env.LOCAL_LLM_URL = `http://127.0.0.1:${port}/v1`;
  process.env.LOCAL_LLM_MODEL = 'test-model';
  const { streamLLM } = require('../src/llm.js'); // 在设置 env 之后才加载 config

  const events = [];
  // 历史里混有工具调用交换（在线轮次留下的），离线时应被清洗成纯文本
  const messyHistory = [
    { role: 'user', content: '帮我做个计算器' },
    { role: 'assistant', content: [{ type: 'text', text: '开始写代码。' }, { type: 'tool_use', id: 't1', name: 'write_file', input: { path: 'a.html', content: 'x' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"ok":true,"summary":"已写入"}' }] },
    { role: 'user', content: '继续' },
  ];
  const gen = streamLLM({
    apiKey: 'x', model: 'm', system: '', messages: messyHistory,
    tools: [{ name: 'write_file', description: 'x', input_schema: { type: 'object' } }],
    signal: new AbortController().signal,
    _primaryUrl: 'http://127.0.0.1:9/chat/completions', // 端口 9 必然拒绝连接 → 模拟断网
  });
  for await (const evt of gen) events.push(evt);

  const text = events.filter((e) => e.type === 'content_block_delta').map((e) => e.delta.text).join('');
  assert.ok(text.includes('本地模型直接回答'), '本地模型内容透传');
  assert.ok(!text.includes('切换'), '静默切换：不输出切换提示文字');
  assert.ok(!text.includes('出错'), '静默切换：不输出错误文字');
  assert.strictEqual(lastBody.tools.length, 0, '降级请求不带工具');
  assert.ok(/离线/.test(lastBody.messages[0].content), '降级使用离线简洁提示词');
  // 上下文对应：历史清洗成纯文本，工具调用消失、操作结果变成注释
  const flat = JSON.stringify(lastBody.messages);
  assert.ok(!flat.includes('tool_calls') && !flat.includes('tool_use'), '历史里的工具调用被清洗');
  assert.ok(flat.includes('[操作结果]'), '工具结果压缩为纯文本注释');
  assert.ok(flat.includes('继续') && flat.includes('开始写代码'), '历史上下文保留');
  console.log('✓ 离线静默降级：直接回答、无提示、无工具、历史清洗为纯文本上下文');
  fake.close();
  process.exit(0);
});
