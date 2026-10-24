// 集成测试：主接口断网 → 自动降级到本地模型（用假本地 OpenAI 兼容服务器）
'use strict';
const http = require('http');
const assert = require('assert');

// 假本地模型：返回一段 SSE 流
const fake = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write('data: {"choices":[{"delta":{"content":"本地模型回复"}}]}\n\n');
  res.end('data: [DONE]\n\n');
});

fake.listen(0, '127.0.0.1', async () => {
  const port = fake.address().port;
  process.env.LOCAL_LLM_URL = `http://127.0.0.1:${port}/v1`;
  process.env.LOCAL_LLM_MODEL = 'test-model';
  const { streamDeepSeek } = require('../src/llm.js'); // 在设置 env 之后才加载 config

  const events = [];
  const gen = streamDeepSeek({
    apiKey: 'x', model: 'm', system: '', messages: [{ role: 'user', content: 'hi' }],
    tools: [], signal: new AbortController().signal,
    _primaryUrl: 'http://127.0.0.1:9/chat/completions', // 端口 9 必然拒绝连接 → 模拟断网
  });
  for await (const evt of gen) events.push(evt);

  const text = events.filter((e) => e.type === 'content_block_delta').map((e) => e.delta.text).join('');
  assert.ok(text.includes('切换到手机本地模型'), '有降级提示');
  assert.ok(text.includes('本地模型回复'), '本地模型内容透传');
  console.log('✓ 离线降级：主接口断 → 提示切换 → 本地模型正常出字');
  fake.close();
  process.exit(0);
});
