// 单测：连续 5 轮工具全失败 → 熔断停住，不烧完 60 轮
'use strict';
const assert = require('assert');
const { runAgent } = require('../src/agent');

let calls = 0;
const fakeStream = async function* () {
  calls++;
  yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't' + calls, name: 'nonexistent_tool', input: {} } };
  yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } };
  yield { type: 'message_delta', delta: { stop_reason: 'tool_use' } };
  yield { type: 'message_stop' };
};

(async () => {
  const events = [];
  const emit = (evt) => events.push(evt);
  await runAgent({
    session: { messages: [], events: [] },
    project: '测试',
    message: 'x',
    apiKey: 'mock',
    model: 'x',
    controller: new AbortController(),
    emit,
    approve: async () => true,
    _streamFn: fakeStream,
  });
  assert.ok(calls <= 6, `熔断及时（调用 ${calls} 轮 ≤ 6）`);
  const err = events.find((e) => e.type === 'error');
  assert.ok(err && /连续.*失败/.test(err.message), '有熔断错误信息');
  console.log(`✓ 熔断生效：${calls} 轮后停住，报错：${err.message.slice(0, 30)}…`);
  process.exit(0);
})().catch((e) => { console.error('✗ 失败:', e.message); process.exit(1); });
