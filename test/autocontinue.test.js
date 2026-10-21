// 单测：输出被截断（max_tokens）时自动继续，不用用户说「继续」
'use strict';
const assert = require('assert');
const { runAgent } = require('../src/agent');

// 伪造 LLM 流：第一次返回「文本 + 一个坏掉的工具调用」并以 max_tokens 收尾（模拟截断）；
// 第二次正常 end_turn。断言：自动补了一轮、坏工具没被执行、最终 done 无 error。
let calls = 0;
const fakeStream = async function* (messages) {
  calls++;
  if (calls === 1) {
    yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '开始写：' } };
    yield { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'bad1', name: 'write_file', input: {} } };
    yield { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"index.html","content":"<h' } };
    yield { type: 'message_delta', delta: { stop_reason: 'max_tokens' } };
    yield { type: 'message_stop' };
    return;
  }
  yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
  yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '完成！' } };
  yield { type: 'message_delta', delta: { stop_reason: 'end_turn' } };
  yield { type: 'message_stop' };
};

(async () => {
  const events = [];
  let writeFileCalls = 0;
  const emit = (evt) => events.push(evt);
  const approve = async () => true;
  const controller = new AbortController();

  // 拦截 tools.js 的 executeTool？runAgent 在 agent.js 内直接 require 了 executeTool。
  // 这里用 run_command 代替：fake 第二轮流里不用工具，所以只需保证第一轮的坏工具没被执行。
  const r = await runAgent({
    session: { messages: [], events: [] },
    project: '测试',
    message: '做一个贪吃蛇',
    apiKey: 'mock',
    model: 'x',
    controller,
    emit,
    approve,
    _streamFn: fakeStream,
  });

  const types = events.map((e) => e.type);
  assert.strictEqual(calls, 2, '模型被调用了两轮');
  assert.ok(types.includes('done'), '有 done 事件');
  assert.ok(!types.includes('error'), '没有 error 事件');
  assert.ok(!events.some((e) => e.type === 'tool_call' && e.id === 'bad1'), '被截断的坏工具没有被执行');
  assert.ok(events.some((e) => e.type === 'text' && /自动继续/.test(e.delta || '')), '有自动继续提示');
  console.log('✓ 自动继续：两轮完成，坏工具被丢弃，无 error');
  process.exit(0);
})().catch((e) => { console.error('✗ 失败:', e.message); process.exit(1); });
