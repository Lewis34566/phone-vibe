'use strict';
// DeepSeek API 流式调用（OpenAI 兼容格式），零依赖
// 把 DeepSeek 的 chunk 翻译成本系统内部的事件格式（与 Agent 循环解耦）
const config = require('./config');
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

// 通用 OpenAI 兼容流式端点（DeepSeek 与本地 ollama 共用同一套解析）
async function* streamEndpoint({ url, auth, model, system, messages, tools, maxTokens, signal, attempts }) {
  const body = {
    model,
    messages: convertMessages(system, messages),
    tools: tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    })),
    max_tokens: maxTokens || 8192,
    temperature: 0.7, // 低温度：工具调用更可靠、代码更稳
    stream: true,
    stream_options: { include_usage: true },
  };

  let lastErr;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(auth ? { authorization: auth } : {}),
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
        throw new Error(`模型接口错误：${msg}`);
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
      if (!(e instanceof Error && e.message.startsWith('模型接口错误'))) {
        lastErr = e;
        if (attempt === 0) await new Promise((r) => setTimeout(r, 900));
      } else {
        throw e;
      }
    }
  }
  lastErr = lastErr || new Error('模型接口请求失败');
  lastErr.isNetwork = true;
  throw lastErr;
}

// 主入口：DeepSeek 优先；断网等网络错误时，如果 .env 配了 LOCAL_LLM_URL
// （手机 Termux 里的 ollama 等 OpenAI 兼容本地模型），自动降级到本地模型跑
// _primaryUrl: 仅供测试替换主接口地址
async function* streamDeepSeek({ apiKey, model, system, messages, tools, maxTokens, signal, _primaryUrl }) {
  try {
    yield* streamEndpoint({ url: _primaryUrl || API_URL, auth: `Bearer ${apiKey}`, model, system, messages, tools, maxTokens, signal, attempts: 2 });
  } catch (e) {
    const localUrl = config.localLlmUrl;
    // 主接口任何错误（断网/欠费/Key 失效等）都静默降级到本地模型：
    // 不带工具、用简洁助手提示词——3B 小模型做不了 Agent 任务循环，
    // 直接回答反而可靠。只有用户主动停止才不降级。
    if (localUrl && !(signal && signal.aborted)) {
      yield* streamEndpoint({
        url: localUrl + '/chat/completions', // LOCAL_LLM_URL 是基地址，补 OpenAI 兼容路径
        auth: null,
        model: config.localLlmModel,
        system: OFFLINE_SYSTEM_PROMPT,
        messages,
        tools: [],
        maxTokens,
        signal,
        attempts: 1,
      });
      return;
    }
    throw e;
  }
}

// 离线降级用的简洁提示词（不提网络/模型/限制，直接回答问题）
const OFFLINE_SYSTEM_PROMPT = '你是 Lewis，一个在用户手机上运行的离线中文助手。请直接、准确、简洁地回答用户的问题，用中文。';

