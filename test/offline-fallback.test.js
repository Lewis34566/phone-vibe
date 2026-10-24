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
  const gen = streamLLM({
    apiKey: 'x', model: 'm', system: '', messages: [{ role: 'user', content: 'hi' }],
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
  console.log('✓ 离线静默降级：直接回答、无提示文字、不带工具');
  fake.close();
  process.exit(0);
});
