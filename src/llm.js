'use strict';
// DeepSeek API 流式调用（OpenAI 兼容格式），零依赖
// 把 DeepSeek 的 chunk 翻译成本系统内部的事件格式（与 Agent 循环解耦）
const API_URL = 'https://api.deepseek.com/chat/completions';

// ---------- 消息格式转换：内部格式 -> DeepSeek(OpenAI) 格式 ----------
function convertMessages(system, messages) {
  const msgs = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') {
      if (typeof m.content === 'string') {
        msgs.push({ role: 'user', content: m.content });
      } else {
        // tool_result 块：每个结果单独一条 tool 消息
        for (const b of m.content || []) {
          if (b.type === 'tool_result') {
            msgs.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.content });
          }
        }
      }
    } else if (m.role === 'assistant') {
      const blocks = m.content || [];
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n') || null;
      const toolCalls = blocks
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
        }));
      msgs.push({ role: 'assistant', content: text, tool_calls: toolCalls.length ? toolCalls : undefined });
    }
  }
  return msgs;
}

async function* streamDeepSeek({ apiKey, model, system, messages, tools, maxTokens, signal }) {
  const body = {
    model,
    messages: convertMessages(system, messages),
    tools: tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    })),
    max_tokens: maxTokens || 8192,
    stream: true,
    stream_options: { include_usage: true },
  };

  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
      if (!resp.ok) {
        let msg = `HTTP ${resp.status}`;
        try {
          const j = await resp.json();
          if (j.error && j.error.message) msg = j.error.message;
        } catch {}
        throw new Error(`DeepSeek API 错误：${msg}`);
      }
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let textStarted = false;
      let nextIdx = 1; // 文本块固定 index 0，工具块从 1 开始
      const toolIdx = new Map(); // DeepSeek 工具 index -> 内部块 index
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          let chunk;
          try { chunk = JSON.parse(data); } catch { continue; }

          // 最后一个 chunk 带 usage（需要 stream_options.include_usage）
          if (chunk.usage) {
            if (chunk.usage.prompt_tokens) {
              yield { type: 'message_start', message: { usage: { input_tokens: chunk.usage.prompt_tokens } } };
            }
            yield {
              type: 'message_delta',
              delta: {},
              usage: { output_tokens: chunk.usage.completion_tokens || 0 },
            };
          }

          const c = chunk.choices && chunk.choices[0];
          if (!c) continue;
          const d = c.delta || {};
          if (typeof d.content === 'string' && d.content.length > 0) {
            if (!textStarted) {
              textStarted = true;
              yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
            }
            yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: d.content } };
          }
          if (Array.isArray(d.tool_calls)) {
            for (const tc of d.tool_calls) {
              if (!toolIdx.has(tc.index)) {
                const myIdx = nextIdx++;
                toolIdx.set(tc.index, myIdx);
                const fn = tc.function || {};
                yield {
                  type: 'content_block_start',
                  index: myIdx,
                  content_block: { type: 'tool_use', id: tc.id || `call_${tc.index}`, name: fn.name || '', input: {} },
                };
              }
              const myIdx = toolIdx.get(tc.index);
              const args = tc.function && tc.function.arguments;
              if (args) {
                yield { type: 'content_block_delta', index: myIdx, delta: { type: 'input_json_delta', partial_json: args } };
              }
            }
          }
          if (c.finish_reason) {
            const stop = c.finish_reason === 'tool_calls' ? 'tool_use'
              : c.finish_reason === 'length' ? 'max_tokens'
              : 'end_turn';
            yield { type: 'message_delta', delta: { stop_reason: stop } };
            yield { type: 'message_stop' };
          }
        }
      }
      return;
    } catch (e) {
      if (signal && signal.aborted) throw e;
      // 网络类错误重试一次；API 业务错误（4xx 等）不重试
      if (!(e instanceof Error && e.message.startsWith('DeepSeek API 错误'))) {
        lastErr = e;
        if (attempt === 0) await new Promise((r) => setTimeout(r, 900));
      } else {
        throw e;
      }
    }
  }
  throw lastErr || new Error('DeepSeek API 请求失败');
}