// ---------- 图片理解：用 deepseek-flash 的视觉能力把图片转成文字描述 ----------
// （主模型 v4-pro 不支持图片输入；flash 支持。描述后交给主 Agent 正常处理）
async function describeImage({ apiKey, imageUrl, signal }) {
  const resp = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'deepseek-flash',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '详细描述这张图片的内容：1) 所有可见文字逐字转写（尤其是中文）；2) 物体、人物、场景；3) 如果是界面/文档/图表，说明结构和关键信息；4) 颜色风格。用中文，尽量具体。' },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      }],
      max_tokens: 2000,
      temperature: 0.3,
      stream: false,
    }),
    signal,
  });
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try { const j = await resp.json(); if (j.error && j.error.message) msg = j.error.message; } catch {}
    throw new Error(`图片识别失败：${msg}`);
  }
  const j = await resp.json();
  const text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  if (!text.trim()) throw new Error('图片识别返回空内容');
  return text.trim();
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
form{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px}
form input,form select,form button{font-size:16px;padding:11px;border-radius:12px;border:1px solid #2a2f3e;background:#1a1e2b;color:#e6e8ee}
#cat{grid-column:span 2}
form button{grid-column:span 2;background:linear-gradient(135deg,#6366f1,#8b5cf6);border:none;color:#fff;font-weight:700}
.card{background:#1a1e2b;border-radius:14px;padding:14px;margin-bottom:12px}
.card h2{font-size:14px;color:#9aa3b5;margin-bottom:10px;font-weight:600}
.chart-row{display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:12.5px}
.chart-row .name{width:34px;flex:none;color:#c3c9d8}
.chart-row .bar{flex:1;height:14px;background:#232a3b;border-radius:7px;overflow:hidden}
.chart-row .bar i{display:block;height:100%;border-radius:7px;background:linear-gradient(90deg,#6366f1,#8b5cf6)}
.chart-row .val{width:52px;flex:none;text-align:right;color:#9aa3b5}
.item{display:flex;justify-content:space-between;align-items:center;padding:11px 2px;border-bottom:1px solid #232a3b}
.item:last-child{border-bottom:none}
.item .tag{display:inline-block;font-size:11px;background:#232a3b;color:#9fb0ff;border-radius:6px;padding:2px 8px;margin-right:6px}
.item .time{font-size:11px;color:#6b7280}
.item .money{font-weight:700}
.money.in{color:#4ade80}
.money.out{color:#f87171}
.empty{text-align:center;color:#6b7280;padding:26px 0}
</style>
</head>
<body>
<h1>💰 记账小工具</h1>
<div class="balance"><div>本月结余</div><div class="num" id="total">¥0</div>
<div class="sub"><span>收入 <b id="inc" style="color:#4ade80">¥0</b></span><span>支出 <b id="exp" style="color:#f87171">¥0</b></span></div></div>
<form id="f">
<input id="amount" type="number" step="0.01" min="0.01" placeholder="金额" required>
<select id="type"><option value="out">💸 支出</option><option value="in">💰 收入</option></select>
<select id="cat">
<option>餐饮</option><option>交通</option><option>购物</option><option>娱乐</option><option>其他</option>
</select>
<button type="submit">记一笔</button>
</form>
<div class="card" id="chartCard" style="display:none"><h2>📊 本月支出分布</h2><div id="chart"></div></div>
<div class="card"><h2>📒 明细</h2><div id="list"></div></div>
<script>
var KEY='jizhang_items_v2';
var CATS=['餐饮','交通','购物','娱乐','其他'];
function loadData(){return JSON.parse(localStorage.getItem(KEY)||'[]');}
function saveData(){localStorage.setItem(KEY,JSON.stringify(items));}
var items=loadData();
function fmt(n){return '¥'+(n||0).toFixed(2);}
function render(){
  var inc=0,exp=0,byCat={};
  var list=document.getElementById('list');
  list.innerHTML='';
  items.slice().reverse().forEach(function(it){
    if(it.type==='in')inc+=+it.amount;else{exp+=+it.amount;byCat[it.cat]=(byCat[it.cat]||0)+(+it.amount);}
    var div=document.createElement('div');div.className='item';
    var d=new Date(it.time).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
    var amt=(+it.amount).toFixed(2);
    div.innerHTML='<div><span class="tag">'+it.cat+'</span><span class="time">'+d+'</span></div>'+
      '<div class="money '+it.type+'">'+(it.type==='in'?'+':'-')+amt+'</div>';
    list.appendChild(div);
  });
  if(!items.length)list.innerHTML='<div class="empty">还没有记录，先记一笔吧</div>';
  document.getElementById('total').textContent=fmt(inc-exp);
  document.getElementById('inc').textContent=fmt(inc);
  document.getElementById('exp').textContent=fmt(exp);
  var chart=document.getElementById('chart');
  chart.innerHTML='';
  var rows=CATS.map(function(c){return {name:c,val:byCat[c]||0};})
    .filter(function(r){return r.val>0;})
    .sort(function(a,b){return b.val-a.val;});
  var max=rows.length?rows[0].val:1;
  rows.slice(0,5).forEach(function(r){
    var row=document.createElement('div');row.className='chart-row';
    row.innerHTML='<span class="name">'+r.name+'</span><span class="bar"><i style="width:'+Math.round(r.val/max*100)+'%"></i></span><span class="val">'+r.val.toFixed(0)+'</span>';
    chart.appendChild(row);
  });
  document.getElementById('chartCard').style.display=rows.length?'':'none';
  saveData();
}
document.getElementById('f').addEventListener('submit',function(e){
  e.preventDefault();
  items.push({type:document.getElementById('type').value,cat:document.getElementById('cat').value,amount:+document.getElementById('amount').value,time:Date.now()});
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
        { kind: 'text', text: '好的，我是 Lewis。**方案：**\n1. 单页应用 index.html（HTML/CSS/JS 全内联，零依赖）\n2. 数据存 localStorage：分类、金额、时间\n3. 功能：记一笔、月度结余、分类统计条形图\n4. 写完自检 → 启动 → 打开预览\n\n（当前是演示模式：填入 DeepSeek API Key 后，真的 AI 会按你的任意需求做软件）' },
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

module.exports = { streamDeepSeek, mockStream, describeImage };