// ================= 演示模式（API Key=mock）=================
// 没有 Key 也能体验完整流程：模拟 Lewis 写一个记账小工具
const DEMO_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>记账小工具</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#0f1117;color:#e6e8ee;min-height:100vh;padding:16px;max-width:520px;margin:0 auto}
h1{font-size:22px;margin:8px 0 16px;text-align:center}
.balance{background:linear-gradient(135deg,#6366f1,#8b5cf6);border-radius:16px;padding:20px;text-align:center;margin-bottom:16px}
.balance .num{font-size:34px;font-weight:700;margin-top:6px}
.balance .sub{font-size:12px;opacity:.85;margin-top:8px;display:flex;justify-content:space-around}
form{display:grid;grid-template-columns:1fr 90px 90px;gap:8px;margin-bottom:16px}
input,select,button{font-size:16px;padding:10px;border-radius:10px;border:1px solid #2a2f3e;background:#1a1e2b;color:#e6e8ee}
button{background:#6366f1;border:none;color:#fff;font-weight:600}
.item{display:flex;justify-content:space-between;align-items:center;padding:12px;border-radius:10px;background:#1a1e2b;margin-bottom:8px}
.item .tag{font-size:12px;color:#9aa3b5}
.item .money{font-weight:700}
.money.in{color:#4ade80}
.money.out{color:#f87171}
.empty{text-align:center;color:#6b7280;padding:30px 0}
</style>
</head>
<body>
<h1>💰 记账小工具</h1>
<div class="balance"><div>本月结余</div><div class="num" id="total">¥0</div>
<div class="sub"><span>收入 <b id="inc" style="color:#4ade80">¥0</b></span><span>支出 <b id="exp" style="color:#f87171">¥0</b></span></div></div>
<form id="f">
<input id="amount" type="number" step="0.01" min="0.01" placeholder="金额" required>
<select id="type"><option value="out">支出</option><option value="in">收入</option></select>
<button type="submit">记一笔</button>
</form>
<div id="list"></div>
<script>
var KEY='jizhang_items';
var items=JSON.parse(localStorage.getItem(KEY)||'[]');
function fmt(n){return '¥'+(n||0).toFixed(2);}
function render(){
  var inc=0,exp=0;
  var list=document.getElementById('list');
  list.innerHTML='';
  items.slice().reverse().forEach(function(it){
    if(it.type==='in')inc+=+it.amount;else exp+=+it.amount;
    var div=document.createElement('div');div.className='item';
    var d=new Date(it.time).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
    var amt=(+it.amount).toFixed(2);
    div.innerHTML='<div><div>'+it.note+'</div><div class="tag">'+d+'</div></div>'+
      '<div class="money '+it.type+'">'+(it.type==='in'?'+':'-')+amt+'</div>';
    list.appendChild(div);
  });
  if(!items.length)list.innerHTML='<div class="empty">还没有记录，先记一笔吧</div>';
  document.getElementById('total').textContent=fmt(inc-exp);
  document.getElementById('inc').textContent=fmt(inc);
  document.getElementById('exp').textContent=fmt(exp);
  localStorage.setItem(KEY,JSON.stringify(items));
}
document.getElementById('f').addEventListener('submit',function(e){
  e.preventDefault();
  var note=prompt('备注（如：午饭 / 工资）：')||'日常';
  items.push({type:document.getElementById('type').value,amount:+document.getElementById('amount').value,note:note,time:Date.now()});
  document.getElementById('amount').value='';
  render();
});
render();
</script>
</body>
</html>`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let mockCounter = 0;

async function* mockStream(messages) {
  // 找到最后一个 tool_use 及是否已有 tool_result 回复
  let lastToolUse = null;
  for (const m of messages) {
    if (m.role === 'assistant') {
      for (const b of m.content || []) if (b.type === 'tool_use') lastToolUse = b;
    }
  }
  const answered = lastToolUse && messages.some(
    (m) => m.role === 'user' && Array.isArray(m.content) &&
      m.content.some((b) => b.type === 'tool_result' && b.tool_use_id === lastToolUse.id)
  );

  let blocks;
  if (!answered) {
    const lastMsg = messages[messages.length - 1] || {};
    const userText = typeof lastMsg.content === 'string' ? lastMsg.content : '';
    if (/approve|拒绝|删除/.test(userText)) {
      blocks = [
        { kind: 'text', text: '我要执行一个涉及删除的命令（演示审批流程）：' },
        { kind: 'tool', name: 'run_command', input: { command: 'rm -rf test_target', timeout_seconds: 10 } },
      ];
    } else {
      blocks = [
        { kind: 'text', text: '好的，我是 Lewis，我来做一个「记账小工具」。\n\n（当前是演示模式：把 API Key 填入顶部横幅，就能让真的 AI 帮你写代码了）\n\n1. 写 index.html（纯静态 + localStorage 存数据）\n2. 启动项目并在浏览器打开' },
        { kind: 'tool', name: 'write_file', input: { path: 'index.html', content: DEMO_HTML } },
      ];
    }
  } else if (lastToolUse.name === 'write_file') {
    blocks = [
      { kind: 'text', text: '代码写好了，启动项目：' },
      { kind: 'tool', name: 'start_project', input: { type: 'static' } },
    ];
  } else if (lastToolUse.name === 'run_command') {
    blocks = [{ kind: 'text', text: '完成！' }];
  } else {
    blocks = [{ kind: 'text', text: '✅ Lewis 已完成！点击「项目」页的 🌐 打开，或直接访问上面的预览链接。\n\n（当前是演示模式：配置 API Key 后，真的 AI 会按你的需求写任意应用）' }];
  }

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.kind === 'text') {
      yield { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } };
      for (let p = 0; p < b.text.length; p += 12) {
        yield { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: b.text.slice(p, p + 12) } };
        await sleep(18);
      }
      yield { type: 'content_block_stop', index: i };
    } else {
      mockCounter++;
      yield { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: `toolu_mock_${mockCounter}_${i}`, name: b.name, input: {} } };
      const s = JSON.stringify(b.input);
      for (let p = 0; p < s.length; p += 40) {
        yield { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: s.slice(p, p + 40) } };
        await sleep(6);
      }
      yield { type: 'content_block_stop', index: i };
    }
  }
  const stop = blocks.length && blocks[blocks.length - 1].kind === 'tool' ? 'tool_use' : 'end_turn';
  yield { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 100 } };
  yield { type: 'message_stop' };
}

module.exports = { streamDeepSeek, mockStream };
